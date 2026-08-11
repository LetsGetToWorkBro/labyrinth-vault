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

// ---------------------------------------------------------------------------
// The prover, checked against the anchored verifier
// ---------------------------------------------------------------------------

/* The verifier above agrees with consensus on real proofs. So a proof this
 * prover makes that this verifier accepts is a proof the network would accept,
 * which is the entire reason the verifier was anchored first: the prover is
 * never checked against itself. */

import { ed25519 } from '@noble/curves/ed25519.js';
import { proveBulletproofPlus, bppRandomCount } from '../src/keys/bulletproofplus';
import { commit } from '../src/keys/monerocrypto';
import { fromHex, toHex } from '../src/keys/monero';

/** Deterministic 32 bytes, reduced small so it is a valid scalar. */
function detScalar(seed: number): Uint8Array {
  const b = new Uint8Array(32);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < 32; i++) { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; b[i] = x & 0xff; }
  b[31] = b[31]! & 0x0f;
  return b;
}

function randoms(n: number, seed: number): Uint8Array[] {
  return Array.from({ length: bppRandomCount(n) }, (_, i) => detScalar(seed + i));
}

/** outPk from the proof's offset V: the network's own 8·V relation. */
function outPkOf(V: readonly string[]): string[] {
  return V.map((v) => toHex(ed25519.Point.fromBytes(fromHex(v)).multiplyUnsafe(8n).toBytes()));
}

describe('Bulletproof+ prover against the anchored verifier', () => {
  const cases: { name: string; amounts: bigint[] }[] = [
    { name: 'one amount', amounts: [1_000_000_000_000n] },
    { name: 'two amounts (a real spend: payment and change)', amounts: [750_000_000_000n, 249_289_920_000n] },
    { name: 'three amounts', amounts: [1n, 2n, 3n] },
    { name: 'zero, which real change sometimes is', amounts: [0n, 5n] },
    { name: 'the largest 64-bit amount', amounts: [2n ** 64n - 1n] },
    { name: 'five amounts, padding M to eight', amounts: [10n, 20n, 30n, 40n, 50n] },
  ];

  for (const { name, amounts } of cases) {
    // MN grows with the amount count, and this is plain JavaScript arithmetic
    // sharing a loaded CI worker, hence the generous ceiling.
    it(`proves and verifies ${name}`, { timeout: 90_000 }, () => {
      const masks = amounts.map((_, i) => detScalar(7000 + i));
      const { proof, V } = proveBulletproofPlus(amounts, masks, randoms(amounts.length, 9000));
      expect(verifyBulletproofPlus(outPkOf(V), proof)).toBe(true);
    });
  }

  it('commits exactly what commit() commits: outPk is 8·V is mask·G + amount·H', () => {
    const amounts = [123_456_789n, 42n];
    const masks = amounts.map((_, i) => detScalar(4200 + i));
    const { V } = proveBulletproofPlus(amounts, masks, randoms(amounts.length, 4300));
    const fromProof = outPkOf(V);
    const fromCommit = amounts.map((a, i) => toHex(commit(a, masks[i]!)));
    expect(fromProof).toEqual(fromCommit);
  });

  it('is deterministic given the same randomness', () => {
    const amounts = [999n];
    const masks = [detScalar(1)];
    const a = proveBulletproofPlus(amounts, masks, randoms(1, 5000));
    const b = proveBulletproofPlus(amounts, masks, randoms(1, 5000));
    expect(a).toEqual(b);
  });

  it('produces different proofs from different randomness, over the same commitments', () => {
    const amounts = [999n];
    const masks = [detScalar(1)];
    const a = proveBulletproofPlus(amounts, masks, randoms(1, 5000));
    const b = proveBulletproofPlus(amounts, masks, randoms(1, 6000));
    expect(a.V).toEqual(b.V);
    expect(a.proof.A1).not.toBe(b.proof.A1);
    expect(verifyBulletproofPlus(outPkOf(a.V), a.proof)).toBe(true);
    expect(verifyBulletproofPlus(outPkOf(b.V), b.proof)).toBe(true);
  });

  it('a proof does not verify against the wrong commitments', () => {
    const masksA = [detScalar(11)];
    const masksB = [detScalar(22)];
    const a = proveBulletproofPlus([100n], masksA, randoms(1, 5000));
    const b = proveBulletproofPlus([100n], masksB, randoms(1, 5000));
    expect(verifyBulletproofPlus(outPkOf(b.V), a.proof)).toBe(false);
    expect(verifyBulletproofPlus(outPkOf(a.V), b.proof)).toBe(false);
  });

  it('every field of a fresh proof is load-bearing', () => {
    const { proof, V } = proveBulletproofPlus([77n, 88n], [detScalar(3), detScalar(4)], randoms(2, 8100));
    const outPk = outPkOf(V);
    expect(verifyBulletproofPlus(outPk, proof)).toBe(true);
    for (const field of ['A', 'A1', 'B', 'r1', 's1', 'd1'] as const) {
      const bad = clone(proof);
      bad[field] = bump(bad[field]);
      expect(verifyBulletproofPlus(outPk, bad), field).toBe(false);
    }
    const badL = clone(proof);
    badL.L[2] = bump(badL.L[2]!);
    expect(verifyBulletproofPlus(outPk, badL)).toBe(false);
  });

  it('refuses an amount outside the range instead of proving a lie', () => {
    expect(() => proveBulletproofPlus([2n ** 64n], [detScalar(5)], randoms(1, 100))).toThrow(/range|2\^64/);
    expect(() => proveBulletproofPlus([-1n], [detScalar(5)], randoms(1, 100))).toThrow();
  });

  it('refuses the wrong amount of randomness, because silently reusing any would be worse', () => {
    expect(() => proveBulletproofPlus([1n], [detScalar(5)], randoms(1, 100).slice(1))).toThrow(/random/);
    expect(() => proveBulletproofPlus([], [], [])).toThrow();
    expect(() => proveBulletproofPlus([1n], [], randoms(1, 100))).toThrow(/mask/);
  });

  it('matches the shape the wire expects: 6+logM inner-product rounds', { timeout: 30_000 }, () => {
    const one = proveBulletproofPlus([5n], [detScalar(9)], randoms(1, 300));
    expect(one.proof.L).toHaveLength(6);
    const three = proveBulletproofPlus([5n, 6n, 7n], [detScalar(9), detScalar(10), detScalar(11)], randoms(3, 300));
    expect(three.proof.L).toHaveLength(8);
  });
});
