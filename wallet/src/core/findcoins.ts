/**
 * Walking the chain until there is enough to spend.
 *
 * `scan()` deliberately hands back after a bounded run of blocks, because a
 * sync from a wallet's birth is tens of thousands of requests and an app has
 * to stay answerable while it happens. That is right for a screen and wrong
 * for a script, which has nothing to stay answerable to and one question:
 * *have I got a coin I can spend yet?*
 *
 * This is the loop between the two. It calls `scan` until the answer is yes,
 * the chain runs out, or a ceiling is reached, and turns what it found into
 * outputs the spend path will take.
 *
 * ## Why it stops early
 *
 * A wallet with one funded output does not need to be walked to the tip to
 * spend it. Scanning stops as soon as the spendable total covers `enough`,
 * which on a stagenet wallet made an hour ago is one block's work instead of
 * however many blocks have happened since. The cost of stopping early is that
 * the answer is "some of what you own" rather than "all of it", which is
 * exactly what a spend needs and not what a balance needs. `totalReceived` is
 * for balances; this is for spending.
 *
 * ## Why the ceiling exists
 *
 * `from` is a birth height somebody typed. Typing it wrong by a few million
 * blocks is easy and the failure without a ceiling is a script that appears to
 * hang forever, which reads as a bug in the wallet rather than a typo. With
 * one it stops and says how far it got, which is the sentence that tells
 * somebody their birth height is wrong.
 */

import type { Transport } from '../net/http';
import { info } from '../net/monerod';
import {
  scan,
  topBlock,
  toSpendable,
  type MoneroAccount,
  type Received,
  type ScanState,
} from './moneroscan';
import type { SpendableOutput } from './monerospend';

/** Everything already spent or in flight is not available to spend again. */
export interface KeyImageBook {
  isAvailable(oneTimeKey: string): boolean;
}

/** A book that excludes nothing, for a caller that is not keeping one. */
export const NOTHING_SPENT: KeyImageBook = { isAvailable: () => true };

export interface FindOptions {
  /** The first block this account could appear in. */
  from: number;
  /**
   * Stop once this much is spendable. Omitted means walk to the tip, which is
   * what a caller wanting the whole picture asks for.
   */
  enough?: bigint;
  /** Blocks per `scan` call. The default is `scan`'s own. */
  budget?: number;
  /**
   * Most blocks to walk before giving up. Guards a mistyped birth height, so
   * the default is generous rather than tight: a real stagenet sync is small,
   * and a wrong one should end in minutes rather than never.
   */
  maxBlocks?: number;
  /** What has already been spent, so a coin is not offered twice. */
  book?: KeyImageBook;
  /** Called after each bounded run, for something to print. */
  onProgress?: (progress: { height: number; tip: number; spendable: number; total: bigint }) => void;
}

export interface FindOutcome {
  ok: boolean;
  /** One sentence when something went wrong, or when nothing was found. */
  problem: string | null;
  outputs: SpendableOutput[];
  /** What the outputs below add up to. */
  total: bigint;
  /** Where the walk got to, so a caller can say so or resume. */
  state: ScanState;
  /** The tip the walk was measured against: the highest block that exists,
   *  which is one below the chain length the node reports. */
  tip: number;
  /** True when the walk reached the tip rather than stopping early. */
  caughtUp: boolean;
  /** Blocks walked, for the sentence about what it cost. */
  blocks: number;
  requests: number;
}

export const DEFAULT_MAX_BLOCKS = 250_000;

/**
 * Scan until there is enough to spend, or until the chain or the ceiling ends.
 */
export async function findSpendable(
  transport: Transport,
  account: MoneroAccount,
  options: FindOptions,
): Promise<FindOutcome> {
  const book = options.book ?? NOTHING_SPENT;
  const maxBlocks = Math.max(1, options.maxBlocks ?? DEFAULT_MAX_BLOCKS);
  const birth = Math.max(0, Math.floor(options.from));

  const head = await info(transport);
  if (!head.ok) {
    return {
      ok: false, problem: head.problem, outputs: [], total: 0n,
      state: { birth, height: birth }, tip: 0, caughtUp: false, blocks: 0, requests: 0,
    };
  }
  /* The node reports how long the chain is; the walk needs the index of its
   * last block. Without the conversion every run ends by asking for a block
   * that does not exist, and a script whose whole job is to say whether a coin
   * is spendable yet reports a node error at the tip instead. */
  const tip = topBlock(head.value.height);

  const found: Received[] = [];
  let state: ScanState = { birth, height: birth };
  let blocks = 0;
  let requests = 0;

  /* Recomputed from every output found so far rather than accumulated,
   * because `toSpendable` deduplicates by (txid, index) and a block walked
   * twice after a retry would otherwise be counted twice. */
  const takeStock = (): { outputs: SpendableOutput[]; total: bigint } => {
    const outputs = toSpendable(found, book);
    return { outputs, total: outputs.reduce((sum, o) => sum + o.amount, 0n) };
  };

  for (;;) {
    const stock = takeStock();
    if (options.enough !== undefined && stock.total >= options.enough) {
      return { ok: true, problem: null, ...stock, state, tip, caughtUp: false, blocks, requests };
    }
    if (state.height > tip) {
      const problem = stock.outputs.length === 0
        ? `Walked ${blocks} blocks to the tip at ${tip} and found nothing spendable. ` +
          'Either this wallet has never been paid, or its birth height is above the block it was paid in.'
        : options.enough !== undefined && stock.total < options.enough
          ? `Found ${stock.total} piconero spendable, which is short of the ${options.enough} needed.`
          : null;
      return { ok: problem === null, problem, ...stock, state, tip, caughtUp: true, blocks, requests };
    }
    if (blocks >= maxBlocks) {
      return {
        ok: false,
        problem: `Stopped after ${blocks} blocks at height ${state.height}, short of the tip at ${tip}. ` +
          'Raise the ceiling, or check the birth height is not far below where this wallet was made.',
        ...stock, state, tip, caughtUp: false, blocks, requests,
      };
    }

    /* Spelled out rather than passed through, because `exactOptionalPropertyTypes`
     * distinguishes an absent option from one explicitly set to undefined, and
     * `scan` wants the former when nobody chose a budget. */
    const outcome = await scan(transport, account, state, tip,
      options.budget === undefined ? {} : { budget: options.budget });
    blocks += outcome.blocks;
    requests += outcome.requests;
    /* A failed run leaves `state.height` pointing at the block it died in, so
     * resuming is the same call again. Returning here rather than retrying is
     * deliberate: a script should say which request failed, not paper over a
     * node that is refusing. */
    if (!outcome.ok) {
      const stopped = takeStock();
      return {
        ok: false, problem: outcome.problem, ...stopped,
        state: outcome.state, tip, caughtUp: false, blocks, requests,
      };
    }
    found.push(...outcome.received);
    /* Taken as `scan` left it, never clamped to the tip. A scan position is the
     * next block to walk, so a finished walk sits one past the top block, and
     * pulling it back to the tip would make the loop above rescan that block on
     * every turn without ever satisfying its exit. */
    state = outcome.state;

    if (options.onProgress) {
      const now = takeStock();
      options.onProgress({ height: state.height, tip, spendable: now.outputs.length, total: now.total });
    }
  }
}
