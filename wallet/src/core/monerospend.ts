/**
 * Building an unsigned Monero spend, which is the half of sending that a
 * watch-only wallet can and must do.
 *
 * ## The division, restated because it is the whole design
 *
 * The vault holds the spend key and signs. It has no network, so it cannot
 * choose decoys (that needs the chain) or know the fee market (that needs the
 * node). This wallet does both, assembles an unsigned transaction set, and
 * hands it across the airgap. The vault signs it and hands back the finished
 * bytes. This is monero-wallet-cli's cold-signing split, and it is the only
 * arrangement in which the online device never touches a spend key.
 *
 * ## Where the money actually leaks, and where it does not
 *
 * "Signing code" sounds like the dangerous part. It is not the part that loses
 * money: a wrong signature is rejected by the network and the coins stay put.
 * The two places a mistake *loses* money are both here, in ordinary
 * arithmetic:
 *
 *   1. **The change output.** Every spend pays the remainder back to yourself.
 *      Send it to an address you do not control and it is gone, irreversibly,
 *      and it looks exactly like a successful send. So change goes to the
 *      account's own address, checked, and `test/monerospend.test.ts` makes
 *      that a property rather than a hope.
 *   2. **The balance.** Inputs must cover the destinations plus the fee
 *      exactly; the change is what is left, and an off-by-one there either
 *      overpays a stranger or builds a transaction the network rejects.
 *
 * Both are integer arithmetic over piconero, done in `bigint`, tested against
 * hand-computed totals.
 *
 * ## What crosses the wire, and what it is not
 *
 * The unsigned set carries, per input, enough for the vault to re-derive the
 * one-time secret and sign: the source transaction's public key, the output's
 * index within it, and the assembled ring. It does not carry any secret. A
 * view key is enough to build all of it, which is the point.
 */

import type { ChainOutput } from '../net/monerod';
import { RING_SIZE } from './decoys';

/** Piconero. A whole XMR is 1e12 of these. */
export type Piconero = bigint;

/** An owned, spendable output, as the scan and the vault together establish it. */
export interface SpendableOutput {
  /** Global output index on the chain, the handle the ring is built around. */
  globalIndex: number;
  /** The one-time public key on the output. */
  key: string;
  /** The amount commitment on the output. */
  commitment: string;
  /** The value, in piconero. Known because the scan proved it. */
  amount: Piconero;
  /** The transaction public key of the transaction that created this output. */
  txPublicKey: string;
  /** The output's index within that transaction. */
  indexInTx: number;
}

/** A ring assembled for one input: the members and where the real one sits. */
export interface Ring {
  members: ChainOutput[];
  realPosition: number;
}

/** Where money is going. */
export interface Destination {
  address: string;
  amount: Piconero;
}

// ---------------------------------------------------------------------------
// Fee, from an estimate of the signed transaction's weight
//
// Monero charges by transaction weight, not raw size, and the exact weight is
// known only once the thing is built. This estimates it closely enough to
// choose a fee the network will relay, from the shapes alone. Being a little
// high wastes a few piconero; being too low gets the transaction rejected,
// which is an inconvenience and not a loss, so the estimate rounds up.

/**
 * The extra field of a standard spend: the transaction public key (tag plus 32
 * bytes) and the dummy encrypted payment id every wallet2 transaction carries
 * for uniformity (tag, length, and the eight-byte encrypted id, nine bytes of
 * payload). A spend whose `extra` differs passes its own size here.
 */
export const STANDARD_EXTRA_SIZE = 1 + 32 + 1 + 1 + 1 + 8;

/**
 * The weight of a signed Bulletproof+ CLSAG transaction, in bytes.
 *
 * Transcribed from wallet2's `estimate_rct_tx_size` and `estimate_tx_weight`
 * for the only transaction kind this wallet builds: RingCT type 6, CLSAG
 * signatures, tagged (view-tag) outputs. Every term is the reference's, so the
 * estimate tracks the serialized size closely; the one deliberate looseness is
 * the ring-offset varints, which the reference also approximates as two bytes
 * each, and which serialize to at most that. The Bulletproof+ weight clawback,
 * the surcharge the network applies to proofs padded past their output count,
 * is the exact `(bp_base * padded - bp_size) * 4/5` from the source, not an
 * approximation, because underpricing it is what gets a many-output spend
 * rejected at relay.
 */
