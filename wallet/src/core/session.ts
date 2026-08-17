/**
 * The send flow, as a state machine, because it is one.
 *
 * A payment on this system crosses two devices and a camera, in six steps,
 * with a person doing three of them by hand. Written as screens calling each
 * other it becomes six screens each holding a little of the truth, and the
 * interesting question — *can this be broadcast?* — gets answered in a button
 * handler somewhere. Written as one reducer, the answer to that question is a
 * property of a value, and it can be tested without rendering anything.
 *
 * ## The property this file exists to hold
 *
 * There is exactly one state that can broadcast: `ready`. There is exactly one
 * way to reach it: `verifySigned` returning ok, on a signature that came back
 * from a camera, against a draft recorded before the vault ever saw it. And
 * `mismatch` is terminal — no event moves it anywhere except back to the
 * beginning, and starting again means building a new transaction rather than
 * re-approving this one.
 *
 * That is not a UI convention. It is enforced here, in the transition table,
 * and `test/session.test.ts` tries every event against `mismatch` and asserts
 * that none of them produces a broadcastable state. The screen for that case
 * has no "broadcast anyway" button because there is no state for the button to
 * lead to, which is the order those two facts should be in.
 *
 * ## Where the waiting is
 *
 * `awaiting` is the state where this device can do nothing whatsoever, and it
 * lasts as long as it takes somebody to read a screen on another phone. Most
 * software treats that as dead time to fill with a spinner. Here it is the
 * moment the entire product is *about*: the vault is showing a person what
 * they are about to sign, and this device's only job is to say so clearly and
 * then be quiet.
 *
 * There is no timeout on it. A timeout would mean canceling a transaction
 * because somebody took too long reading a destination, which is the one
 * behavior this system should never punish.
 */

import type { Draft } from './model';
import type { Verified } from './build';
import type { Transmission } from './wire';

export type Step =
  /** Choosing what to send and to whom. Nothing exists yet. */
  | 'compose'
  /** Built and shown for approval on *this* device, before the vault sees it. */
  | 'review'
  /** Frames on the glass. The vault's camera is doing the work. */
  | 'transmit'
  /**
   * This device is signing, with its own key, behind a Face ID prompt.
   *
   * The whole of the hot path between `review` and a signature, standing where
   * `transmit`, `awaiting` and `receive` stand on the vault path. It is one
   * step rather than three because there is no room to walk to and nothing to
   * point a camera at: the entire journey is a prompt and a key schedule.
   *
   * It cannot be reached for a vault account. `canSignHere` decides that, and
   * `sign-here` is refused for any account it says no to.
   */
  | 'signing'
  /** Handed over. The vault is rendering it to a person. Nothing to do. */
  | 'awaiting'
  /** Our camera is open, reading the signature back. */
  | 'receive'
  /** Checked, matched, and not yet published. */
  | 'ready'
  /** Publishing. */
  | 'broadcasting'
  /** Published, with a txid. */
  | 'done'
  /** What came back is not what was approved. Terminal. */
  | 'mismatch'
  /** Something failed in a way that can be retried. */
  | 'failed';

export interface Compose {
  recipient: string;
  /** As typed, not as parsed. The parsed value lives in `draft`. */
  amountText: string;
  feeKey: 'economy' | 'standard' | 'priority';
  /** Where the recipient came from, which changes what the UI should say. */
  source: 'typed' | 'pasted' | 'scanned' | null;
}

