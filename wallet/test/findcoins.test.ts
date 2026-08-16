/**
 * Walking until there is enough to spend.
 *
 * `scan()` hands back after a bounded run because an app has to stay
 * answerable; `findSpendable` is the loop that keeps calling it until the
 * question a script asks has an answer. What is worth testing is the loop's
 * decisions rather than the scanning, which `moneroscan.test.ts` already
 * covers against a synthetic sender: when it stops early, when it gives up,
 * what it says when it finds nothing, and whether a node that falls over
 * mid-walk produces a sentence or a hang.
 *
 * The chain below is built the way a sender builds one, for the same reason
 * that file does it: an output the scanner has to genuinely derive is an
 * output that proves the loop found something, rather than one the fixture
 * handed it.
 */

import { describe, expect, it } from 'vitest';
import {
  amountMask,
  commit,
  commitmentMask,
  derivationToScalar,
  derivePublicKey,
  generateKeyDerivation,
} from '@vault/keys/monerocrypto';
import { fromHex, publicFromSecret, reduceScalar, toHex, walletFromSeed } from '@vault/keys/monero';
import type { Reply, Request, Transport } from '../src/net/http';
import { openAccount } from '../src/core/moneroscan';
import { findSpendable, DEFAULT_MAX_BLOCKS, NOTHING_SPENT } from '../src/core/findcoins';

const SEED = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const recipient = walletFromSeed(SEED);
const account = (() => {
  const opened = openAccount(recipient.address, toHex(recipient.viewSecret));
  if (!opened.ok) throw new Error(opened.problem);
  return opened.account;
})();

/** One transaction paying this wallet, as monerod would report it. */
function payment(amount: bigint, tag: number): { hash: string; json: string } {
  const secret = reduceScalar(new Uint8Array(32).map((_, i) => (i * 3 + tag) & 0xff));
  const txPublic = publicFromSecret(secret);
  const derivation = generateKeyDerivation(fromHex(recipient.viewPublic), secret);
  const oneTime = toHex(derivePublicKey(derivation, 0, fromHex(recipient.spendPublic)));
  const shared = derivationToScalar(derivation, 0);
  const mask = amountMask(shared);
  let masked = '';
  for (let byte = 0; byte < 8; byte++) {
    masked += ((Number((amount >> BigInt(byte * 8)) & 0xffn) ^ mask[byte]!) & 0xff)
      .toString(16).padStart(2, '0');
  }
  return {
    hash: (tag.toString(16).padStart(2, '0')).repeat(32),
    json: JSON.stringify({
      version: 2,
      unlock_time: 0,
      vin: [],
      vout: [{ amount: 0, target: { tagged_key: { key: oneTime, view_tag: '00' } } }],
      extra: [0x01, ...Array.from(txPublic)],
      rct_signatures: {
        type: 6,
        txnFee: 30720000,
        ecdhInfo: [{ amount: masked }],
        outPk: [toHex(commit(amount, commitmentMask(shared)))],
      },
    }),
  };
}

interface Chain {
  blocks: Record<number, { hash: string; json: string }[]>;
  tip: number;
  /** Heights whose `get_block` fails, for the mid-walk failure case. */
  broken?: number[];
  /** Make `get_info` itself fail, for the unreachable-node case. */
  deadNode?: boolean;
}

