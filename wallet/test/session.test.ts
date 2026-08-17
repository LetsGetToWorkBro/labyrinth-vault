/**
 * The state machine, and the one property worth having.
 *
 * `mismatch` is a hole. Nothing climbs out of it into a state that can
 * broadcast — not a retry, not a re-scan, not a second signature, not the back
 * button. The last test in the first block is the one that matters: it throws
 * every event in the vocabulary at a mismatched session and asserts that none
 * of them produces a broadcastable state.
 *
 * Written that way on purpose, rather than as a list of specific transitions.
 * A test that says "returned does not lead to ready" keeps passing when
 * somebody adds a new event next year; a test that says "*nothing* leads to
 * ready" fails the moment the new event has a hole in it, which is when
 * somebody should be told.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { canBroadcast, journeyReached, reduce, START, type SessionEvent, type SessionState } from '../src/core/session';
import type { Verified } from '../src/core/build';
import type { Draft } from '../src/core/model';
import { Transmission } from '../src/core/wire';

const AT = 1_760_000_000_000;

const draft: Draft = {
  asset: 'BTC',
  recipient: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  amount: 5_000_000n,
  fee: 1_551n,
  feeRate: 11,
  unsigned: new Uint8Array([0x70, 0x73, 0x62, 0x74]),
  digest: 'a'.repeat(64),
  createdAt: AT,
  inputs: [{ txid: 'b'.repeat(64), vout: 0 }],
  inputTotal: 25_000_000n,
  changeAddresses: ['bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'],
};

const matched: Verified = {
  ok: true,
  txid: 'c'.repeat(64),
  raw: new Uint8Array([1]),
  outputs: [],
  fee: draft.fee,
};

const mismatched: Verified = {
  ok: false,
  outputs: [],
  reasons: ['This pays 6000000 where 5000000 was approved.'],
};

const transmission = new Transmission(draft.unsigned, 'PSBT', 'labyrinth', draft.digest);

function run(events: SessionEvent[], from: SessionState = START): SessionState {
  return events.reduce(reduce, from);
}

const HAPPY: SessionEvent[] = [
  { type: 'recipient', value: draft.recipient, source: 'scanned' },
  { type: 'amount', value: '0.05' },
  { type: 'prepared', draft, account: 'hot', at: AT },
  { type: 'transmit', transmission, at: AT },
  { type: 'handed-over', at: AT },
  { type: 'read-back', at: AT },
  { type: 'returned', verified: matched, at: AT },
];

describe('a payment that goes the way it should', () => {
  it('walks compose, review, transmit, wait, receive, ready', () => {
    const steps = HAPPY.reduce<SessionState[]>(
      (states, event) => [...states, reduce(states[states.length - 1]!, event)],
      [START],
    ).map((state) => state.step);
    expect(steps).toEqual(['compose', 'compose', 'compose', 'review', 'transmit', 'awaiting', 'receive', 'ready']);
  });

  it('cannot broadcast until the signature has come back and matched', () => {
    for (let i = 0; i < HAPPY.length; i++) {
      const state = run(HAPPY.slice(0, i));
      expect(canBroadcast(state), `after ${i} events`).toBe(false);
    }
    expect(canBroadcast(run(HAPPY))).toBe(true);
  });

  it('ends with a txid and nothing else changed', () => {
    const done = run([...HAPPY, { type: 'broadcast', at: AT }, { type: 'published', txid: 'd'.repeat(64), at: AT }]);
    expect(done.step).toBe('done');
    expect(done.txid).toBe('d'.repeat(64));
    expect(done.draft).toBe(draft);
  });
});

describe('a signature that does not match what was approved', () => {
  const stuck = run([...HAPPY.slice(0, -1), { type: 'returned', verified: mismatched, at: AT }]);

  it('lands in mismatch, with the reasons kept', () => {
    expect(stuck.step).toBe('mismatch');
    expect(stuck.verified?.ok).toBe(false);
  });

  it('cannot be broadcast, by any event in the vocabulary', () => {
    const everything: SessionEvent[] = [
      { type: 'recipient', value: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', source: 'typed' },
      { type: 'amount', value: '0.05' },
      { type: 'fee', value: 'priority' },
      { type: 'prepared', draft, account: 'hot', at: AT },
      { type: 'transmit', transmission, at: AT },
      { type: 'handed-over', at: AT },
      { type: 'read-back', at: AT },
      { type: 'capture', have: 4, total: 4 },
      { type: 'returned', verified: matched, at: AT },
      { type: 'broadcast', at: AT },
      { type: 'published', txid: 'e'.repeat(64), at: AT },
      { type: 'failed', problem: 'anything', at: AT },
      { type: 'back' },
    ];

    for (const event of everything) {
      const after = reduce(stuck, event);
      expect(canBroadcast(after), `${event.type} got out of mismatch`).toBe(false);
      expect(after.step, `${event.type} got out of mismatch`).toBe('mismatch');
    }
  });

  it('only leaves by starting a new payment from nothing', () => {
    const fresh = reduce(stuck, { type: 'reset' });
    expect(fresh).toEqual(START);
    expect(fresh.draft).toBeNull();
  });
});

describe('a broadcast that fails', () => {
  const failed = run([
    ...HAPPY,
    { type: 'broadcast', at: AT },
    { type: 'failed', problem: 'No route to any node.', at: AT },
  ]);

  it('keeps the signature, because the transaction is still good', () => {
    expect(failed.step).toBe('failed');
    expect(failed.verified?.ok).toBe(true);
    expect(failed.problem).toBe('No route to any node.');
  });

  it('goes back to a transaction that can be published again, not to the start', () => {
    const back = reduce(failed, { type: 'back' });
    expect(back.step).toBe('ready');
    expect(canBroadcast(back)).toBe(true);
  });
});

describe('events that arrive at the wrong moment', () => {
  it('ignores a camera frame that lands after the user went back', () => {
    const state = run(HAPPY.slice(0, 5));
    expect(reduce(state, { type: 'capture', have: 9, total: 12 })).toBe(state);
  });

  it('ignores a second signature after one already matched', () => {
    const ready = run(HAPPY);
    expect(reduce(ready, { type: 'returned', verified: mismatched, at: AT })).toBe(ready);
  });

  it('lets a person read the signature back straight off the transmit screen', () => {
    const transmitting = run(HAPPY.slice(0, 4));
    expect(reduce(transmitting, { type: 'read-back', at: AT }).step).toBe('receive');
  });
});

describe('the journey glyph', () => {
  it('advances with the payment and never goes backwards along the happy path', () => {
    let previous = -1;
    for (let i = 0; i <= HAPPY.length; i++) {
      const reached = journeyReached(run(HAPPY.slice(0, i)));
      expect(reached).toBeGreaterThanOrEqual(previous);
      previous = reached;
    }
  });

  it('is unlit in a state that has failed', () => {
    const stuck = run([...HAPPY.slice(0, -1), { type: 'returned', verified: mismatched, at: AT }]);
    expect(journeyReached(stuck)).toBe(0);
  });
});

describe('signing on this device, instead of walking to a vault', () => {
  /* The hot path. It adds one step between `review` and a signature, and the
   * thing worth holding is that it adds no second route into `ready`: what it
   * produces goes through `verifySigned` exactly as a signature returning over
   * a camera does. */

  const reviewed = (): SessionState => {
    const composed = reduce(reduce(START, { type: 'recipient', value: 'bc1q', source: 'typed' }), {
      type: 'amount',
      value: '0.01',
    });
    return reduce(composed, { type: 'prepared', draft, account: 'hot', at: 1 });
  };

  it('reaches the signing step only from review, and only when it may', () => {
    expect(reduce(reviewed(), { type: 'sign-here', signsHere: true, at: 2 }).step).toBe('signing');
    expect(reduce(START, { type: 'sign-here', signsHere: true, at: 2 }).step).toBe('compose');
  });

  it('refuses a vault account, in the transition table rather than in a button', () => {
    /* The airgap. There is no state a "sign it here anyway" control could lead
     * to, which is the same shape as `mismatch` being terminal. */
    const state = reduce(reviewed(), { type: 'sign-here', signsHere: false, at: 2 });
    expect(state.step).toBe('review');
    expect(canBroadcast(state)).toBe(false);
  });

  it('still needs a verified signature to become broadcastable', () => {
    const signing = reduce(reviewed(), { type: 'sign-here', signsHere: true, at: 2 });
    const bad = reduce(signing, {
      type: 'returned',
      verified: mismatched,
      at: 3,
    });
    expect(bad.step).toBe('mismatch');
    expect(canBroadcast(bad)).toBe(false);
  });

  it('becomes ready on a signature that verifies, by the same route as the camera', () => {
    const signing = reduce(reviewed(), { type: 'sign-here', signsHere: true, at: 2 });
    const good = reduce(signing, { type: 'returned', verified: matched, at: 3 });
    expect(good.step).toBe('ready');
    expect(canBroadcast(good)).toBe(true);
  });

  it('goes back to review, so a refused Face ID is not a dead end', () => {
    const signing = reduce(reviewed(), { type: 'sign-here', signsHere: true, at: 2 });
    expect(reduce(signing, { type: 'back' }).step).toBe('review');
  });

  it('never lets the local path skip the check, from any step', () => {
    /* The property, searched rather than asserted on one path: no sequence of
     * events reaches a broadcastable state without a verified signature. */
    const events: SessionEvent[] = [
      { type: 'sign-here', signsHere: true, at: 1 },
      { type: 'sign-here', signsHere: false, at: 1 },
      { type: 'broadcast', at: 1 },
      { type: 'handed-over', at: 1 },
      { type: 'read-back', at: 1 },
      { type: 'back' },
    ];
    let state = reviewed();
    for (const first of events) {
      for (const second of events) {
        const reached = reduce(reduce(state, first), second);
        expect(canBroadcast(reached), `${first.type} then ${second.type} broadcast`).toBe(false);
      }
    }
    state = reduce(state, { type: 'sign-here', signsHere: true, at: 2 });
    expect(canBroadcast(state)).toBe(false);
  });
});