export function estimateWeight(
  inputs: number,
  outputs: number,
  ringSize = RING_SIZE,
  extraSize = STANDARD_EXTRA_SIZE,
): number {
  const mixin = ringSize - 1; // wallet2 counts decoys; ring size is mixin + 1

  let size = 0;
  size += 1 + 6; // version and unlock time
  size += inputs * (1 + 6 + (mixin + 1) * 2 + 32); // vin: tag, amount, offsets, key image
  size += outputs * (6 + 32); // vout: amount, tag, one-time key
  size += extraSize;
  size += 1; // rct type

  // Bulletproof+ range proof: 6 fixed elements plus L and R, each of length
  // 6 + log2(padded outputs).
  let logPadded = 0;
  while ((1 << logPadded) < outputs) logPadded++;
  size += (2 * (6 + logPadded) + 6) * 32 + 3;

  size += inputs * (32 * (mixin + 1) + 64); // CLSAGs: s per member, c1 and D
  size += outputs; // one view-tag byte per output
  size += 32 * inputs; // pseudoOuts
  size += 8 * outputs; // ecdhInfo
  size += 32 * outputs; // outPk commitments
  size += 4; // txnFee

  if (outputs > 2) {
    const bpBase = Math.floor((32 * (6 + 7 * 2)) / 2); // 320, a normalized 2-output proof
    let lpo = 2;
    while ((1 << lpo) < outputs) lpo++;
    const nlr = 2 * (6 + lpo);
    const bpSize = 32 * (6 + nlr);
    const clawback = Math.floor(((bpBase * (1 << lpo) - bpSize) * 4) / 5);
    size += clawback;
  }

  return size;
}

/**
 * The fee for a transaction of this shape, in piconero.
 *
 * `perByte` is the node's estimate, `multiplier` is the priority (1 for the
 * default). Weight times rate times priority, the way the network prices it.
 */
export function feeFor(
  inputs: number,
  outputs: number,
  perByte: Piconero,
  multiplier = 1,
  ringSize = RING_SIZE,
): Piconero {
  return BigInt(estimateWeight(inputs, outputs, ringSize)) * perByte * BigInt(multiplier);
}

// ---------------------------------------------------------------------------
// Coin selection

/** An output worth less than this is dust: it costs more in fee than it holds. */
export const DUST = 1_000n; // piconero; below the fee of adding it as an input

export interface InputPlan {
  ok: boolean;
  problem: string | null;
  /** The outputs chosen to fund the spend. */
  inputs: SpendableOutput[];
  fee: Piconero;
  /** What returns to the sender. Zero when the inputs match to the piconero. */
  change: Piconero;
}

/**
 * Choose which owned outputs to spend, and settle the fee and change.
 *
 * Largest-first: fewer, larger inputs mean a smaller transaction and a smaller
 * fee, and the privacy cost of input choice is covered by the ring rather than
 * by which of your own outputs you pick. Adds inputs until they cover the
 * destinations plus the fee, recomputing the fee as the input count grows,
 * because each input makes the transaction heavier.
 *
 * The change output is counted in the fee's output tally from the start, so a
 * plan that then produces change is not underpaying, and one that produces
 * dust-sized change drops it into the fee rather than making an output nobody
 * benefits from spending.
 */
export function selectInputs(
  owned: readonly SpendableOutput[],
  sending: Piconero,
  perByte: Piconero,
  multiplier = 1,
  ringSize = RING_SIZE,
  destinationCount = 1,
): InputPlan {
  const fail = (problem: string): InputPlan => ({ ok: false, problem, inputs: [], fee: 0n, change: 0n });

  if (sending <= 0n) return fail('There is nothing to send.');
  const spendable = [...owned].filter((o) => o.amount > 0n).sort((a, b) => (b.amount > a.amount ? 1 : -1));
  if (spendable.length === 0) return fail('There are no spendable outputs.');

  const chosen: SpendableOutput[] = [];
  let total = 0n;
  for (const output of spendable) {
    chosen.push(output);
    total += output.amount;
    // Outputs in the fee tally: the destinations plus a change output.
    const fee = feeFor(chosen.length, destinationCount + 1, perByte, multiplier, ringSize);
    if (total >= sending + fee) {
      const change = total - sending - fee;
      if (change > 0n && change <= DUST) {
        /* Change too small to be worth an output: fold it into the fee. The
         * alternative, an output holding less than it costs to spend, is a
         * gift to nobody and a fingerprint on the chain. */
        return { ok: true, problem: null, inputs: chosen, fee: fee + change, change: 0n };
      }
      return { ok: true, problem: null, inputs: chosen, fee, change };
    }
  }

  const fee = feeFor(chosen.length, destinationCount + 1, perByte, multiplier, ringSize);
  return fail(
    `Not enough spendable Monero. Sending needs ${sending + fee} piconero including fee, and the spendable outputs total ${total}.`,
  );
}

