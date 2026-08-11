/**
 * The Monero transaction wire format, anchored to real transaction ids.
 *
 * A signed transaction is three byte strings: the prefix (version, inputs,
 * outputs, extra), the RingCT base (fee, encrypted amounts, output
 * commitments), and the RingCT prunable section (range proof, ring signatures,
 * pseudo commitments). The transaction id is the Keccak of the three sections'
 * Keccaks, which gives this file its anchor: serialize a real mainnet
 * transaction's parsed fields and the bytes must reproduce its txid exactly,
 * or a single byte is wrong somewhere. `test/fixtures/monero-raw-tx.json`
 * holds three real transactions (one, two inputs; two, three outputs) and the
 * test regenerates all three ids.
 *
 * That anchor is what makes the *builder* trustworthy: the same functions that
 * reproduce a network-accepted transaction's bytes are the ones that serialize
 * a fresh spend, so "the node will parse what the vault signs" stops being a
 * hope and becomes the same claim the txid test makes.
 *
 * Transcribed from `serialize_rctsig_base`, `serialize_rctsig_prunable`
 * (rctTypes.h) and the cryptonote prefix format. Only what a Bulletproof+
 * CLSAG transaction (rct type 6, tagged outputs) needs is here, because that
 * is the only kind this wallet builds; parsing strange transactions belongs to
 * the scan, not the signer.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import type { BulletproofPlus } from './bulletproofplus';
import { fromHex, toHex } from './monero';

/** RCTTypeBulletproofPlus, the only kind this wallet writes. */
export const RCT_TYPE_BPP = 6;

/** The tagged-key output format (v15+), a one-time key plus a one-byte view tag. */
const TXOUT_TO_TAGGED_KEY = 0x03;
/** The key input format: a ring of offsets and a key image. */
const TXIN_TO_KEY = 0x02;

/** tx_extra field tags. */
const EXTRA_TAG_PUBKEY = 0x01;
const EXTRA_TAG_NONCE = 0x02;
const EXTRA_TAG_ADDITIONAL_PUBKEYS = 0x04;
/** Inside an extra nonce, the marker for an encrypted short payment id. */
const NONCE_ENCRYPTED_PAYMENT_ID = 0x01;

export interface ExtraFields {
  /** The main transaction public key, hex. */
  txPublicKey: string;
  /** Per-output transaction public keys, hex, for subaddress destinations. */
  additionalPublicKeys?: readonly string[];
  /** The eight-byte encrypted short payment id, hex, real or dummy. */
  encryptedPaymentId?: string;
}

/**
 * Build the `tx_extra` field a spend carries.
 *
 * The transaction public key first, then the additional per-output keys when
 * subaddresses need them, then the encrypted payment id nonce. Every standard
 * spend carries an encrypted payment id, a real one for an integrated address
 * and a dummy zero otherwise, so that the two are indistinguishable on the
 * chain; that uniformity is the reason to always pass one. Transcribed from
 * `add_tx_pub_key_to_extra`, `add_additional_tx_pub_keys_to_extra`, and
 * `set_encrypted_payment_id_to_tx_extra_nonce`.
 */
export function buildTxExtra(fields: ExtraFields): string {
  const parts: Uint8Array[] = [Uint8Array.of(EXTRA_TAG_PUBKEY), fromHex(fields.txPublicKey)];
  const additional = fields.additionalPublicKeys ?? [];
  if (additional.length > 0) {
    parts.push(Uint8Array.of(EXTRA_TAG_ADDITIONAL_PUBKEYS), varintBytes(additional.length));
    for (const key of additional) parts.push(fromHex(key));
  }
  if (fields.encryptedPaymentId !== undefined) {
    const id = fromHex(fields.encryptedPaymentId);
    if (id.length !== 8) throw new Error('An encrypted short payment id is eight bytes.');
    const nonce = new Uint8Array(1 + 8);
    nonce[0] = NONCE_ENCRYPTED_PAYMENT_ID;
    nonce.set(id, 1);
    parts.push(Uint8Array.of(EXTRA_TAG_NONCE), varintBytes(nonce.length), nonce);
  }
  return toHex(cat(...parts));
}