function fakeNode(chain: Chain): Transport & { blocksAsked: number[] } {
  const blocksAsked: number[] = [];
  const byHash = new Map<string, { hash: string; json: string }>();
  for (const list of Object.values(chain.blocks)) for (const tx of list) byHash.set(tx.hash, tx);

  return {
    base: 'https://node.example',
    blocksAsked,
    async send(request: Request): Promise<Reply> {
      const body = (request.body ?? {}) as Record<string, unknown>;

      if (request.path === '/json_rpc' && body['method'] === 'get_info') {
        if (chain.deadNode) return { ok: false, status: 0, problem: 'the node did not answer' };
        return {
          ok: true, status: 200,
          text: JSON.stringify({ id: '0', jsonrpc: '2.0', result: {
            height: chain.tip, target_height: 0, synchronized: true,
            mainnet: true, nettype: 'mainnet', status: 'OK' } }),
        };
      }

      if (request.path === '/json_rpc' && body['method'] === 'get_block') {
        const height = Number((body['params'] as { height?: number }).height);
        blocksAsked.push(height);
        if (chain.broken?.includes(height)) {
          return { ok: false, status: 500, problem: 'the node fell over' };
        }
        return {
          ok: true, status: 200,
          text: JSON.stringify({ id: '0', jsonrpc: '2.0', result: {
            block_header: { hash: 'c'.repeat(64), height, timestamp: 1_700_000_000,
              miner_tx_hash: 'd'.repeat(64) },
            tx_hashes: (chain.blocks[height] ?? []).map((tx) => tx.hash),
            status: 'OK' } }),
        };
      }

      if (request.path === '/get_transactions') {
        const wanted = (body['txs_hashes'] ?? []) as string[];
        return {
          ok: true, status: 200,
          text: JSON.stringify({ status: 'OK', txs: wanted.flatMap((hash) => {
            const tx = byHash.get(hash);
            if (!tx) return [];
            return [{ tx_hash: hash, as_json: tx.json, output_indices: [2_000_000] }];
          }) }),
        };
      }

      return { ok: false, status: 404, problem: `nothing here for ${request.path}` };
    },
  };
}

