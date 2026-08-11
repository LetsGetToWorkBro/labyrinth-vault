/**
 * The final assembly, tested the way the network would treat it.
 *
 * A synthetic but cryptographically real spend: a payer wallet funds the
 * sender with an output built exactly the way a real transaction builds one,
 * the sender's vault signs a spend of it, and then the test does what the
 * network and the receiver would do to the resulting BYTES, not to the
 * builder's internal state:
 *
 *   - re-parse the raw hex with an independent reader in this file;
 *   - check the money equation on the curve (pseudo-outs = outputs + fee·H);
 *   - verify the range proof with the consensus-anchored verifier;
 *   - verify every CLSAG against the reconstructed pre-hash;
 *   - scan the transaction as the receiver: find the output by derivation,
 *     check the view tag, decrypt the amount, and recommit it.
 *
 * The last item is the entire point of a payment. If the receiver's own
 * cryptography recovers the paid amount from the emitted bytes, the
 * transaction pays what it claims to pay.
 *
 * What none of this proves: that a live node relays it. That evidence is a
 * stagenet broadcast, and the gate in `moneroreadiness.ts` stays shut until
 * one is recorded.
 */

import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  parseUnsignedSet,
  signMoneroSpend,
  signingRandomCount,
  encodeSignedTx,
  type VaultUnsignedInput,
  type VaultUnsignedSet,
} from '../src/keys/monerobuild';
import {
  amountMask,
  commit,
  commitmentMask,
  derivationToScalar,
  derivePublicKey,
  generateKeyDerivation,
  writeVarint,
  RCT_H,
} from '../src/keys/monerocrypto';
import {
  addressChecksum,
  base58Encode,
  fromHex,
  publicFromSecret,
  toHex,
  walletFromSeed,
  type Wallet,
} from '../src/keys/monero';
import { verifyBulletproofPlus, type BulletproofPlus } from '../src/keys/bulletproofplus';
import { clsagVerify } from '../src/keys/monerosign';
import { preClsagHash } from '../src/keys/monerowire';

const Point = ed25519.Point;

// ---------------------------------------------------------------------------
// Deterministic materials

function detBytes(seed: number): Uint8Array {
  const b = new Uint8Array(32);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < 32; i++) { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; b[i] = x & 0xff; }
  b[31] = b[31]! & 0x0f;
  return b;
}

const sender: Wallet = walletFromSeed(detBytes(0xa11ce), 'stagenet');
const receiver: Wallet = walletFromSeed(detBytes(0xb0b), 'stagenet');

/**
 * An output the sender owns, built the way a real payer builds one: a fresh
 * transaction key, the standard derivation, a deterministic mask. This is
 * on-chain reality in miniature, which is what makes the vault's re-derivation
 * checks meaningful rather than vacuously green.
 */
function fundSender(amount: bigint, indexInTx: number, seed: number) {
  const payerTxSecret = detBytes(seed);
  const txPublicKey = publicFromSecret(payerTxSecret);
  const derivation = generateKeyDerivation(fromHex(sender.viewPublic), payerTxSecret);
  const oneTimeKey = derivePublicKey(derivation, indexInTx, fromHex(sender.spendPublic));
  const mask = commitmentMask(derivationToScalar(derivation, indexInTx));
  return {
    txPublicKey: toHex(txPublicKey),
    key: toHex(oneTimeKey),
    commitment: toHex(commit(amount, mask)),
    indexInTx,
    amount,
  };
}

/** A ring of plausible decoys around the real output, indices ascending. */
function ringAround(real: { key: string; commitment: string }, realPosition: number, seed: number, size = 16): VaultUnsignedInput['ring'] {
  const ring: VaultUnsignedInput['ring'] = [];
  for (let i = 0; i < size; i++) {
    if (i === realPosition) {
      ring.push({ globalIndex: 1_000_000 + i * 7, key: real.key, commitment: real.commitment });
    } else {
      ring.push({
        globalIndex: 1_000_000 + i * 7,
        key: toHex(publicFromSecret(detBytes(seed + i * 2))),
        commitment: toHex(publicFromSecret(detBytes(seed + i * 2 + 1))),
      });
    }
  }
  return ring;
}

const PAYMENT = 750_000_000_000n;
const CHANGE = 249_280_000_000n;
const FEE = 720_000_000n;
const FUNDED = PAYMENT + CHANGE + FEE;