describe('a payment remembers which account it is from', () => {
  /* The defect: a `Draft` carried no account identity and `selectAccount` is a
   * bare setter with no session reset, so selecting a different account left a
   * composed payment at `review` while every screen around it changed. Review
   * offered SIGN ON THIS PHONE over the vault account's transaction, the key
   * image book was resolved off the new selection so a legitimate vault
   * signature landed in terminal `mismatch`, and a broadcast marked the wrong
   * watcher's coins pending. Unpairing under a live draft reached the same
   * state with no tap at all. */

  const composed = (): SessionState =>
    reduce(reduce(START, { type: 'recipient', value: draft.recipient, source: 'typed' }), {
      type: 'amount',
      value: '0.05',
    });

  it('records the account the draft was built for', () => {
    const state = reduce(composed(), { type: 'prepared', draft, account: 'vault', at: AT });
    expect(state.account).toBe('vault');
    expect(state.draft).toBe(draft);
  });

  it('carries it through signing, verification and broadcast', () => {
    const state = run(
      [
        { type: 'prepared', draft, account: 'vault', at: AT },
        { type: 'transmit', transmission, at: AT },
        { type: 'handed-over', at: AT },
        { type: 'read-back', at: AT },
        { type: 'returned', verified: matched, at: AT },
        { type: 'broadcast', at: AT },
        { type: 'published', txid: 'f'.repeat(64), at: AT },
      ],
      composed(),
    );
    expect(state.step).toBe('done');
    expect(state.account).toBe('vault');
  });

  it('drops it with the draft when the payment is abandoned', () => {
    /* Otherwise the next payment inherits an account nobody chose for it. */
    const back = reduce(reduce(composed(), { type: 'prepared', draft, account: 'vault', at: AT }), {
      type: 'back',
    });
    expect(back.step).toBe('compose');
    expect(back.draft).toBeNull();
    expect(back.account).toBeNull();
    expect(reduce(back, { type: 'reset' }).account).toBeNull();
  });
});

