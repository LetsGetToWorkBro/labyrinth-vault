/**
 * The wire format, checked the only way that counts: against real txids.
 *
 * `test/fixtures/monero-raw-tx.json` is three real mainnet transactions,
 * parsed to fields by a block explorer. Serializing those fields back must
 * reproduce each transaction's id, because the id is the Keccak of the
 * serialized sections. There is no partial credit in that check: one byte off
 * anywhere in the prefix, the base, or the prunable section and the id is
 * garbage. Three transactions cover one and two inputs, two and three
 * outputs, and every field kind the builder will ever emit.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { keccak_256 as keccakOf } from '@noble/hashes/sha3.js';
import type { BulletproofPlus } from '../src/keys/bulletproofplus';
import {
  absoluteToRelative,
  assembleRawTransaction,
  preClsagHash,
  serializePrefix,
  serializeRctBase,
  serializeRctPrunable,
  transactionId,
  transactionWeight,
  varintBytes,
  type WirePrefix,
} from '../src/keys/monerowire';
import { fromHex, toHex } from '../src/keys/monero';

interface RawFixture {
  txid: string;
  version: number;
  unlock_time: number;
  extra: string;
  vin: { key_offsets: number[]; k_image: string }[];
  vout: { key: string; view_tag: string }[];
  rct: { type: number; txnFee: number; ecdh: string[]; outPk: string[] };
  prunable: {
    bpp: BulletproofPlus[];
    CLSAGs: { s: string[]; c1: string; D: string }[];
    pseudoOuts: string[];
  };
}

const fixtures: { txs: RawFixture[] } = JSON.parse(
  readFileSync('test/fixtures/monero-raw-tx.json', 'utf8'),
);

function partsOf(tx: RawFixture) {
  const prefix: WirePrefix = {
    version: tx.version,
    unlockTime: tx.unlock_time,
    inputs: tx.vin.map((v) => ({ keyOffsets: v.key_offsets, keyImage: v.k_image })),
    outputs: tx.vout.map((o) => ({ key: o.key, viewTag: o.view_tag })),
    extra: tx.extra,
  };
  const base = { fee: BigInt(tx.rct.txnFee), ecdhAmounts: tx.rct.ecdh, outPk: tx.rct.outPk };
  const prunable = { bpp: tx.prunable.bpp, clsags: tx.prunable.CLSAGs, pseudoOuts: tx.prunable.pseudoOuts };
  return { prefix, base, prunable };
}

describe('varint', () => {
  it('encodes the boundary values the way the chain does', () => {
    expect(toHex(varintBytes(0))).toBe('00');
    expect(toHex(varintBytes(127))).toBe('7f');
    expect(toHex(varintBytes(128))).toBe('8001');
    expect(toHex(varintBytes(2n ** 64n - 1n))).toBe('ffffffffffffffffff01');
  });
  it('refuses a negative', () => {
    expect(() => varintBytes(-1)).toThrow();
  });
});

describe('relative offsets', () => {
  it('turns sorted absolute indices into wire offsets and back', () => {
    expect(absoluteToRelative([5, 7, 20])).toEqual([5, 2, 13]);
  });
  it('refuses unsorted indices rather than emitting a ring the node rejects', () => {
    expect(() => absoluteToRelative([7, 5])).toThrow(/sorted/);
  });
});

describe('serialization against real transaction ids', () => {
  for (const tx of fixtures.txs) {
    it(`reproduces ${tx.txid.slice(0, 12)} (${tx.vin.length} in, ${tx.vout.length} out) byte for byte`, () => {
      const { prefix, base, prunable } = partsOf(tx);
      const assembled = assembleRawTransaction(prefix, base, prunable);
      expect(assembled.txid).toBe(tx.txid);
      /* And the sections individually, so a future failure points at one. */
      expect(
        transactionId(serializePrefix(prefix), serializeRctBase(base), serializeRctPrunable(prunable)),
      ).toBe(tx.txid);
    });
  }

  it('any disturbed field ruins the id', () => {
    const tx = fixtures.txs[0]!;
    const { prefix, base, prunable } = partsOf(tx);

    const laterUnlock = { ...prefix, unlockTime: 1 };
    expect(assembleRawTransaction(laterUnlock, base, prunable).txid).not.toBe(tx.txid);

    const higherFee = { ...base, fee: base.fee + 1n };
    expect(assembleRawTransaction(prefix, higherFee, prunable).txid).not.toBe(tx.txid);

    const swappedPseudo = { ...prunable, pseudoOuts: [...prunable.pseudoOuts].reverse() };
    if (prunable.pseudoOuts.length > 1) {
      expect(assembleRawTransaction(prefix, base, swappedPseudo).txid).not.toBe(tx.txid);
    }
  });
});

describe('transaction weight against real transactions', () => {
  for (const tx of fixtures.txs) {
    it(`weighs ${tx.txid.slice(0, 12)} (${tx.vout.length} out) as bytes plus the exact clawback`, () => {
      const { prefix, base, prunable } = partsOf(tx);
      const assembled = assembleRawTransaction(prefix, base, prunable);
      const bytes = fromHex(assembled.hex).length;
      /* Two outputs: weight is exactly the byte size. Three: the byte size plus
       * a positive clawback, and never less than the raw size. */
      if (tx.vout.length <= 2) {
        expect(assembled.weight).toBe(bytes);
      } else {
        expect(assembled.weight).toBeGreaterThan(bytes);
      }
      expect(assembled.weight).toBe(transactionWeight(bytes, tx.vout.length));
    });
  }

  it('computes the clawback the way the source does', () => {
    /* Three outputs (padded to four): (320*4 - 704)*4/5 = 460 over the bytes. */
    expect(transactionWeight(1000, 3)).toBe(1000 + 460);
    /* Four outputs sit in the same padded proof, same clawback. */
    expect(transactionWeight(1000, 4)).toBe(1000 + 460);
    /* Two or fewer: no surcharge. */
    expect(transactionWeight(1000, 2)).toBe(1000);
    expect(transactionWeight(1000, 1)).toBe(1000);
  });
});

describe('the message the ring signatures sign', () => {
  it('is welded to all three sections', () => {
    const tx = fixtures.txs[0]!;
    const { prefix, base, prunable } = partsOf(tx);
    const prefixBytes = serializePrefix(prefix);
    const baseBytes = serializeRctBase(base);
    const message = preClsagHash(keccakOf(prefixBytes), baseBytes, prunable.bpp);
    expect(message).toHaveLength(32);

    /* A different fee changes the base, which must change the message. */
    const withHigherFee = serializeRctBase({ ...base, fee: base.fee + 1n });
    const other = preClsagHash(keccakOf(prefixBytes), withHigherFee, prunable.bpp);
    expect(toHex(other)).not.toBe(toHex(message));

    /* A different range proof must change it too. */
    const tampered = [{ ...prunable.bpp[0]!, d1: prunable.bpp[0]!.r1 }];
    const third = preClsagHash(keccakOf(prefixBytes), baseBytes, tampered);
    expect(toHex(third)).not.toBe(toHex(message));
  });
});