function unsignedSet(overrides: Partial<VaultUnsignedSet> = {}): VaultUnsignedSet {
  const funded = fundSender(FUNDED, 1, 0xfeed);
  const realPosition = 4;
  return {
    v: 1,
    chain: 'xmr',
    network: 'stagenet',
    inputs: [{
      txPublicKey: funded.txPublicKey,
      indexInTx: funded.indexInTx,
      globalIndex: 1_000_000 + realPosition * 7,
      amount: funded.amount.toString(),
      ring: ringAround(funded, realPosition, 0x9000),
      realPosition,
    }],
    outputs: [
      { address: receiver.address, amount: PAYMENT.toString(), change: false, dummy: false },
      { address: sender.address, amount: CHANGE.toString(), change: true, dummy: false },
    ],
    fee: FEE.toString(),
    ringSize: 16,
    ...overrides,
  };
}

function randomsFor(set: VaultUnsignedSet, seed = 0x5151): Uint8Array[] {
  const count = signingRandomCount(set.inputs.length, set.ringSize, set.outputs.length);
  return Array.from({ length: count }, (_, i) => detBytes(seed + i));
}

// ---------------------------------------------------------------------------
// An independent reader for the emitted bytes

interface ParsedTx {
  version: number;
  unlockTime: number;
  inputs: { offsets: number[]; keyImage: string }[];
  outputs: { key: string; viewTag: string }[];
  extra: Uint8Array;
  fee: bigint;
  ecdh: string[];
  outPk: string[];
  bpp: BulletproofPlus;
  clsags: { s: string[]; c1: string; D: string }[];
  pseudoOuts: string[];
  prefixBytes: Uint8Array;
  baseBytes: Uint8Array;
}