describe('publishing has a way out', () => {
  const publishing = (): SessionState =>
    run([...HAPPY, { type: 'broadcast', at: AT }]);

  it('is recoverable rather than a screen with no exit', () => {
    /* `broadcasting` had no `back` transition and `<Ready />` renders with its
     * button disabled, so anything that entered this step and then failed to
     * dispatch pinned the session there until the app was relaunched, with a
     * signed transaction stranded behind it. */
    const stalled = publishing();
    expect(stalled.step).toBe('broadcasting');
    const out = reduce(stalled, { type: 'back' });
    expect(out.step).toBe('ready');
    /* Still the same signature. Backing out of a stall must not cost somebody
     * another Face ID prompt or another walk to the vault. */
    expect(out.verified).toBe(stalled.verified);
    expect(canBroadcast(out)).toBe(true);
  });

  it('still refuses to publish what did not verify', () => {
    const stuck = run([...HAPPY.slice(0, -1), { type: 'returned', verified: mismatched, at: AT }]);
    expect(canBroadcast(reduce(stuck, { type: 'back' }))).toBe(false);
  });
});

describe('what the store hands the reducer', () => {
  /* Source guards, because there is no React renderer in this package and the
   * defects below are about which value a callback reads rather than about any
   * shape a reducer can be asked for. */
  const store = readFileSync('src/state/store.tsx', 'utf8');
  const broadcast = /const broadcast = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/.exec(store)?.[0] ?? '';
  const code = broadcast.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('publishes the chain the payment is on, not the chain chip', () => {
    /* Every neighbor reads `draft.asset`; this one read the app-wide chip.
     * Send is a modal with a swipe gesture, so a person could leave the ready
     * screen, change the chip on Home, come back and press BROADCAST: a Monero
     * transaction to the Bitcoin node, with the mainnet Monero gate, keyed to
     * the same chip, never running. */
    expect(broadcast, 'broadcast not found in the store').toBeTruthy();
    expect(code).toMatch(/const asset = draft\.asset;/);
    /* The dependency list is where reading the app-wide chip shows up: this
     * callback cannot close over that state without naming it here. */
    const deps = (/\n  \}, \[([^\]]*)\]\);/.exec(broadcast)?.[1] ?? '').split(',').map((d) => d.trim());
    expect(deps, 'broadcast dependencies not found').toContain('session.draft');
    expect(deps, 'the chain chip decides again').not.toContain('asset');
  });

  it('publishes from the account the payment was prepared from', () => {
    expect(code).toMatch(/watchers\.watcherFor\(session\.account\)/);
  });

  it('verifies against the account the payment was prepared from', () => {
    /* The other half of the same defect, and the one that costs a real
     * signature. `verifySignedMonero` is handed the key images for the coins
     * being spent, resolved from a watcher; resolved off the selection, a
     * legitimate vault signature returning after somebody visited the accounts
     * list is checked against the wrong account's book and lands in terminal
     * `mismatch`, which no event climbs out of. */
    const apply = /const applySignature = useCallback\([\s\S]*?\n  \);/.exec(store)?.[0] ?? '';
    expect(apply, 'applySignature not found').toBeTruthy();
    const body = apply.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(body).toMatch(/const paying = watchers\.watcherFor\(session\.account\);/);
    expect(body, 'the selection decides which book a signature is checked against').not.toMatch(
      /moneroImagesFor[\s\S]*?\bwatcher\b\./,
    );
  });

  it('checks it has somewhere to publish before it says it is publishing', () => {
    /* Dispatching `broadcast` and then returning on a missing watcher left the
     * session in a step with no exit. The order is the fix; the sentence is
     * the rest of it. */
    const guardAt = code.indexOf('if (!paying)');
    const dispatchAt = code.indexOf("dispatch({ type: 'broadcast'");
    expect(guardAt, 'the missing-watcher check is gone').toBeGreaterThan(-1);
    expect(dispatchAt, 'the broadcast transition is gone').toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(dispatchAt);
    expect(code).toMatch(/no node to publish it to/);
  });
});