// ---------------------------------------------------------------------------
// The unsigned transaction set: what crosses to the vault

/** Bumped if the shape changes in a way an older vault would misread. */
export const UNSIGNED_VERSION = 1;

export interface UnsignedInput {
  /** The transaction public key of the source transaction. */
  txPublicKey: string;
  /** The real output's index within that transaction. */
  indexInTx: number;
  /** The real output's global index, and the value it holds. */
  globalIndex: number;
  amount: string;
  /** The ring, in wire order: members' keys and commitments, real one hidden
   *  among them. */
  ring: { globalIndex: number; key: string; commitment: string }[];
  /** Where the real member sits in `ring` after sorting. */
  realPosition: number;
}

export interface UnsignedOutput {
  address: string;
  amount: string;
  /** True for the change output paying the sender's own address. */
  change: boolean;
  /** True for a zero-amount padding output. Consensus needs two outputs; a
   *  spend that would have one gets this, paying the sender nothing. */
  dummy?: boolean;
}

export interface UnsignedTxSet {
  v: number;
  chain: 'xmr';
  network: 'mainnet' | 'stagenet' | 'testnet';
  inputs: UnsignedInput[];
  outputs: UnsignedOutput[];
  fee: string;
  ringSize: number;
}

export interface AssembleParams {
  inputs: readonly SpendableOutput[];
  rings: readonly Ring[];
  destinations: readonly Destination[];
  change: Piconero;
  /** The account's own address, where change goes. Nowhere else. */
  ownAddress: string;
  fee: Piconero;
  network: 'mainnet' | 'stagenet' | 'testnet';
  ringSize?: number;
}

export type Assembled = { ok: true; set: UnsignedTxSet } | { ok: false; problem: string };

/**
 * Assemble the unsigned set, with the balance and the change address checked.
 *
 * The two checks that matter run here and refuse rather than warn:
 *
 *   - **Change goes to the owner.** If `change > 0`, an output paying
 *     `ownAddress` is added and it is the only place change may go. There is
 *     no parameter for a change address, on purpose: the one time it would be
 *     set to something else is the one time money is lost.
 *   - **The balance closes.** Inputs must equal outputs plus fee, to the
 *     piconero. A set that does not balance is refused here, before it can
 *     become a transaction the network rejects or, worse, one that quietly
 *     pays the difference to a miner.
 */