/** Reads the exact format the builder writes; failures here are test failures. */
function readTx(hex: string, ringSize: number): ParsedTx {
  const bytes = fromHex(hex);
  let at = 0;
  const varint = (): number => {
    let value = 0, shift = 0;
    for (;;) {
      const byte = bytes[at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
    }
  };
  const take = (n: number): Uint8Array => bytes.subarray(at, (at += n));

  const prefixStart = at;
  const version = varint();
  const unlockTime = varint();
  const inputs: ParsedTx['inputs'] = [];
  const nIn = varint();
  for (let i = 0; i < nIn; i++) {
    expect(bytes[at++]).toBe(0x02);
    expect(varint()).toBe(0);
    const nOffsets = varint();
    const offsets: number[] = [];
    for (let j = 0; j < nOffsets; j++) offsets.push(varint());
    inputs.push({ offsets, keyImage: toHex(take(32)) });
  }
  const outputs: ParsedTx['outputs'] = [];
  const nOut = varint();
  for (let i = 0; i < nOut; i++) {
    expect(varint()).toBe(0);
    expect(bytes[at++]).toBe(0x03);
    const key = toHex(take(32));
    const viewTag = toHex(take(1));
    outputs.push({ key, viewTag });
  }
  const extra = take(varint());
  const prefixBytes = bytes.slice(prefixStart, at);

  const baseStart = at;
  expect(bytes[at++]).toBe(6); // RCTTypeBulletproofPlus
  let fee = 0n, shift = 0n;
  for (;;) {
    const byte = bytes[at++]!;
    fee |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  const ecdh: string[] = [];
  for (let i = 0; i < nOut; i++) ecdh.push(toHex(take(8)));
  const outPk: string[] = [];
  for (let i = 0; i < nOut; i++) outPk.push(toHex(take(32)));
  const baseBytes = bytes.slice(baseStart, at);

  expect(varint()).toBe(1); // one range proof
  const bpp: BulletproofPlus = {
    A: toHex(take(32)), A1: toHex(take(32)), B: toHex(take(32)),
    r1: toHex(take(32)), s1: toHex(take(32)), d1: toHex(take(32)),
    L: [], R: [],
  };
  const nL = varint();
  for (let i = 0; i < nL; i++) bpp.L.push(toHex(take(32)));
  const nR = varint();
  for (let i = 0; i < nR; i++) bpp.R.push(toHex(take(32)));
  const clsags: ParsedTx['clsags'] = [];
  for (let i = 0; i < nIn; i++) {
    const s: string[] = [];
    for (let j = 0; j < ringSize; j++) s.push(toHex(take(32)));
    clsags.push({ s, c1: toHex(take(32)), D: toHex(take(32)) });
  }
  const pseudoOuts: string[] = [];
  for (let i = 0; i < nIn; i++) pseudoOuts.push(toHex(take(32)));
  expect(at).toBe(bytes.length);

  return { version, unlockTime, inputs, outputs, extra, fee, ecdh, outPk, bpp, clsags, pseudoOuts, prefixBytes, baseBytes };
}

/** The receiver's whole scan, run against emitted bytes: find, check, decrypt. */
function scanAsWallet(wallet: Wallet, tx: ParsedTx): { position: number; amount: bigint }[] {
  expect(tx.extra[0]).toBe(0x01);
  const txPublicKey = tx.extra.subarray(1, 33);
  const derivation = generateKeyDerivation(txPublicKey, wallet.viewSecret);
  const found: { position: number; amount: bigint }[] = [];
  for (let position = 0; position < tx.outputs.length; position++) {
    const derived = toHex(derivePublicKey(derivation, position, fromHex(wallet.spendPublic)));
    if (derived !== tx.outputs[position]!.key) continue;

    /* The view tag must match, or a real scanning wallet skips this output. */
    const salt = new TextEncoder().encode('view_tag');
    const index = writeVarint(position);
    const buf = new Uint8Array(salt.length + 32 + index.length);
    buf.set(salt, 0); buf.set(derivation, salt.length); buf.set(index, salt.length + 32);
    expect(toHex(keccak_256(buf).subarray(0, 1))).toBe(tx.outputs[position]!.viewTag);

    /* Decrypt the amount and prove it against the commitment, exactly as the
     * watching wallet's scan does. */
    const shared = derivationToScalar(derivation, position);
    const mask = amountMask(shared);
    const cipher = fromHex(tx.ecdh[position]!);
    let amount = 0n;
    for (let byte = 7; byte >= 0; byte--) amount = (amount << 8n) | BigInt((cipher[byte]! ^ mask[byte]!) & 0xff);
    expect(toHex(commit(amount, commitmentMask(shared)))).toBe(tx.outPk[position]!);
    found.push({ position, amount });
  }
  return found;
}

// ---------------------------------------------------------------------------

describe('signing a spend end to end', () => {
  const set = unsignedSet();
  const result = signMoneroSpend(sender, set, randomsFor(set));

  it('signs', () => {
    expect(result.ok).toBe(true);
  });
  if (!result.ok) return;
  const tx = readTx(result.tx.hex, set.ringSize);

  it('emits a version 2, unlock 0 transaction whose bytes parse exactly', () => {
    expect(tx.version).toBe(2);
    expect(tx.unlockTime).toBe(0);
    expect(tx.fee).toBe(FEE);
    expect(result.tx.txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it('closes the money equation on the curve', () => {
    let lhs = Point.ZERO;
    for (const pseudo of tx.pseudoOuts) lhs = lhs.add(Point.fromBytes(fromHex(pseudo)));
    let rhs = Point.fromBytes(RCT_H).multiplyUnsafe(tx.fee);
    for (const commitment of tx.outPk) rhs = rhs.add(Point.fromBytes(fromHex(commitment)));
    expect(lhs.equals(rhs)).toBe(true);
  });

  it('carries a range proof the consensus-anchored verifier accepts', () => {
    expect(verifyBulletproofPlus(tx.outPk, tx.bpp)).toBe(true);
  });

  it('carries ring signatures that verify against the reconstructed pre-hash', () => {
    const message = preClsagHash(keccak_256(tx.prefixBytes), tx.baseBytes, [tx.bpp]);
    for (let i = 0; i < tx.inputs.length; i++) {
      const input = set.inputs[0]!; // one input in this set
      const ring = input.ring.map((m) => ({ key: m.key, commitment: m.commitment }));
      const signature = {
        c1: tx.clsags[i]!.c1,
        s: tx.clsags[i]!.s,
        keyImage: tx.inputs[i]!.keyImage,
        dInv8: tx.clsags[i]!.D,
      };
      expect(clsagVerify(message, ring, fromHex(tx.pseudoOuts[i]!), signature)).toBe(true);
    }
  });

  it('pays the receiver: their own scan finds and decrypts the amount', () => {
    const found = scanAsWallet(receiver, tx);
    expect(found).toHaveLength(1);
    expect(found[0]!.amount).toBe(PAYMENT);
  });

  it('returns the change: the sender finds exactly the change amount', () => {
    const found = scanAsWallet(sender, tx);
    expect(found).toHaveLength(1);
    expect(found[0]!.amount).toBe(CHANGE);
  });

  it('reports the key image the wallet will watch for', () => {
    expect(result.tx.keyImages).toHaveLength(1);
    expect(tx.inputs[0]!.keyImage).toBe(result.tx.keyImages[0]);
  });

  it('uses relative ring offsets that reconstruct the absolute indices', () => {
    const absolute: number[] = [];
    let sum = 0;
    for (const offset of tx.inputs[0]!.offsets) { sum += offset; absolute.push(sum); }
    expect(absolute).toEqual(set.inputs[0]!.ring.map((m) => m.globalIndex));
  });

  it('is deterministic under the same randomness, fresh under different', { timeout: 30_000 }, () => {
    const again = signMoneroSpend(sender, set, randomsFor(set));
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.tx.txid).toBe(result.tx.txid);
    const other = signMoneroSpend(sender, set, randomsFor(set, 0x7777));
    expect(other.ok).toBe(true);
    if (other.ok) {
      expect(other.tx.txid).not.toBe(result.tx.txid);
      const otherParsed = readTx(other.tx.hex, set.ringSize);
      expect(verifyBulletproofPlus(otherParsed.outPk, otherParsed.bpp)).toBe(true);
    }
  });

  it('encodes a signed payload that carries the id and the hex', () => {
    const payload = JSON.parse(new TextDecoder().decode(encodeSignedTx(result.tx)));
    expect(payload.chain).toBe('xmr');
    expect(payload.txid).toBe(result.tx.txid);
    expect(payload.hex).toBe(result.tx.hex);
  });
});

describe('signing with two inputs', () => {
  it('sorts inputs by key image descending and balances across both', () => {
    const fundedA = fundSender(1_000_000_000_000n, 0, 0xaa01);
    const fundedB = fundSender(500_000_000_000n, 1, 0xbb02);
    const fee = 500_000_000n;
    const payment = 1_000_000_000_000n;
    const change = 1_500_000_000_000n - payment - fee;
    const makeInput = (funded: ReturnType<typeof fundSender>, position: number, seed: number): VaultUnsignedInput => ({
      txPublicKey: funded.txPublicKey,
      indexInTx: funded.indexInTx,
      globalIndex: 2_000_000 + position * 3,
      amount: funded.amount.toString(),
      ring: ringAround(funded, position, seed),
      realPosition: position,
    });
    const set = unsignedSet({
      inputs: [makeInput(fundedA, 2, 0x100), makeInput(fundedB, 9, 0x200)],
      outputs: [
        { address: receiver.address, amount: payment.toString(), change: false },
        { address: sender.address, amount: change.toString(), change: true },
      ],
      fee: fee.toString(),
    });
    const result = signMoneroSpend(sender, set, randomsFor(set, 0x3333));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tx = readTx(result.tx.hex, set.ringSize);

    expect(tx.inputs).toHaveLength(2);
    /* Consensus input order: key images descending, byte-lexicographic. */
    expect(tx.inputs[0]!.keyImage > tx.inputs[1]!.keyImage).toBe(true);

    let lhs = Point.ZERO;
    for (const pseudo of tx.pseudoOuts) lhs = lhs.add(Point.fromBytes(fromHex(pseudo)));
    let rhs = Point.fromBytes(RCT_H).multiplyUnsafe(tx.fee);
    for (const commitment of tx.outPk) rhs = rhs.add(Point.fromBytes(fromHex(commitment)));
    expect(lhs.equals(rhs)).toBe(true);

    expect(scanAsWallet(receiver, tx)[0]!.amount).toBe(payment);
  });
});

describe('signing a dummy-padded spend', () => {
  it('signs a payment plus a zero-amount self output, both scannable', () => {
    /* An exact-amount send: one real payment, padded to two outputs by a
     * zero-amount output to the sender, the way the wallet assembler pads it. */
    const payment = 900_000_000_000n;
    const fee = 720_000_000n;
    const funded = fundSender(payment + fee, 1, 0xd00d);
    const realPosition = 3;
    const set = unsignedSet({
      inputs: [{
        txPublicKey: funded.txPublicKey,
        indexInTx: funded.indexInTx,
        globalIndex: 1_000_000 + realPosition * 7,
        amount: funded.amount.toString(),
        ring: ringAround(funded, realPosition, 0xab00),
        realPosition,
      }],
      outputs: [
        { address: receiver.address, amount: payment.toString(), change: false },
        { address: sender.address, amount: '0', change: true, dummy: true },
      ],
      fee: fee.toString(),
    });
    const result = signMoneroSpend(sender, set, randomsFor(set, 0x2020));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tx = readTx(result.tx.hex, set.ringSize);

    /* The balance closes with a zero-value output in the mix. */
    let lhs = Point.ZERO;
    for (const pseudo of tx.pseudoOuts) lhs = lhs.add(Point.fromBytes(fromHex(pseudo)));
    let rhs = Point.fromBytes(RCT_H).multiplyUnsafe(tx.fee);
    for (const commitment of tx.outPk) rhs = rhs.add(Point.fromBytes(fromHex(commitment)));
    expect(lhs.equals(rhs)).toBe(true);

    /* The range proof covers both outputs, zero included. */
    expect(verifyBulletproofPlus(tx.outPk, tx.bpp)).toBe(true);

    /* The receiver gets the payment; the sender finds the zero-amount pad. */
    expect(scanAsWallet(receiver, tx)[0]!.amount).toBe(payment);
    const mine = scanAsWallet(sender, tx);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.amount).toBe(0n);
  });
});

describe('the refusals that keep a signature honest', () => {
  it('refuses a set for a different network than the wallet', () => {
    const set = unsignedSet({ network: 'mainnet' });
    const result = signMoneroSpend(sender, set, randomsFor(set));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/network/);
  });

  it('refuses a set that does not balance', () => {
    const set = unsignedSet({ fee: (FEE + 1n).toString() });
    const result = signMoneroSpend(sender, set, randomsFor(set));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/balance/);
  });

  it('refuses an input that does not derive from this vault', () => {
    const set = unsignedSet();
    const stranger = walletFromSeed(detBytes(0xdead), 'stagenet');
    const result = signMoneroSpend(stranger, set, randomsFor(set));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/derive/);
  });

  it('refuses an input whose claimed amount is not the on-chain amount', () => {
    const set = unsignedSet();
    /* One piconero more than the chain committed to: adjust output so the sums
     * still balance, which leaves only the recommitment check to catch it. */
    set.inputs[0]!.amount = (FUNDED + 1n).toString();
    set.outputs[1]!.amount = (CHANGE + 1n).toString();
    const result = signMoneroSpend(sender, set, randomsFor(set));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/recommit|lie/);
  });

  it('refuses a subaddress destination rather than guessing its math', () => {
    /* A syntactically valid stagenet subaddress: prefix 36, real keys. */
    const body = new Uint8Array(65);
    body[0] = 36;
    body.set(fromHex(receiver.spendPublic), 1);
    body.set(fromHex(receiver.viewPublic), 33);
    const checksum = addressChecksum(body);
    const address = base58Encode(new Uint8Array([...body, ...checksum]));
    const set = unsignedSet();
    set.outputs[0] = { ...set.outputs[0]!, address };
    const result = signMoneroSpend(sender, set, randomsFor(set));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/subaddress/);
  });

  it('refuses the wrong amount of randomness', () => {
    const set = unsignedSet();
    const result = signMoneroSpend(sender, set, randomsFor(set).slice(1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/random/);
  });
});

