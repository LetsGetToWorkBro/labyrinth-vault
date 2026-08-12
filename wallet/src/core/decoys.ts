/**
 * Decoys: hiding each real input in a ring, chosen the way Monero chooses.
 *
 * ## Why this is not "pick some random outputs"
 *
 * A Monero spend signs over a ring: the real output plus fifteen decoys, and
 * the signature reveals nothing about which of the sixteen is real. That
 * anonymity is only as good as the decoys. If they were drawn uniformly at
 * random from all outputs ever made, the real one would stand out, because
 * real spends cluster on recent outputs while a uniform draw does not. Chain
 * analysis lives in exactly that gap.
 *
 * So Monero draws decoys from a distribution shaped like real spending: a
 * gamma distribution over output age, with the parameters the Monero Research
 * Lab measured from the chain. This file reproduces that. Getting it wrong
 * does not lose money and does not get a transaction rejected, because the
 * network does not check how decoys were chosen. It costs *privacy*, quietly,
 * which is the one failure this product is least willing to ship in silence.
 *
 * ## The honest limit
 *
 * This matches wallet2's core algorithm: the gamma over age, the conversion to
 * a global output index through the real distribution, the exclusion of
 * outputs too recent to be spendable, distinct members, the real one included.
 * What it approximates is wallet2's fine print: the recent-output "zone" that
 * biases a fraction of picks toward the last few days, and blackball lists of
 * known-spent outputs. Those refine the distribution further; their absence
 * makes a ring slightly less like wallet2's, not detectably homemade, and it
 * is written down here rather than hidden. `docs/monero-send.md` carries it.
 *
 * ## Randomness is an argument
 *
 * Every function here takes its uniform randomness as a `() => number` in
 * [0, 1), so tests are deterministic and reproducible. The app passes a source
 * backed by the platform CSPRNG. Nothing here calls `Math.random` itself: a
 * ring built from a weak PRNG is a deanonymized ring.
 */

import type { OutputDistribution } from '../net/monerod';

/** The gamma shape the Monero Research Lab fit to real spend ages. */
export const GAMMA_SHAPE = 19.28;
/** The gamma scale, as `1 / rate`. wallet2 stores the rate, 1.61. */
export const GAMMA_SCALE = 1 / 1.61;

/** Seconds per block since the second hard fork; the age-to-block conversion. */
export const DIFFICULTY_TARGET = 120;

/** Blocks an output must age before it may be spent. Consensus, not taste. */
export const SPENDABLE_AGE = 10;

/** The ring size the network currently requires: one real, fifteen decoys. */
export const RING_SIZE = 16;

/**
 * A gamma sample, by Marsaglia and Tsang's method.
 *
 * Valid for shape ≥ 1, which 19.28 is, so the method applies directly with no
 * boosting. Two uniforms per inner attempt: one shaped into a normal by
 * Box-Muller, one for the acceptance test. Loops until it accepts, which for
 * this shape is almost always the first try.
 */
export function sampleGamma(uniform: () => number): number {
  const d = GAMMA_SHAPE - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0;
    let v = 0;
    do {
      // Box-Muller for a standard normal.
      const u1 = Math.max(uniform(), 1e-12);
      const u2 = uniform();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.max(uniform(), 1e-12);
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * GAMMA_SCALE;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * GAMMA_SCALE;
  }
}

/**
 * The selectable output distribution, reduced to what the picker needs.
 *
 * `cumulative[i]` is the total RingCT outputs up to block `startHeight + i`.
 * `spendableCount` is how many of those are old enough to spend, which is the
 * count up to `SPENDABLE_AGE` blocks before the tip. `pick` never returns an
 * index at or past that, because an unspendable decoy makes a ring the network
 * cannot verify and a real output the network will not yet let you spend.
 */
export interface Picker {
  cumulative: number[];
  startHeight: number;
  spendableCount: number;
  /** The block, in `cumulative` coordinates, of a global output index. */
  blockOf(globalIndex: number): number;
}