export function assembleUnsigned(params: AssembleParams): Assembled {
  const { inputs, rings, destinations, change, ownAddress, fee, network } = params;
  const ringSize = params.ringSize ?? RING_SIZE;

  if (inputs.length === 0) return { ok: false, problem: 'A spend needs at least one input.' };
  if (rings.length !== inputs.length) return { ok: false, problem: 'Every input needs a ring.' };
  if (destinations.length === 0) return { ok: false, problem: 'A spend needs a destination.' };

  const inputTotal = inputs.reduce((sum, o) => sum + o.amount, 0n);
  const sendTotal = destinations.reduce((sum, d) => sum + d.amount, 0n);
  const outputTotal = sendTotal + (change > 0n ? change : 0n);

  if (inputTotal !== outputTotal + fee) {
    return {
      ok: false,
      problem: `The inputs do not balance the outputs and fee: ${inputTotal} in, ${outputTotal} out, ${fee} fee.`,
    };
  }

  const outputs: UnsignedOutput[] = destinations.map((d) => ({
    address: d.address,
    amount: d.amount.toString(),
    change: false,
    dummy: false,
  }));
  if (change > 0n) {
    /* The single most important line in this file. Change goes to the owner's
     * own address, full stop. */
    outputs.push({ address: ownAddress, amount: change.toString(), change: true, dummy: false });
  }
  if (outputs.length < 2) {
    /* Consensus has required at least two outputs since hard fork 12. A spend
     * whose destinations and change come to a single output (an exact-amount
     * send, or one whose change was folded into the fee) gets a zero-amount
     * output to the sender, exactly as wallet2 does. It pays nobody, changes
     * no balance, and the fee was already sized for a change output, so the
     * weight is covered. */
    outputs.push({ address: ownAddress, amount: '0', change: true, dummy: true });
  }

  const wireInputs: UnsignedInput[] = inputs.map((input, i) => {
    const ring = rings[i]!;
    return {
      txPublicKey: input.txPublicKey,
      indexInTx: input.indexInTx,
      globalIndex: input.globalIndex,
      amount: input.amount.toString(),
      ring: ring.members.map((m) => ({ globalIndex: m.globalIndex, key: m.key, commitment: m.commitment })),
      realPosition: ring.realPosition,
    };
  });

  /* The real output must actually be the ring member at `realPosition`, or the
   * vault would sign for a decoy it has no key to. A cheap, decisive check. */
  for (let i = 0; i < wireInputs.length; i++) {
    const at = wireInputs[i]!.realPosition;
    const member = wireInputs[i]!.ring[at];
    if (!member || member.globalIndex !== inputs[i]!.globalIndex || member.key !== inputs[i]!.key) {
      return { ok: false, problem: 'A ring does not have the real output where it says it does.' };
    }
  }

  return {
    ok: true,
    set: {
      v: UNSIGNED_VERSION,
      chain: 'xmr',
      network,
      inputs: wireInputs,
      outputs,
      fee: fee.toString(),
      ringSize,
    },
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The bytes to put on the wire, as an XMRUNSIGNED payload. */
export function encodeUnsigned(set: UnsignedTxSet): Uint8Array {
  return encoder.encode(JSON.stringify(set));
}

/**
 * Read an unsigned set, on the vault side, refusing anything malformed.
 *
 * The vault acts on this to sign real money, so it is parsed as strictly as
 * anything in the repository: every amount a decimal string, every key 64 hex,
 * the ring the size it claims, the real position inside it. A half-valid set
 * is refused whole.
 */
export function parseUnsigned(
  bytes: Uint8Array,
): { ok: true; set: UnsignedTxSet } | { ok: false; problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return { ok: false, problem: 'That is not an unsigned transaction set.' };
  }
  if (!value || typeof value !== 'object') return { ok: false, problem: 'That is not an unsigned transaction set.' };
  const raw = value as Record<string, unknown>;
  if (raw['chain'] !== 'xmr') return { ok: false, problem: 'That set is not about Monero.' };
  if (raw['v'] !== UNSIGNED_VERSION) return { ok: false, problem: 'That set is from a different version of the wallet.' };
  if (raw['network'] !== 'mainnet' && raw['network'] !== 'stagenet' && raw['network'] !== 'testnet') {
    return { ok: false, problem: 'That set does not name a known network.' };
  }

  /* An amount is a 64-bit count of piconero, and the ceiling is part of that
   * rather than a nicety: the twin of this parser in the vault has it, and a
   * mirror that accepts what the original refuses is not a mirror. */
  const amount = (v: unknown): bigint | null => {
    if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
    try {
      const parsed = BigInt(v);
      return parsed < 2n ** 64n ? parsed : null;
    } catch { return null; }
  };
  const hex64 = (v: unknown): boolean => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v);
  /* `JSON.parse` produces `[null]`, and reading a field off null throws out of
   * a parser that promises to refuse in a sentence. The vault's copy of this
   * format keeps the same guard; both halves of a wire format should fail the
   * same way on the same bytes. */
  const fields = (entry: unknown): Record<string, unknown> =>
    entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
  const whole = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0;

  if (!Array.isArray(raw['inputs']) || raw['inputs'].length === 0) return { ok: false, problem: 'That set has no inputs.' };
  if (!Array.isArray(raw['outputs']) || raw['outputs'].length === 0) return { ok: false, problem: 'That set has no outputs.' };
  if (raw['inputs'].length > 128 || raw['outputs'].length > 16) return { ok: false, problem: 'That set is implausibly large.' };
  const fee = amount(raw['fee']);
  if (fee === null) return { ok: false, problem: 'That set has no fee.' };
  const ringSize = Number(raw['ringSize']);
  if (!Number.isInteger(ringSize) || ringSize < 1 || ringSize > 64) return { ok: false, problem: 'That set has an unreasonable ring size.' };

  const inputs: UnsignedInput[] = [];
  for (const entry of raw['inputs']) {
    const input = fields(entry);
    const amt = amount(input['amount']);
    if (!hex64(input['txPublicKey']) || amt === null) return { ok: false, problem: 'An input is malformed.' };
    if (!whole(input['indexInTx']) || !whole(input['globalIndex'])) return { ok: false, problem: 'An input is malformed.' };
    if (!Array.isArray(input['ring']) || input['ring'].length !== ringSize) return { ok: false, problem: 'An input ring is the wrong size.' };
    const ring = input['ring'].map(fields);
    for (const m of ring) {
      if (!hex64(m['key']) || !hex64(m['commitment']) || !whole(m['globalIndex'])) {
        return { ok: false, problem: 'A ring member is malformed.' };
      }
    }
    const realPosition = Number(input['realPosition']);
    if (!Number.isInteger(realPosition) || realPosition < 0 || realPosition >= ringSize) {
      return { ok: false, problem: 'An input real position is outside its ring.' };
    }
    inputs.push({
      txPublicKey: String(input['txPublicKey']).toLowerCase(),
      indexInTx: input['indexInTx'] as number,
      globalIndex: input['globalIndex'] as number,
      amount: amt.toString(),
      ring: ring.map((m) => ({ globalIndex: m['globalIndex'] as number, key: String(m['key']).toLowerCase(), commitment: String(m['commitment']).toLowerCase() })),
      realPosition,
    });
  }

  const outputs: UnsignedOutput[] = [];
  for (const entry of raw['outputs']) {
    const output = fields(entry);
    const amt = amount(output['amount']);
    if (typeof output['address'] !== 'string' || amt === null) return { ok: false, problem: 'An output is malformed.' };
    outputs.push({ address: output['address'], amount: amt.toString(), change: output['change'] === true, dummy: output['dummy'] === true });
  }

  return {
    ok: true,
    set: { v: UNSIGNED_VERSION, chain: 'xmr', network: raw['network'], inputs, outputs, fee: fee.toString(), ringSize },
  };
}