/** Monero's varint over bigints, since amounts and offsets exceed 2^32. */
export function varintBytes(value: bigint | number): Uint8Array {
  let n = BigInt(value);
  if (n < 0n) throw new Error('A varint is unsigned.');
  const out: number[] = [];
  while (n >= 0x80n) { out.push(Number(n & 0x7fn) | 0x80); n >>= 7n; }
  out.push(Number(n));
  return Uint8Array.from(out);
}

/** The wire wants ring offsets relative to the previous member. */
export function absoluteToRelative(indices: readonly number[]): number[] {
  const out: number[] = [];
  let prev = 0;
  for (const index of indices) {
    if (index < prev) throw new Error('Ring member indices must be sorted ascending.');
    out.push(index - prev);
    prev = index;
  }
  return out;
}

function cat(...chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const c of chunks) length += c.length;
  const buf = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.length; }
  return buf;
}

export interface WireInput {
  /** Relative ring offsets, as they go on the wire. */
  keyOffsets: readonly number[];
  keyImage: string;
}

export interface WireOutput {
  /** The one-time output key. */
  key: string;
  /** One byte of the receiver's derivation hash, hex, for fast scanning. */
  viewTag: string;
}

export interface WirePrefix {
  version: number;
  unlockTime: bigint | number;
  inputs: readonly WireInput[];
  outputs: readonly WireOutput[];
  /** The extra field, already assembled, as hex. */
  extra: string;
}

/** The cryptonote transaction prefix: what the txid's first hash covers. */
export function serializePrefix(prefix: WirePrefix): Uint8Array {
  const parts: Uint8Array[] = [varintBytes(prefix.version), varintBytes(prefix.unlockTime)];
  parts.push(varintBytes(prefix.inputs.length));
  for (const input of prefix.inputs) {
    parts.push(Uint8Array.of(TXIN_TO_KEY), varintBytes(0));
    parts.push(varintBytes(input.keyOffsets.length));
    for (const offset of input.keyOffsets) parts.push(varintBytes(offset));
    parts.push(fromHex(input.keyImage));
  }
  parts.push(varintBytes(prefix.outputs.length));
  for (const output of prefix.outputs) {
    parts.push(varintBytes(0), Uint8Array.of(TXOUT_TO_TAGGED_KEY), fromHex(output.key), fromHex(output.viewTag));
  }
  const extra = fromHex(prefix.extra);
  parts.push(varintBytes(extra.length), extra);
  return cat(...parts);
}

export interface WireRctBase {
  /** Piconero. */
  fee: bigint;
  /** Eight bytes of encrypted amount per output, hex. */
  ecdhAmounts: readonly string[];
  /** The output commitments. */
  outPk: readonly string[];
}

/** The RingCT base: type, fee, encrypted amounts, commitments. */
export function serializeRctBase(base: WireRctBase): Uint8Array {
  if (base.ecdhAmounts.length !== base.outPk.length) throw new Error('One encrypted amount per commitment.');
  const parts: Uint8Array[] = [Uint8Array.of(RCT_TYPE_BPP), varintBytes(base.fee)];
  for (const amount of base.ecdhAmounts) {
    const bytes = fromHex(amount);
    if (bytes.length !== 8) throw new Error('An encrypted amount is eight bytes.');
    parts.push(bytes);
  }
  for (const commitment of base.outPk) parts.push(fromHex(commitment));
  return cat(...parts);
}

export interface WireClsag {
  /** Ring-size response scalars, serialized without a count. */
  s: readonly string[];
  c1: string;
  D: string;
}

export interface WireRctPrunable {
  bpp: readonly BulletproofPlus[];
  clsags: readonly WireClsag[];
  pseudoOuts: readonly string[];
}

/** One Bulletproof+ as it sits inside the prunable section. */
function serializeBpp(proof: BulletproofPlus): Uint8Array {
  const parts: Uint8Array[] = [
    fromHex(proof.A), fromHex(proof.A1), fromHex(proof.B),
    fromHex(proof.r1), fromHex(proof.s1), fromHex(proof.d1),
    varintBytes(proof.L.length),
  ];
  for (const l of proof.L) parts.push(fromHex(l));
  parts.push(varintBytes(proof.R.length));
  for (const r of proof.R) parts.push(fromHex(r));
  return cat(...parts);
}

