/**
 * Walking the Monero chain with a view key, and what that can honestly buy.
 *
 * ## The shape of the problem
 *
 * Bitcoin puts addresses on the chain, so a light client asks a node "has
 * anyone paid this" and the node looks it up. Monero puts a one-time key on
 * every output that belongs to nobody in particular until you do arithmetic
 * with your view key. There is no index to ask. Finding your outputs means
 * taking every output in every block since your wallet was born and testing
 * each one, here, on the phone.
 *
 * That is the cost, and it is the feature. The node serves blocks and never
 * learns which outputs in them were yours, which is a real and large privacy
 * difference from the Bitcoin side of this same app, where the node is told
 * every address in the account.
 *
 * ## What this finds, and the large thing it cannot
 *
 * **It finds money coming in.** Every output paid to this account, with its
 * amount, proved against the commitment the chain published.
 *
 * **It cannot see money going out.** This is not a gap to be filled later by
 * more code here; it is what a view key is. Spending an output publishes a key
 * image, and computing the key image of your own output needs the *spend*
 * secret, which by design is not on this device. So a view-only wallet can list
 * everything it ever received and cannot tell which of those outputs it has
 * already spent.
 *
 * Every wallet in this situation solves it the same way: the spending wallet
 * exports its key images and the watching wallet imports them. The vault
 * already recognizes that file, `Monero key image export`, as one of the six
 * wallet2 containers in `keys/monerotx.ts`. Until that round trip is built and
 * tested, the number this module produces is **received**, it is labeled
 * received on every screen that shows it, and it is never called a balance.
 *
 * A wallet that printed a received total under the word BALANCE would be
 * telling somebody who has spent money that they still have it. The whole
 * point of the airgap is that this app is the half that is allowed to be
 * wrong about the network and not about somebody's money.
 *
 * ## Why the amounts are trustworthy even though nothing here has vectors
 *
 * RingCT hides amounts behind a Pedersen commitment. The receiver recovers the
 * amount by decrypting eight bytes with a mask derived from the shared secret,
 * and there is no published test vector for that in Monero's `tests.txt`.
 *
 * It does not need one. A recovered amount and its recomputed blinding factor
 * either rebuild the exact commitment sitting on the chain or they do not, and
 * `commit()` in `keys/monerocrypto.ts` is checked against `rct::H` from
 * Monero's own source. So every amount this module reports has been proved
 * against real chain data at the moment it was read, which is a stronger claim
 * than a fixed vector makes. An amount that fails that check is reported as
 * unknown rather than as a number, because a wrong amount looks exactly like a
 * right one on a screen.
 *
 * ## Why JSON and not `/get_blocks.bin`
 *
 * The fast path speaks epee portable storage, a binary format with no
 * specification outside Monero's source. Writing a decoder for it with no real
 * blobs to check against is exactly the unverified work this repository
 * refuses everywhere else. The JSON path is slower, works on every restricted
 * public node, and can be tested here against recorded answers. When an epee
 * decoder exists and has been checked against a real node, it replaces the two
 * calls in `net/monerod.ts` and nothing in this file changes.
 */

import {
  commit,
  commitmentMask,
  amountMask,
  derivationToScalar,
} from '@vault/keys/monerocrypto';
import { fromHex, toHex, parseAddress, publicFromSecret, canWatch } from '@vault/keys/monero';
import type { Atoms } from './model';
import type { Transport } from '../net/http';
import {
  blockAt,
  keyDerivation,
  ownsWithDerivation,
  transactions,
  type ScannableTx,
} from '../net/monerod';

// ---------------------------------------------------------------------------
// The account being watched

export interface MoneroAccount {
  /** The primary address, which is where the two public keys come from. */
  address: string;
  /** The private view key. Finds outputs; cannot spend them. */
  viewSecret: Uint8Array;
  spendPublic: string;
  viewPublic: string;
}

export type AccountCheck =
  | { ok: true; account: MoneroAccount }
  | { ok: false; problem: string };

/**
 * Build a watching account from what the vault hands over.
 *
 * The last check in here is the one worth having. A view key that does not
 * belong to the address beside it produces a wallet that scans the whole chain
 * correctly and finds nothing, which on screen is indistinguishable from a
 * wallet that has never been paid. Multiplying the secret by G and comparing it
 * to the view key inside the address costs one scalar multiplication and turns
 * that into a sentence at the moment of pairing.
 */