export interface SessionState {
  step: Step;
  compose: Compose;
  draft: Draft | null;
  /**
   * Which account this payment is being made from.
   *
   * Recorded when the draft is built and not read from the selection again,
   * because the selection moves and a draft does not. Selecting a different
   * account on the accounts screen used to leave a composed payment sitting at
   * `review` while every screen around it changed underneath: the review step
   * offered SIGN ON THIS PHONE for a vault account's coins, `offerSignature`
   * resolved the key image book off the new selection so a legitimate vault
   * signature landed in terminal `mismatch`, and a broadcast marked the wrong
   * watcher's Monero coins pending. Unpairing a vault under a live draft
   * reached the same place with no tap at all.
   *
   * Null only for a session with no draft. It is the id from `accounts.ts`,
   * not the account key, so nothing about a key ends up in session state.
   */
  account: string | null;
  transmission: Transmission | null;
  /** Frames captured while reading the signature back. */
  capture: { have: number; total: number } | null;
  verified: Verified | null;
  txid: string | null;
  /** One sentence, for the failure screens. */
  problem: string | null;
  /** Which stage of the journey glyph is lit. Derived, kept here so the
   *  animation has one source rather than each screen deciding. */
  since: number;
}

export const START: SessionState = {
  step: 'compose',
  compose: { recipient: '', amountText: '', feeKey: 'standard', source: null },
  draft: null,
  account: null,
  transmission: null,
  capture: null,
  verified: null,
  txid: null,
  problem: null,
  since: 0,
};

export type SessionEvent =
  | { type: 'recipient'; value: string; source: Compose['source'] }
  | { type: 'amount'; value: string }
  | { type: 'fee'; value: Compose['feeKey'] }
  /** Built, and for which account. The id travels with the draft from here
   *  on, so nothing downstream has to ask the selection what it used to be. */
  | { type: 'prepared'; draft: Draft; account: string | null; at: number }
  | { type: 'transmit'; transmission: Transmission; at: number }
  /**
   * Sign on this device instead of walking to a vault.
   *
   * Carries `signsHere`, read from the account rather than from the app's
   * state, because the reducer has to be able to refuse this without knowing
   * anything about accounts. Passing `false` is not an error to handle: it is
   * the transition simply not existing, which is the same shape as every other
   * refusal in this file.
   */
  | { type: 'sign-here'; signsHere: boolean; at: number }
  /** The person says the vault has it. There is no way to know from here. */
  | { type: 'handed-over'; at: number }
  | { type: 'read-back'; at: number }
  | { type: 'capture'; have: number; total: number }
  | { type: 'returned'; verified: Verified; at: number }
  | { type: 'broadcast'; at: number }
  | { type: 'published'; txid: string; at: number }
  | { type: 'failed'; problem: string; at: number }
  | { type: 'back' }
  | { type: 'reset' };

/**
 * One step of the machine.
 *
 * Unlisted transitions are ignored rather than throwing. A camera loop firing
 * a `capture` event a frame after the user hit back is not a programming
 * error, it is what asynchronous hardware does, and a reducer that threw on it
 * would turn a race into a crash report.
 */