export function makePicker(dist: OutputDistribution, tipHeight: number): Picker | null {
  const { cumulative, startHeight } = dist;
  if (cumulative.length < 2) return null;

  /* The most recent block whose outputs are spendable. Everything newer is
   * inside the lock window and excluded from selection. */
  const newestSpendableHeight = tipHeight - SPENDABLE_AGE;
  const idx = newestSpendableHeight - startHeight;
  if (idx < 1 || idx >= cumulative.length) return null;
  const spendableCount = cumulative[idx]!;
  if (spendableCount <= 0) return null;

  return {
    cumulative,
    startHeight,
    spendableCount,
    blockOf(globalIndex: number): number {
      // Binary search for the first block whose cumulative total exceeds the
      // index: that block is where the output lives.
      let lo = 0;
      let hi = cumulative.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulative[mid]! <= globalIndex) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
  };
}

/**
 * One decoy's global output index, drawn from the gamma over age.
 *
 * The path, which is wallet2's: sample a gamma, exponentiate it into an age in
 * seconds, divide by the average time between outputs to get how many outputs
 * back from the spendable tip, and convert that to a global index. Then, to
 * respect that outputs cluster unevenly across blocks, land in the chosen
 * block and pick uniformly among its outputs rather than taking the index
 * directly. Returns null when the draw falls outside the chain, which the
 * caller answers by drawing again.
 */
export function pickOne(picker: Picker, uniform: () => number): number | null {
  const { cumulative, spendableCount } = picker;
  const outputs = spendableCount;
  if (outputs <= 1) return null;

  // Average seconds per output across the spendable range.
  const spannedBlocks = picker.blockOf(outputs - 1) + 1;
  const averageOutputTime = (DIFFICULTY_TARGET * spannedBlocks) / outputs;
  if (!(averageOutputTime > 0)) return null;

  const age = Math.exp(sampleGamma(uniform));
  let outputsBack = Math.floor(age / averageOutputTime);
  if (outputsBack >= outputs) return null; // older than the chain; redraw
  if (outputsBack < 0) outputsBack = 0;

  const targetIndex = outputs - 1 - outputsBack;
  const block = picker.blockOf(targetIndex);
  const blockStart = block === 0 ? 0 : cumulative[block - 1]!;
  const blockEnd = cumulative[block]!;
  const inBlock = blockEnd - blockStart;
  if (inBlock <= 0) return null;

  // Uniform within the block, so denser blocks are not under-weighted.
  const offset = Math.min(inBlock - 1, Math.floor(uniform() * inBlock));
  const chosen = blockStart + offset;
  return chosen < spendableCount ? chosen : null;
}

export interface RingSelection {
  ok: boolean;
  problem: string | null;
  /** Global output indices, sorted ascending, the real one among them. */
  indices: number[];
  /** Where the real output ended up after sorting. */
  realPosition: number;
}

/**
 * Choose the whole ring for one real output.
 *
 * The real index goes in, `RING_SIZE − 1` decoys are drawn distinct from it and
 * from each other, and the result is sorted, because the ring's order on the
 * wire must not reveal which one was inserted. The real one's position after
 * sorting is reported so the signer knows its secret index.
 *
 * A bounded number of attempts, because the gamma can keep landing on the same
 * popular recent outputs; if it cannot fill a distinct ring it says so rather
 * than loop, and the caller reports a chain too small to hide in, which is a
 * real condition on a fresh testnet.
 */
export function selectRing(
  picker: Picker,
  realIndex: number,
  uniform: () => number,
  ringSize = RING_SIZE,
): RingSelection {
  const fail = (problem: string): RingSelection => ({ ok: false, problem, indices: [], realPosition: -1 });

  if (realIndex < 0 || realIndex >= picker.spendableCount) {
    return fail('That output is not spendable yet, so it cannot anchor a ring.');
  }
  if (picker.spendableCount < ringSize) {
    return fail('This chain does not have enough spendable outputs to build a ring. It is too small to hide in.');
  }

  const chosen = new Set<number>([realIndex]);
  let attempts = 0;
  const maxAttempts = ringSize * 400;
  while (chosen.size < ringSize && attempts < maxAttempts) {
    attempts += 1;
    const pick = pickOne(picker, uniform);
    if (pick !== null && !chosen.has(pick)) chosen.add(pick);
  }
  if (chosen.size < ringSize) {
    return fail('Could not find enough distinct decoys for a ring. The spendable set is too clustered.');
  }

  const indices = [...chosen].sort((a, b) => a - b);
  return { ok: true, problem: null, indices, realPosition: indices.indexOf(realIndex) };
}