describe('parsing the unsigned set', () => {
  const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

  it('round-trips a valid set', () => {
    const set = unsignedSet();
    const parsed = parseUnsignedSet(encode(set));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.set).toEqual(set);
  });

  it('refuses garbage, the wrong chain, the wrong version', () => {
    expect(parseUnsignedSet(new Uint8Array([0x7b])).ok).toBe(false);
    expect(parseUnsignedSet(encode({ ...unsignedSet(), chain: 'btc' })).ok).toBe(false);
    expect(parseUnsignedSet(encode({ ...unsignedSet(), v: 99 })).ok).toBe(false);
  });

  it('refuses a ring of the wrong size and a real position outside it', () => {
    const short = unsignedSet();
    short.inputs[0]!.ring = short.inputs[0]!.ring.slice(0, 15);
    expect(parseUnsignedSet(encode(short)).ok).toBe(false);

    const outside = unsignedSet();
    outside.inputs[0]!.realPosition = 16;
    expect(parseUnsignedSet(encode(outside)).ok).toBe(false);
  });

  it('refuses amounts that are not decimal strings under 2^64', () => {
    const bad = unsignedSet() as unknown as Record<string, unknown>;
    (bad['outputs'] as { amount: unknown }[])[0]!.amount = 123;
    expect(parseUnsignedSet(encode(bad)).ok).toBe(false);
    const huge = unsignedSet();
    huge.outputs[0]!.amount = (2n ** 64n).toString();
    expect(parseUnsignedSet(encode(huge)).ok).toBe(false);
  });
});
