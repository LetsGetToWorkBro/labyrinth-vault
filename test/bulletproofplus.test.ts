/**
 * Bulletproof+ verification, checked against consensus.
 *
 * The three fixtures in `test/fixtures/bulletproof-plus.json` are real
 * Bulletproof+ range proofs pulled from mainnet transactions, with their output
 * commitments. A network of thousands of nodes accepted every one of them, so
 * "this verifier accepts them" is the claim that it agrees with consensus about
 * what a valid range proof is. The adversarial half is the other side of the
 * same claim: disturbing any field of a proof, or a commitment it is over, must
 * make it reject, because a verifier that accepts a tampered proof is worse than
 * one that rejects a valid one.
 *
 * This is the anchor described at the top of `src/keys/bulletproofplus.ts`, and
 * it is why that file could be transcribed from `bulletproofs_plus.cc` with any
 * confidence: three real proofs are a stronger oracle than a round trip against
 * a prover written by the same hand.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyBulletproofPlus, type BulletproofPlus } from '../src/keys/bulletproofplus';

interface Fixture {
  txid: string;
  nout: number;
  outPk: string[];
  txnFee: number;
  bpp: BulletproofPlus;
}

const fixtures: { txs: Fixture[] } = JSON.parse(
  readFileSync('test/fixtures/bulletproof-plus.json', 'utf8'),
);

/** Flip the last byte of a 32-byte hex string, keeping it valid hex. */
function bump(hex: string): string {
  const last = parseInt(hex.slice(-2), 16);
  return hex.slice(0, -2) + ((last ^ 0x01) & 0xff).toString(16).padStart(2, '0');
}

function clone(bpp: BulletproofPlus): BulletproofPlus {
  return { ...bpp, L: [...bpp.L], R: [...bpp.R] };
}

describe('Bulletproof+ against real mainnet proofs', () => {
  it('has fixtures with the shape it expects', () => {
    expect(fixtures.txs.length).toBeGreaterThanOrEqual(3);
    for (const tx of fixtures.txs) {
      expect(tx.outPk).toHaveLength(tx.nout);
      // 6 base rounds plus logM (M smallest power of two >= nout).
      const logM = Math.ceil(Math.log2(tx.nout));
      expect(tx.bpp.L).toHaveLength(6 + logM);
      expect(tx.bpp.R).toHaveLength(6 + logM);
    }
  });

  for (const tx of fixtures.txs) {
    it(`accepts ${tx.txid.slice(0, 12)} (${tx.nout} outputs)`, () => {
      expect(verifyBulletproofPlus(tx.outPk, tx.bpp)).toBe(true);
    });
  }
});

describe('Bulletproof+ rejects every tamper', () => {
  const tx = fixtures.txs[0]!;

  it('rejects a disturbed commitment', () => {
    const outPk = [...tx.outPk];
    outPk[0] = bump(outPk[0]!);
    expect(verifyBulletproofPlus(outPk, tx.bpp)).toBe(false);
  });

  it('rejects a commitment removed from the set', () => {
    expect(verifyBulletproofPlus(tx.outPk.slice(1), tx.bpp)).toBe(false);
  });

  it('rejects the commitments in the wrong order', () => {
    const reversed = [...tx.outPk].reverse();
    expect(verifyBulletproofPlus(reversed, tx.bpp)).toBe(false);
  });

  for (const field of ['A', 'A1', 'B', 'r1', 's1', 'd1'] as const) {
    it(`rejects a disturbed ${field}`, () => {
      const bpp = clone(tx.bpp);
      bpp[field] = bump(bpp[field]);
      expect(verifyBulletproofPlus(tx.outPk, bpp)).toBe(false);
    });
  }

  it('rejects a disturbed inner-product L term', () => {
    const bpp = clone(tx.bpp);
    bpp.L[0] = bump(bpp.L[0]!);
    expect(verifyBulletproofPlus(tx.outPk, bpp)).toBe(false);
  });

  it('rejects a disturbed inner-product R term', () => {
    const bpp = clone(tx.bpp);
    bpp.R[bpp.R.length - 1] = bump(bpp.R[bpp.R.length - 1]!);
    expect(verifyBulletproofPlus(tx.outPk, bpp)).toBe(false);
  });

  it('rejects L and R swapped', () => {
    const bpp = clone(tx.bpp);
    [bpp.L, bpp.R] = [bpp.R, bpp.L];
    expect(verifyBulletproofPlus(tx.outPk, bpp)).toBe(false);
  });

  it('rejects a proof from one transaction against the wrong commitments', () => {
    const other = fixtures.txs[1]!;
    expect(verifyBulletproofPlus(tx.outPk, other.bpp)).toBe(false);
    expect(verifyBulletproofPlus(other.outPk, tx.bpp)).toBe(false);
  });

  it('rejects an empty commitment set', () => {
    expect(verifyBulletproofPlus([], tx.bpp)).toBe(false);
  });
});
