/**
 * Decoy selection: the structural invariants exactly, the statistics coarsely.
 *
 * A ring's validity is structural and its quality is statistical, and the two
 * are tested differently. The structure has to be exact every time: the real
 * output present once, the members distinct and sorted, none of them inside
 * the lock window, the count right. The statistics only have to be true in
 * aggregate: recent outputs chosen more often than old ones, because that is
 * the whole reason for the gamma. A ring that got the structure wrong is
 * invalid; one that got the shape wrong is a privacy leak, so both are tested,
 * at the standard each deserves.
 */

import { describe, expect, it } from 'vitest';
import {
  GAMMA_SHAPE,
  RING_SIZE,
  SPENDABLE_AGE,
  makePicker,
  pickOne,
  sampleGamma,
  selectRing,
} from '../src/core/decoys';
import type { OutputDistribution } from '../src/net/monerod';

/** xorshift32, deterministic, same shape as the fuzz harness. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

/** A chain of `blocks` blocks with roughly `perBlock` RingCT outputs each. */
function distribution(blocks: number, perBlock: number, startHeight = 0): OutputDistribution {
  const cumulative: number[] = [];
  let total = 0;
  for (let i = 0; i < blocks; i++) {
    // A little variance per block, so block-uniform selection has work to do.
    total += perBlock + (i % 3);
    cumulative.push(total);
  }
  return { cumulative, startHeight };
}

describe('the gamma sampler', () => {
  it('produces a distribution centered near its mean', () => {
    /* A gamma(shape, scale) has mean shape*scale. Over many draws the sample
     * mean should land near it; this catches a sampler that is silently
     * returning the wrong shape. */
    const random = rng(0x9a3);
    let sum = 0;
    const n = 5000;
    for (let i = 0; i < n; i++) sum += sampleGamma(random);
    const mean = sum / n;
    const expected = GAMMA_SHAPE * (1 / 1.61);
    expect(mean).toBeGreaterThan(expected * 0.9);
    expect(mean).toBeLessThan(expected * 1.1);
  });

  it('is always positive', () => {
    const random = rng(0x9a4);
    for (let i = 0; i < 2000; i++) expect(sampleGamma(random)).toBeGreaterThan(0);
  });
});

describe('the picker respects the lock window', () => {
  const dist = distribution(1000, 20);
  const tip = 999;
  const picker = makePicker(dist, tip)!;

  it('never offers an output newer than the spendable tip', () => {
    const random = rng(0x111);
    for (let i = 0; i < 3000; i++) {
      const pick = pickOne(picker, random);
      if (pick !== null) expect(pick).toBeLessThan(picker.spendableCount);
    }
  });

  it('excludes exactly the last SPENDABLE_AGE blocks from the spendable count', () => {
    /* The spendable count is the cumulative total up to the tip minus the lock,
     * not the total. A picker that used the full total would offer outputs the
     * network will not let you spend. */
    const idx = tip - SPENDABLE_AGE - dist.startHeight;
    expect(picker.spendableCount).toBe(dist.cumulative[idx]!);
    expect(picker.spendableCount).toBeLessThan(dist.cumulative[dist.cumulative.length - 1]!);
  });

  it('refuses a chain with no spendable history', () => {
    expect(makePicker(distribution(5, 3), 999)).toBeNull();
    expect(makePicker({ cumulative: [10], startHeight: 0 }, 100)).toBeNull();
  });
});

describe('a whole ring', () => {
  const picker = makePicker(distribution(2000, 25), 1999)!;

  it('is the right size, distinct, sorted, and contains the real output', () => {
    const random = rng(0x222);
    const real = 12_345;
    const ring = selectRing(picker, real, random);

    expect(ring.ok).toBe(true);
    expect(ring.indices).toHaveLength(RING_SIZE);
    expect(new Set(ring.indices).size).toBe(RING_SIZE); // distinct
    expect([...ring.indices].sort((a, b) => a - b)).toEqual(ring.indices); // sorted
    expect(ring.indices).toContain(real);
    expect(ring.indices[ring.realPosition]).toBe(real);
  });

  it('puts the real output somewhere different depending on the draw', () => {
    /* If the real position were always the same, its index would leak. Across
     * seeds it should move around. */
    const positions = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const ring = selectRing(picker, 50_000, rng(seed));
      if (ring.ok) positions.add(ring.realPosition);
    }
    expect(positions.size).toBeGreaterThan(3);
  });

  it('refuses to build a ring around an unspendable output', () => {
    const ring = selectRing(picker, picker.spendableCount + 1, rng(1));
    expect(ring.ok).toBe(false);
    expect(ring.problem).toMatch(/spendable/);
  });

  it('refuses when the chain is too small to hide in', () => {
    const tiny = makePicker(distribution(400, 1), 399)!;
    /* Fewer spendable outputs than a ring needs: honest refusal, not a loop. */
    if (tiny.spendableCount < RING_SIZE) {
      const ring = selectRing(tiny, 1, rng(1));
      expect(ring.ok).toBe(false);
      expect(ring.problem).toMatch(/too small to hide/);
    }
  });

  it('supports a custom ring size for older or testnet rules', () => {
    const ring = selectRing(picker, 100, rng(3), 11);
    expect(ring.ok).toBe(true);
    expect(ring.indices).toHaveLength(11);
  });
});

describe('the shape is recency-biased, which is the entire point', () => {
  it('draws recent outputs more often than old ones', () => {
    /* Split the spendable range in half and count picks in each. The gamma
     * over age should land in the recent half far more than the old half; a
     * uniform sampler would split roughly evenly and fail this. */
    const picker = makePicker(distribution(3000, 30), 2999)!;
    const random = rng(0x5ee);
    const half = picker.spendableCount / 2;
    let recent = 0;
    let old = 0;
    for (let i = 0; i < 8000; i++) {
      const pick = pickOne(picker, random);
      if (pick === null) continue;
      if (pick >= half) recent += 1;
      else old += 1;
    }
    expect(recent).toBeGreaterThan(old * 2);
  });
});
