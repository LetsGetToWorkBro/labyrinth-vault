/**
 * The swap memory, and the journey it draws.
 *
 * Two halves. `parsePendingSwap` is a persistence door, so it gets the
 * persistence treatment: one test per way a stored record can lie, each
 * dropped whole rather than repaired. `journeyOf` is the status screen's
 * spine, so what is pinned is the honesty rules: the words come from
 * STAGE_LINES and nowhere else, progress is only what the provider confirmed,
 * and a terminal state freezes the road rather than guessing how far the
 * money got.
 */

import { describe, expect, it } from 'vitest';
import { JOURNEY_STAGES, journeyOf, parsePendingSwap, type PendingSwap } from '../src/core/swaptrack';
import { STAGE_LINES, type SwapStage } from '../src/core/swap';

const GOOD: PendingSwap = {
  provider: 'exolix',
  id: 'demo-exolix-4417',
  fromId: 'btc',
  toId: 'xmr',
  fromAmount: 0.05,
  toAmount: 7.62,
  createdAt: 1_700_000_000_000,
};

describe('reading a stored swap back', () => {
  it('accepts what it wrote', () => {
    expect(parsePendingSwap({ ...GOOD })).toEqual(GOOD);
  });

  it('drops the shapes JSON can hold that are not records', () => {
    expect(parsePendingSwap(null)).toBeNull();
    expect(parsePendingSwap(undefined)).toBeNull();
    expect(parsePendingSwap('a string')).toBeNull();
    expect(parsePendingSwap([1, 2, 3])).toBeNull();
  });

  it('drops a provider this build does not speak to', () => {
    expect(parsePendingSwap({ ...GOOD, provider: 'changenow' })).toBeNull();
    expect(parsePendingSwap({ ...GOOD, provider: 7 })).toBeNull();
  });

  it('drops an order id that is empty or would not fit in a URL politely', () => {
    expect(parsePendingSwap({ ...GOOD, id: '' })).toBeNull();
    expect(parsePendingSwap({ ...GOOD, id: 'x'.repeat(129) })).toBeNull();
    expect(parsePendingSwap({ ...GOOD, id: 'x'.repeat(128) })).not.toBeNull();
  });

  it('drops a coin this build does not list', () => {
    expect(parsePendingSwap({ ...GOOD, fromId: 'doge' })).toBeNull();
    expect(parsePendingSwap({ ...GOOD, toId: 'doge' })).toBeNull();
  });

  it('drops amounts that are not positive finite numbers', () => {
    expect(parsePendingSwap({ ...GOOD, fromAmount: 0 })).toBeNull();
    expect(parsePendingSwap({ ...GOOD, fromAmount: -1 })).toBeNull();
    expect(parsePendingSwap({ ...GOOD, toAmount: Number.NaN })).toBeNull();
    /* Typed, not coerced: JSON writes NaN as null, and Number(null) is 0. */
    expect(parsePendingSwap({ ...GOOD, toAmount: null })).toBeNull();
    expect(parsePendingSwap({ ...GOOD, toAmount: '7.62' })).toBeNull();
  });

  it('drops a timestamp from before time began', () => {
    expect(parsePendingSwap({ ...GOOD, createdAt: -5 })).toBeNull();
    expect(parsePendingSwap({ ...GOOD, createdAt: 'yesterday' })).toBeNull();
  });
});

describe('the journey a status lands on', () => {
  it('walks the road in order, with the words STAGE_LINES uses', () => {
    for (const [index, stage] of JOURNEY_STAGES.entries()) {
      const journey = journeyOf(stage);
      expect(journey.steps.map((step) => step.stage)).toEqual([...JOURNEY_STAGES]);
      expect(journey.steps.map((step) => step.label)).toEqual(
        JOURNEY_STAGES.map((s) => STAGE_LINES[s]),
      );
      expect(journey.steps[index]!.state).toBe('current');
      expect(journey.steps.filter((step) => step.state === 'done')).toHaveLength(index);
      expect(journey.ended).toBeNull();
    }
  });

  it('counts confirmed ground only', () => {
    expect(journeyOf('waiting').reached).toBe(0);
    expect(journeyOf('exchanging').reached).toBe(2);
    expect(journeyOf('done').reached).toBe(JOURNEY_STAGES.length);
  });

  it('is in flight until it is done', () => {
    expect(journeyOf('waiting').inFlight).toBe(true);
    expect(journeyOf('sending').inFlight).toBe(true);
    expect(journeyOf('done').inFlight).toBe(false);
  });

  it('freezes rather than guesses when the road ends early', () => {
    for (const ended of ['refunded', 'expired', 'failed'] as const) {
      const journey = journeyOf(ended as SwapStage);
      expect(journey.ended).toBe(ended);
      expect(journey.inFlight).toBe(false);
      expect(journey.reached).toBe(0);
      /* No lit trail to an invented point: every step reads as untraveled,
       * and the screen says where it ended in the provider's own words. */
      expect(journey.steps.every((step) => step.state === 'ahead')).toBe(true);
    }
  });
});