describe('finding coins to spend', () => {
  it('finds a payment and reports what it is worth', async () => {
    const chain: Chain = { tip: 40, blocks: { 12: [payment(2_000_000_000_000n, 0x11)] } };
    const found = await findSpendable(fakeNode(chain), account, { from: 0, budget: 100 });

    expect(found.ok).toBe(true);
    expect(found.problem).toBeNull();
    expect(found.outputs).toHaveLength(1);
    expect(found.total).toBe(2_000_000_000_000n);
    /* Everything the spend path needs, and nothing guessed: the global index
     * comes from the node, the commitment off the chain. */
    expect(found.outputs[0]!.globalIndex).toBe(2_000_000);
    expect(found.outputs[0]!.commitment).toHaveLength(64);
    expect(found.outputs[0]!.indexInTx).toBe(0);
    expect(found.caughtUp).toBe(true);
  });

  it('stops as soon as there is enough, without walking to the tip', async () => {
    /* The reason this exists. A wallet with one funded coin does not need the
     * whole chain walked to spend it, and on a real node the difference is
     * minutes against seconds. */
    const chain: Chain = {
      tip: 5_000,
      blocks: { 10: [payment(3_000_000_000_000n, 0x21)], 4_000: [payment(9n, 0x22)] },
    };
    const node = fakeNode(chain);
    const found = await findSpendable(node, account, {
      from: 0, budget: 50, enough: 1_000_000_000_000n,
    });

    expect(found.ok).toBe(true);
    expect(found.total).toBeGreaterThanOrEqual(1_000_000_000_000n);
    expect(found.caughtUp).toBe(false);
    /* It gave up long before the tip, which is the whole point. */
    expect(Math.max(...node.blocksAsked)).toBeLessThan(200);
  });

  it('walks to the tip when nothing says how much is enough', async () => {
    const chain: Chain = {
      tip: 300,
      blocks: { 10: [payment(1_000n, 0x31)], 250: [payment(2_000n, 0x32)] },
    };
    const found = await findSpendable(fakeNode(chain), account, { from: 0, budget: 100 });

    expect(found.caughtUp).toBe(true);
    expect(found.outputs).toHaveLength(2);
    expect(found.total).toBe(3_000n);
  });

  it('says so when the wallet has never been paid', async () => {
    /* The sentence matters more than the boolean. An empty result and a wrong
     * birth height look identical, so it has to name both possibilities. */
    const found = await findSpendable(fakeNode({ tip: 60, blocks: {} }), account, { from: 0 });

    expect(found.ok).toBe(false);
    expect(found.outputs).toEqual([]);
    expect(found.problem).toMatch(/found nothing spendable/);
    expect(found.problem).toMatch(/birth height/);
  });

  it('says how far short it fell rather than returning a partial spend', async () => {
    const chain: Chain = { tip: 50, blocks: { 5: [payment(100n, 0x41)] } };
    const found = await findSpendable(fakeNode(chain), account, { from: 0, enough: 5_000n });

    expect(found.ok).toBe(false);
    expect(found.problem).toMatch(/short of the 5000 needed/);
    /* The outputs are still handed back, because "not enough" is a thing a
     * caller may want to print rather than a reason to hide what was found. */
    expect(found.outputs).toHaveLength(1);
  });

  it('gives up at the ceiling instead of running forever', async () => {
    /* A birth height typed a few million blocks too low is easy, and without
     * this the failure is a script that looks hung. */
    const found = await findSpendable(fakeNode({ tip: 10_000, blocks: {} }), account, {
      from: 0, budget: 50, maxBlocks: 200,
    });

    expect(found.ok).toBe(false);
    expect(found.problem).toMatch(/Stopped after \d+ blocks/);
    expect(found.problem).toMatch(/birth height/);
    expect(found.blocks).toBeLessThanOrEqual(250);
    expect(found.caughtUp).toBe(false);
  });

  it('reports a node that fell over mid-walk, and where it got to', async () => {
    const chain: Chain = {
      tip: 400, broken: [120], blocks: { 10: [payment(7_000n, 0x51)] },
    };
    const found = await findSpendable(fakeNode(chain), account, { from: 0, budget: 50 });

    expect(found.ok).toBe(false);
    expect(found.problem).toMatch(/fell over/);
    /* Resumable: the height points at the block that failed, and what was
     * found before it is not thrown away. */
    expect(found.state.height).toBe(120);
    expect(found.outputs).toHaveLength(1);
  });

  it('reports a node it could not reach at all', async () => {
    const found = await findSpendable(fakeNode({ tip: 1, blocks: {}, deadNode: true }), account, {
      from: 0,
    });
    expect(found.ok).toBe(false);
    expect(found.problem).toMatch(/did not answer/);
    expect(found.tip).toBe(0);
  });

  it('leaves out what the book says is already spent', async () => {
    const chain: Chain = {
      tip: 40, blocks: { 5: [payment(1_000n, 0x61)], 6: [payment(2_000n, 0x62)] },
    };
    const all = await findSpendable(fakeNode(chain), account, { from: 0 });
    expect(all.outputs).toHaveLength(2);

    const gone = all.outputs[0]!.key;
    const found = await findSpendable(fakeNode(chain), account, {
      from: 0,
      book: { isAvailable: (key) => key !== gone },
    });
    expect(found.outputs).toHaveLength(1);
    expect(found.outputs.map((o) => o.key)).not.toContain(gone);
  });

  it('counts a block walked twice only once', async () => {
    /* `scan` redoes a block it failed in the middle of, so the same output can
     * arrive twice. Totalling by accumulation rather than from the deduplicated
     * set would double it, and a doubled balance is a spend that gets built and
     * then refused. */
    const chain: Chain = { tip: 400, broken: [50], blocks: { 10: [payment(4_000n, 0x71)] } };
    const first = await findSpendable(fakeNode(chain), account, { from: 0, budget: 25 });
    expect(first.ok).toBe(false);

    const healed: Chain = { ...chain, broken: [] };
    const second = await findSpendable(fakeNode(healed), account, { from: 0, budget: 25 });
    expect(second.outputs).toHaveLength(1);
    expect(second.total).toBe(4_000n);
  });

  it('reports progress as it goes', async () => {
    const chain: Chain = { tip: 250, blocks: { 10: [payment(500n, 0x81)] } };
    const seen: number[] = [];
    await findSpendable(fakeNode(chain), account, {
      from: 0, budget: 50, onProgress: (p) => seen.push(p.height),
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(250);
  });

  it('has a ceiling that is generous rather than tight', () => {
    /* It exists to end a mistyped birth height, not to bound a real sync. A
     * stagenet chain is a few million blocks; this is comfortably more than a
     * wallet made this year needs and comfortably less than forever. */
    expect(DEFAULT_MAX_BLOCKS).toBeGreaterThan(100_000);
    expect(NOTHING_SPENT.isAvailable('anything')).toBe(true);
  });
});