export function openAccount(address: string, viewSecretHex: string): AccountCheck {
  const parsed = parseAddress(address);
  const watchable = canWatch(parsed);
  if (!watchable.ok) return { ok: false, problem: watchable.problem ?? 'That address cannot be watched.' };
  if (parsed.network !== 'mainnet') {
    return { ok: false, problem: 'That is not a mainnet address, and this wallet only follows mainnet.' };
  }
  /* `canWatch` has already established both of these, and the compiler has no
   * way to know that. Re-checking is two comparisons and it means a future
   * change to `canWatch` cannot silently produce an account with no keys. */
  if (!parsed.spendPublic || !parsed.viewPublic) {
    return { ok: false, problem: 'That address does not carry both public keys.' };
  }

  let viewSecret: Uint8Array;
  try {
    viewSecret = fromHex(viewSecretHex);
  } catch {
    return { ok: false, problem: 'That view key is not hexadecimal.' };
  }
  if (viewSecret.length !== 32) return { ok: false, problem: 'A view key is 32 bytes.' };

  let derived: string;
  try {
    derived = toHex(publicFromSecret(viewSecret));
  } catch {
    return { ok: false, problem: 'That view key is not a usable secret.' };
  }
  if (derived !== parsed.viewPublic) {
    return {
      ok: false,
      problem: 'That view key does not belong to that address. A wallet built from the two would scan the whole chain and find nothing.',
    };
  }

  return {
    ok: true,
    account: {
      address,
      viewSecret,
      spendPublic: parsed.spendPublic,
      viewPublic: parsed.viewPublic,
    },
  };
}

// ---------------------------------------------------------------------------
// What a scan produces

/** One output paid to this account. */
export interface Received {
  txid: string;
  height: number;
  /** Position in the transaction, which is part of the derivation. */
  index: number;
  /** The one-time public key on the chain, which is this output's identity. */
  key: string;
  /** Piconero, or null when it could not be established. */
  amount: Atoms | null;
  /** One sentence saying why the amount is unknown, when it is. */
  unknownBecause: string | null;
}

/** Two outputs are the same output when these agree. */
export const outputKey = (found: Received): string => `${found.txid}:${found.index}`;

/** Where a scan has got to, which is the whole of what gets persisted. */
export interface ScanState {
  /** The first block this account could possibly appear in. */
  birth: number;
  /** The next block to scan. Everything below it has been walked. */
  height: number;
}

export interface ScanOutcome {
  ok: boolean;
  /** One sentence, when a request failed. */
  problem: string | null;
  /** Where to resume. Everything below `height` was scanned completely. */
  state: ScanState;
  /** Outputs found, all of them from blocks that finished. */
  received: Received[];
  /** Blocks walked in this pass. */
  blocks: number;
  /** Requests made, so the screen can say what it cost. */
  requests: number;
  /** True when the scan reached the tip and there is nothing left to walk. */
  caughtUp: boolean;
}

export interface ScanOptions {
  /** Most blocks to walk in one call. The rest is the next call's problem. */
  budget?: number;
  /** Whether to scan coinbase outputs. See `SCAN_COINBASE_NOTE`. */
  coinbase?: boolean;
  /** Return true to stop cleanly at the next block boundary. */
  stop?: () => boolean;
  /** Called after each block completes, for a progress bar. */
  onBlock?: (height: number) => void;
}

/**
 * Blocks per call, chosen so the caller keeps control.
 *
 * A sync from a wallet's birth is tens of thousands of requests and it is not
 * going to finish inside one screen's lifetime. Handing back after a bounded
 * run lets the app persist where it got to, show it, and let somebody put the
 * phone down without losing the work.
 */
export const DEFAULT_BUDGET = 200;

/**
 * Transactions per request.
 *
 * A restricted daemon refuses `/get_transactions` for more than a hundred
 * hashes at a time and this is a wallet built for restricted daemons, so a
 * hundred is the number rather than whatever an unrestricted node would allow.
 */