/** The prunable section: range proof, then a CLSAG per input, then pseudo-outs. */
export function serializeRctPrunable(prunable: WireRctPrunable): Uint8Array {
  if (prunable.clsags.length !== prunable.pseudoOuts.length) throw new Error('One pseudo-out per input.');
  const parts: Uint8Array[] = [varintBytes(prunable.bpp.length)];
  for (const proof of prunable.bpp) parts.push(serializeBpp(proof));
  for (const clsag of prunable.clsags) {
    for (const s of clsag.s) parts.push(fromHex(s));
    parts.push(fromHex(clsag.c1), fromHex(clsag.D));
  }
  for (const pseudo of prunable.pseudoOuts) parts.push(fromHex(pseudo));
  return cat(...parts);
}

/**
 * The transaction id: Keccak of the three sections' Keccaks. The same three
 * hashes are what a pruned node keeps, which is why the id survives pruning.
 */
export function transactionId(prefix: Uint8Array, base: Uint8Array, prunable: Uint8Array): string {
  return toHex(keccak_256(cat(keccak_256(prefix), keccak_256(base), keccak_256(prunable))));
}

/**
 * The message every CLSAG in the transaction signs: the prefix hash, the base
 * hash, and the hash of the range proof's elements, hashed together
 * (`get_pre_mlsag_hash`). Signing this and not just the prefix is what welds
 * the ring signatures to the amounts and the range proof: change any of it and
 * every input's signature dies with it.
 */
export function preClsagHash(prefixHash: Uint8Array, baseBytes: Uint8Array, bpp: readonly BulletproofPlus[]): Uint8Array {
  const fields: Uint8Array[] = [];
  for (const proof of bpp) {
    fields.push(fromHex(proof.A), fromHex(proof.A1), fromHex(proof.B), fromHex(proof.r1), fromHex(proof.s1), fromHex(proof.d1));
    for (const l of proof.L) fields.push(fromHex(l));
    for (const r of proof.R) fields.push(fromHex(r));
  }
  return keccak_256(cat(prefixHash, keccak_256(baseBytes), keccak_256(cat(...fields))));
}

/**
 * The transaction's weight, which is what the network prices, not its raw size.
 *
 * Weight is the serialized byte length plus the Bulletproof+ clawback: a
 * surcharge on range proofs padded past their output count, so that a
 * many-output transaction pays for the verification a padded proof forces on
 * every node. The formula is `(bp_base * padded - bp_size) * 4/5` from
 * `get_transaction_weight_clawback`, exact rather than estimated, because this
 * is the number a fee has to cover to relay. `nOutputs` is the real output
 * count; the clawback is zero at two or fewer.
 */
export function transactionWeight(sizeBytes: number, nOutputs: number): number {
  if (nOutputs <= 2) return sizeBytes;
  const bpBase = Math.floor((32 * (6 + 7 * 2)) / 2); // 320: a normalized 2-output BP+ proof
  let logPadded = 2;
  while ((1 << logPadded) < nOutputs) logPadded++;
  const nlr = 2 * (6 + logPadded);
  const bpSize = 32 * (6 + nlr);
  const clawback = Math.floor(((bpBase * (1 << logPadded) - bpSize) * 4) / 5);
  return sizeBytes + clawback;
}

export interface RawTransaction {
  /** The broadcastable bytes, hex: what /send_raw_transaction takes. */
  hex: string;
  txid: string;
  /** The consensus weight (bytes plus Bulletproof+ clawback) the fee prices. */
  weight: number;
}

/** The whole transaction: prefix ‖ base ‖ prunable, plus its id and weight. */
export function assembleRawTransaction(prefix: WirePrefix, base: WireRctBase, prunable: WireRctPrunable): RawTransaction {
  const prefixBytes = serializePrefix(prefix);
  const baseBytes = serializeRctBase(base);
  const prunableBytes = serializeRctPrunable(prunable);
  const sizeBytes = prefixBytes.length + baseBytes.length + prunableBytes.length;
  return {
    hex: toHex(cat(prefixBytes, baseBytes, prunableBytes)),
    txid: transactionId(prefixBytes, baseBytes, prunableBytes),
    weight: transactionWeight(sizeBytes, base.outPk.length),
  };
}