// ---------------------------------------------------------------------------
// The signed transaction, back from the vault

/** Must match the vault's `SIGNED_VERSION`; bumped together. */
export const SIGNED_VERSION = 1;

export interface SignedTx {
  txid: string;
  /** The broadcastable bytes, hex: what goes to `/send_raw_transaction`. */
  hex: string;
  network: 'mainnet' | 'stagenet' | 'testnet';
  fee: string;
  /** One per spent input, for the key image book. */
  keyImages: string[];
}

/**
 * Read an XMRSIGNED payload, refusing anything malformed.
 *
 * The wallet does not re-verify the cryptography inside; it cannot, without
 * the secrets, and the vault already verified every piece before emitting it.
 * What the wallet does own is the broadcast gate and the key image book, so
 * the id, the network, and the key images are held to the same strictness as
 * everything else that crosses the airgap.
 */
export function parseSignedTx(
  bytes: Uint8Array,
): { ok: true; tx: SignedTx } | { ok: false; problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return { ok: false, problem: 'That is not a signed transaction.' };
  }
  if (!value || typeof value !== 'object') return { ok: false, problem: 'That is not a signed transaction.' };
  const raw = value as Record<string, unknown>;
  if (raw['chain'] !== 'xmr') return { ok: false, problem: 'That signed transaction is not about Monero.' };
  if (raw['v'] !== SIGNED_VERSION) return { ok: false, problem: 'That signed transaction is from a different vault version.' };
  const network = raw['network'];
  if (network !== 'mainnet' && network !== 'stagenet' && network !== 'testnet') {
    return { ok: false, problem: 'That signed transaction does not name a known network.' };
  }
  const txid = raw['txid'];
  if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/.test(txid)) {
    return { ok: false, problem: 'That signed transaction has no id.' };
  }
  const hex = raw['hex'];
  if (typeof hex !== 'string' || !/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0 || hex.length < 200) {
    return { ok: false, problem: 'That signed transaction has no usable bytes.' };
  }
  const fee = raw['fee'];
  if (typeof fee !== 'string' || !/^\d+$/.test(fee)) return { ok: false, problem: 'That signed transaction has no fee.' };
  if (!Array.isArray(raw['keyImages']) || raw['keyImages'].length === 0) {
    return { ok: false, problem: 'That signed transaction lists no key images.' };
  }
  const keyImages: string[] = [];
  for (const image of raw['keyImages']) {
    if (typeof image !== 'string' || !/^[0-9a-f]{64}$/.test(image)) {
      return { ok: false, problem: 'A key image in that signed transaction is malformed.' };
    }
    keyImages.push(image);
  }
  return { ok: true, tx: { txid, hex, network, fee, keyImages } };
}