export function reduce(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case 'reset':
      return START;

    case 'recipient':
      if (state.step !== 'compose') return state;
      return { ...state, compose: { ...state.compose, recipient: event.value, source: event.source } };

    case 'amount':
      if (state.step !== 'compose') return state;
      return { ...state, compose: { ...state.compose, amountText: event.value } };

    case 'fee':
      if (state.step !== 'compose') return state;
      return { ...state, compose: { ...state.compose, feeKey: event.value } };

    case 'prepared':
      if (state.step !== 'compose') return state;
      return {
        ...state,
        step: 'review',
        draft: event.draft,
        account: event.account,
        problem: null,
        since: event.at,
      };

    case 'transmit':
      if (state.step !== 'review') return state;
      return { ...state, step: 'transmit', transmission: event.transmission, since: event.at };

    case 'sign-here':
      if (state.step !== 'review') return state;
      /* The airgap, held in the transition table. A vault account has no route
       * to this step at all, so there is no state a "sign it here anyway"
       * button could lead to, which is the same reason `mismatch` is terminal
       * rather than merely discouraged. */
      if (!event.signsHere) return state;
      return { ...state, step: 'signing', since: event.at };

    case 'handed-over':
      if (state.step !== 'transmit') return state;
      return { ...state, step: 'awaiting', since: event.at };

    case 'read-back':
      /* Reachable from the wait, and also from the transmit screen: people put
       * the phone down, come back, and the vault is already showing them a
       * signature. Refusing that would be pedantry with a camera. */
      if (state.step !== 'awaiting' && state.step !== 'transmit') return state;
      return { ...state, step: 'receive', capture: { have: 0, total: 0 }, since: event.at };

    case 'capture':
      if (state.step !== 'receive') return state;
      return { ...state, capture: { have: event.have, total: event.total } };

    case 'returned': {
      /* Both paths land here, and that is the point rather than a convenience.
       * A signature made on this device goes through the same `verifySigned`
       * gate as one that came back over a camera, so there is still exactly
       * one route into `ready` and it still runs through a comparison against
       * the draft recorded before anything was signed. A second route would be
       * a second place for the check to be skipped. */
      if (state.step !== 'receive' && state.step !== 'signing') return state;
      if (event.verified.ok) {
        return { ...state, step: 'ready', verified: event.verified, txid: null, since: event.at };
      }
      /* The important line in this file. A signature that does not match what
       * was approved does not become a retry, a warning or a confirmation
       * dialog. It becomes a terminal state with the reasons attached. */
      return { ...state, step: 'mismatch', verified: event.verified, since: event.at };
    }

    case 'broadcast':
      if (state.step !== 'ready') return state;
      return { ...state, step: 'broadcasting', since: event.at };

    case 'published':
      if (state.step !== 'broadcasting') return state;
      return { ...state, step: 'done', txid: event.txid, since: event.at };

    case 'failed':
      /* A failure while publishing is worth separating from every other kind,
       * because the transaction is signed and still good: the retry is another
       * broadcast, not another signature. `verified` is kept for exactly that
       * reason. */
      if (state.step === 'mismatch') return state;
      return { ...state, step: 'failed', problem: event.problem, since: event.at };

    case 'back':
      switch (state.step) {
        case 'review':
          /* The account goes with the draft. Leaving it behind would let the
           * next payment inherit an account nobody chose for it. */
          return { ...state, step: 'compose', draft: null, account: null };
        case 'transmit':
          return { ...state, step: 'review', transmission: null };
        case 'awaiting':
          return { ...state, step: 'transmit' };
        case 'receive':
          return { ...state, step: 'awaiting', capture: null };
        case 'signing':
          return { ...state, step: 'review' };
        case 'broadcasting':
          /*
           * A publish that never answers has to have a way out.
           *
           * This step had no exit at all: `<Ready />` renders with its button
           * disabled and no `back`, so anything that entered `broadcasting`
           * and then failed to dispatch left the session pinned there until
           * the app was relaunched, with a signed transaction stranded behind
           * it. Returning to `ready` is safe because the bytes do not change:
           * publishing the same signed transaction twice is one transaction,
           * and a node that already has it says so.
           */
          return { ...state, step: 'ready' };
        case 'failed':
          /* Back from a failed broadcast returns to the signed transaction,
           * not to the beginning: it is still signed, and making somebody
           * re-sign because a node was unreachable is punishing them for the
           * network's problem. */
          return state.verified?.ok ? { ...state, step: 'ready', problem: null } : START;
        default:
          return state;
      }

    default:
      return state;
  }
}

/**
 * Can this be published?
 *
 * One function, used by the button and by the tests, so that "the button was
 * disabled" and "the state cannot broadcast" are the same claim.
 */
export function canBroadcast(state: SessionState): boolean {
  return state.step === 'ready' && state.verified !== null && state.verified.ok;
}

/** How far along the journey glyph should be drawn, 0 to 6. */
export function journeyReached(state: SessionState): number {
  switch (state.step) {
    case 'compose':
      return 0;
    case 'review':
      return 1;
    case 'transmit':
      return 2;
    /* Two, three and four at once: on this path there is no handing over and
     * no reading back, so the glyph jumps rather than pretending to a journey
     * that is not happening. */
    case 'signing':
      return 3;
    case 'awaiting':
      return 3;
    case 'receive':
      return 3;
    case 'ready':
      return 4;
    case 'broadcasting':
      return 4;
    case 'done':
      return 5;
    default:
      return 0;
  }
}