export const MAX_TXS_PER_REQUEST = 100;

/**
 * Why coinbase outputs are off unless somebody asks.
 *
 * Miner transactions are not in a block's `tx_hashes`, so scanning them means
 * a second request for every block, including the great majority that contain
 * nothing else. That doubles a sync that is already the slow part of this app,
 * to catch a case that only applies to somebody pointing a mining pool at this
 * wallet. It is an option rather than a decision, and this is what it costs.
 */
export const SCAN_COINBASE_NOTE =
  'Coinbase outputs are skipped unless coinbase scanning is turned on, because reading them costs one extra request per block.';

/** The thing a view-only wallet cannot do, in the words the screens use. */
export const SPEND_BLINDNESS =
  'A view key finds payments coming in. It cannot tell which of them you have already spent, because that needs the spend key, which lives in the vault. This total is what arrived, not what is left.';

// ---------------------------------------------------------------------------
// The walk

/**
 * Scan a bounded run of blocks, starting where the last one stopped.
 *
 * Everything in `received` comes from a block that was walked to the end, and
 * `state.height` is exactly the next block nobody has looked at. That contract
 * is what makes this resumable without bookkeeping: a failed request in the
 * middle of a block throws away that block's partial findings and leaves the
 * height pointing at it, so the next call redoes it whole.
 */
export async function scan(
  transport: Transport,
  account: MoneroAccount,
  from: ScanState,
  tip: number,
  options: ScanOptions = {},
): Promise<ScanOutcome> {
  const budget = Math.max(1, options.budget ?? DEFAULT_BUDGET);
  const birth = Math.max(0, Math.floor(from.birth));
  let height = Math.max(birth, Math.floor(from.height));

  const received: Received[] = [];
  let blocks = 0;
  let requests = 0;

  const done = (problem: string | null): ScanOutcome => ({
    ok: problem === null,
    problem,
    state: { birth, height },
    received,
    blocks,
    requests,
    /* Caught up means there is nothing left below the tip. A pass that stopped
     * because it ran out of budget is not caught up even though it did not
     * fail, and the screen shows those two states differently. */
    caughtUp: problem === null && height > tip,
  });

  if (tip < height) return done(null);

  const last = Math.min(tip, height + budget - 1);
  while (height <= last) {
    if (options.stop?.()) return done(null);

    requests += 1;
    const block = await blockAt(transport, height);
    if (!block.ok) return done(block.problem);

    const hashes = options.coinbase && block.value.minerTxHash
      ? [block.value.minerTxHash, ...block.value.txHashes]
      : block.value.txHashes;

    const inBlock: Received[] = [];
    for (let at = 0; at < hashes.length; at += MAX_TXS_PER_REQUEST) {
      requests += 1;
      const batch = await transactions(transport, hashes.slice(at, at + MAX_TXS_PER_REQUEST));
      if (!batch.ok) return done(batch.problem);
      for (const tx of batch.value) inBlock.push(...scanOne(account, tx, height));
    }

    received.push(...inBlock);
    blocks += 1;
    height += 1;
    options.onBlock?.(height - 1);
  }

  return done(null);
}

/**
 * One transaction, tested output by output.
 *
 * The derivation is computed once here rather than once per output, which is
 * the difference between one scalar multiplication and one per output on every
 * transaction in the chain.
 */
export function scanOne(account: MoneroAccount, tx: ScannableTx, height: number): Received[] {
  if (!tx.publicKey) return [];
  const derivation = keyDerivation(account.viewSecret, tx.publicKey);
  if (!derivation) return [];

  const found: Received[] = [];
  for (const candidate of tx.outputs) {
    const owned = ownsWithDerivation(derivation, account.spendPublic, candidate);
    if (!owned) continue;
    const value = amountOf(tx, derivation, candidate.index, candidate.amount);
    found.push({
      txid: tx.hash,
      height,
      index: candidate.index,
      key: owned.key,
      amount: value.amount,
      unknownBecause: value.unknownBecause,
    });
  }
  return found;
}

