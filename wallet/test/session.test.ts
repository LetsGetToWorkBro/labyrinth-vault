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
  { type: 'prepared', draft, at: AT },
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
      { type: 'prepared', draft, at: AT },
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
