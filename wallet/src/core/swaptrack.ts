/**
 * Tracking a swap after the handoff, and what that is allowed to cost.
 *
 * Once `depositForSwap` hands the deposit to the send flow, the order used to
 * evaporate: the provider and order id lived in a local variable on a screen
 * that unmounted. `readStatus` existed and nothing could call it, because
 * nothing remembered what to ask about. This module is the memory, and the
 * rules about it:
 *
 * **What is kept is the minimum that makes `readStatus` callable.** The
 * provider, the order id, the two coins and the two amounts as quoted, and
 * when. No addresses: the deposit address is in the send flow where the vault
 * checks it, the payout address is already recorded at the provider, and a
 * copy of either on disk would be one more place an address lives for no
 * check it enables.
 *
 * **One order at a time.** A second swap replaces the first in the record,
 * because this is a memory aid for the screen, not an order book. The
 * provider remains the authority on every order it has ever seen.
 *
 * **Read back as untrusted, like everything in persist.ts.** A stored
 * provider name is checked against the providers this build actually speaks
 * to, a stored coin against the coins it actually lists. A file written by an
 * older build is untrusted input; so is one edited by hand.
 *
 * The journey mapping at the bottom is the presentation's spine: the stages a
 * swap passes through in order, which one a status lands on, and whether the
 * road ended. The words come from `STAGE_LINES`, which is already the one
 * place the app translates a provider's status into a sentence.
 */

import { PROVIDERS, STAGE_LINES, swapCoin, type ProviderId, type SwapStage } from './swap';

// ---------------------------------------------------------------- the record

/** The one swap this wallet is currently minding, if any. */
export interface PendingSwap {
  provider: ProviderId;
  /** The provider's order id: what `readStatus` asks about. */
  id: string;
  /** Coin ids from SWAP_COINS, so the screen can name both sides. */
  fromId: string;
  toId: string;
  /** As quoted at creation. The record of intent, never updated from status. */
  fromAmount: number;
  toAmount: number;
  createdAt: number;
}

/**
 * A stored record, or nothing. Same posture as the node revalidation in
 * persist.ts: typed, bounded, checked against what this build actually knows,
 * and dropped whole on the first field that does not hold.
 */
export function parsePendingSwap(value: unknown): PendingSwap | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;

  const provider = entry['provider'];
  if (typeof provider !== 'string' || !PROVIDERS.some((p) => p.id === provider)) return null;

  const id = entry['id'];
  /* Bounded, because this string is echoed into a status URL. A provider id
   * is a short token; a kilobyte of anything is not an order id. */
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;

  const fromId = entry['fromId'];
  const toId = entry['toId'];
  if (typeof fromId !== 'string' || !swapCoin(fromId)) return null;
  if (typeof toId !== 'string' || !swapCoin(toId)) return null;

  const fromAmount = entry['fromAmount'];
  const toAmount = entry['toAmount'];
  if (typeof fromAmount !== 'number' || !Number.isFinite(fromAmount) || fromAmount <= 0) return null;
  if (typeof toAmount !== 'number' || !Number.isFinite(toAmount) || toAmount <= 0) return null;

  const createdAt = entry['createdAt'];
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) return null;

  return {
    provider: provider as ProviderId,
    id,
    fromId,
    toId,
    fromAmount,
    toAmount,
    createdAt,
  };
}

// --------------------------------------------------------------- the journey

/**
 * The road a swap travels, in order. Terminal detours - refunded, expired,
 * failed - are not on it, because they are not stages of progress: they are
 * where progress stopped, and the screen says so in a different voice.
 */
export const JOURNEY_STAGES: readonly SwapStage[] = [
  'waiting',
  'confirming',
  'exchanging',
  'sending',
  'done',
] as const;

export type StepState = 'done' | 'current' | 'ahead';

export interface JourneyStep {
  stage: SwapStage;
  /** The sentence for this stage, from STAGE_LINES: one source of words. */
  label: string;
  state: StepState;
}

export interface SwapJourney {
  steps: JourneyStep[];
  /** How many steps are behind the traveler, for the glyph's lit length. */
  reached: number;
  /** True while the road is still being walked. */
  inFlight: boolean;
  /** Set when the road ended somewhere other than done. */
  ended: Extract<SwapStage, 'refunded' | 'expired' | 'failed'> | null;
  /** Set when the provider used a status word this build does not know. The
   *  journey is blank rather than guessed, and the screen says why. */
  unrecognized?: boolean;
}

/**
 * Where a status lands on the road.
 *
 * A terminal stage freezes the journey rather than pretending to know how far
 * it got: the provider says "refunded", not "refunded after exchanging", and
 * a lit trail to a guessed point would be an invented fact drawn in the
 * product's most trusted visual language.
 */
export function journeyOf(stage: SwapStage): SwapJourney {
  /* A word this build does not know is not a position on the road and not an
   * ending. Nothing is lit, nothing is claimed, and the screen shows the
   * exchange's own word instead of a stage this code invented for it. */
  if (stage === 'unknown') {
    return {
      steps: JOURNEY_STAGES.map((step) => ({ stage: step, label: STAGE_LINES[step], state: 'ahead' })),
      reached: 0,
      inFlight: true,
      ended: null,
      unrecognized: true,
    };
  }

  const ended = stage === 'refunded' || stage === 'expired' || stage === 'failed' ? stage : null;

  if (ended) {
    return {
      steps: JOURNEY_STAGES.map((step) => ({
        stage: step,
        label: STAGE_LINES[step],
        state: 'ahead',
      })),
      reached: 0,
      inFlight: false,
      ended,
    };
  }

  const at = JOURNEY_STAGES.indexOf(stage);
  const steps = JOURNEY_STAGES.map((step, index): JourneyStep => ({
    stage: step,
    label: STAGE_LINES[step],
    state: index < at ? 'done' : index === at ? 'current' : 'ahead',
  }));

  return {
    steps,
    reached: stage === 'done' ? JOURNEY_STAGES.length : at,
    inFlight: stage !== 'done',
    ended: null,
  };
}