/**
 * How much an output was worth, or an honest refusal to say.
 *
 * Three cases and they are genuinely different, so they are not collapsed:
 *
 *   - **The chain states it.** Pre-RingCT outputs and coinbase outputs carry
 *     the amount in the clear. Nothing to decrypt and nothing to check.
 *   - **RingCT, the current form.** Eight masked bytes, decrypted with the
 *     shared secret, then proved against the published commitment. If the
 *     commitment does not rebuild, the amount is refused.
 *   - **RingCT, the 2017 to 2019 forms.** A different encoding, on a stretch of
 *     chain that predates any wallet this app will pair with. Refused with a
 *     reason rather than decoded by guesswork.
 */
function amountOf(
  tx: ScannableTx,
  derivation: Uint8Array,
  index: number,
  stated: bigint | null,
): { amount: Atoms | null; unknownBecause: string | null } {
  if (stated !== null) return { amount: stated, unknownBecause: null };
  if (tx.rctType === 0) {
    /* Not RingCT and the stated amount was zero, so zero is the amount. An
     * output worth nothing is legal and occasionally real. */
    return { amount: 0n, unknownBecause: null };
  }
  if (tx.rctType < 4) {
    return {
      amount: null,
      unknownBecause: 'That output uses the RingCT format from before 2020, which this wallet does not decode.',
    };
  }

  const masked = tx.ecdh[index] ?? '';
  if (masked.length !== 16) {
    return {
      amount: null,
      unknownBecause: 'The node did not send an amount for that output in a form this wallet reads.',
    };
  }
  const commitment = tx.commitments[index] ?? '';
  if (commitment.length !== 64) {
    return { amount: null, unknownBecause: 'The node did not send a commitment for that output.' };
  }

  try {
    const shared = derivationToScalar(derivation, index);
    const mask = amountMask(shared);
    /* Little-endian, eight bytes, exclusive-ored with the first eight bytes of
     * the hash. This is the whole of the encryption; the strength is in the
     * shared secret and not in the operation. */
    let amount = 0n;
    for (let byte = 7; byte >= 0; byte--) {
      const cipher = parseInt(masked.slice(byte * 2, byte * 2 + 2), 16);
      amount = (amount << 8n) | BigInt((cipher ^ mask[byte]!) & 0xff);
    }

    const blind = commitmentMask(shared);
    if (toHex(commit(amount, blind)) !== commitment) {
      /* The one refusal that matters. Everything above could be wrong in some
       * way that still produces a plausible number, and this is the check that
       * makes a plausible wrong number impossible to report. */
      return {
        amount: null,
        unknownBecause: 'That amount did not match the commitment on the chain, so it is not being shown.',
      };
    }
    return { amount, unknownBecause: null };
  } catch {
    return { amount: null, unknownBecause: 'That output could not be read.' };
  }
}

// ---------------------------------------------------------------------------
// Totals

export interface ReceivedTotal {
  /** Piconero, summed over every output whose amount is known. */
  total: Atoms;
  outputs: number;
  /** How many outputs are in the total. */
  counted: number;
  /** How many were found but could not be valued, which the screen shows. */
  unknown: number;
}

/**
 * Add up what arrived, over a set of outputs that may contain repeats.
 *
 * Repeats are ordinary: rescanning a range finds the same outputs again, and a
 * wallet that added them twice would double somebody's money on screen. The
 * one-time key is unique per output by construction, so the transaction and
 * index together are an identity and deduplicating on them is exact.
 */
export function totalReceived(found: readonly Received[]): ReceivedTotal {
  const seen = new Map<string, Received>();
  for (const entry of found) seen.set(outputKey(entry), entry);

  let total = 0n;
  let counted = 0;
  let unknown = 0;
  for (const entry of seen.values()) {
    if (entry.amount === null) unknown += 1;
    else {
      total += entry.amount;
      counted += 1;
    }
  }
  return { total, outputs: seen.size, counted, unknown };
}

/**
 * How far through the chain a scan is, as a fraction.
 *
 * From the birth height rather than from zero, because a wallet made last week
 * is not one percent synced and saying so would tell somebody to expect hours
 * of work that is really a minute.
 */
export function progressFraction(state: ScanState, tip: number): number {
  const span = tip - state.birth;
  if (span <= 0) return 1;
  const walked = Math.min(Math.max(state.height - state.birth, 0), span);
  return walked / span;
}
