/**
 * The wallet's frames, read by the vault's reader.
 *
 * Both halves import one encoder, so this cannot test that two implementations
 * agree — there is only one, which is the point. What it tests is the layer
 * this package adds: that a draft becomes frames of the right kind, that the
 * animation loops rather than ending, that the estimate shown on the review
 * screen matches the number of frames that actually get drawn, and that the
 * whole thing survives a scan that misses frames, which is what a scan is.
 */

import { describe, expect, it } from 'vitest';
import { Scanner } from '@vault/airgap/scanner';
import { digestOf } from '@vault/airgap/envelope';
import { FRAME_BYTES, frameEstimate, Transmission, transmit } from '../src/core/wire';
import type { Draft } from '../src/core/model';

function draftOf(bytes: number): Draft {
  const unsigned = new Uint8Array(bytes).map((_, i) => (i * 31 + 7) & 0xff);
  return {
    asset: 'BTC',
    recipient: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    amount: 5_000_000n,
    fee: 1_551n,
    feeRate: 11,
    unsigned,
    digest: digestOf(unsigned),
    createdAt: 0,
    inputs: [],
    inputTotal: 0n,
    changeAddresses: [],
  };
}

describe('a draft on the glass', () => {
  it('goes out as Labyrinth frames to a Labyrinth vault, naming what it is', () => {
    const transmission = transmit(draftOf(1200));
    expect(transmission.format).toBe('labyrinth');
    expect(transmission.current()).toMatch(/^LV1:PSBT:1:3:[0-9a-f]{8}:/);
  });

  it('goes out as BC-UR to anything else, because that is what everything else reads', () => {
    const transmission = transmit(draftOf(1200), 'other-wallet');
    expect(transmission.format).toBe('ur');
    expect(transmission.current()).toMatch(/^ur:crypto-psbt\//);
  });

  it('will not dress a Monero payload up as a PSBT for a wallet that has never seen one', () => {
    const monero: Draft = { ...draftOf(900), asset: 'XMR' };
    const transmission = transmit(monero, 'other-wallet');
    expect(transmission.format).toBe('labyrinth');
    expect(transmission.current()).toMatch(/^LV1:XMRUNSIGNED:/);
  });

  it('loops forever, because the receiver may have started filming halfway through', () => {
    const transmission = transmit(draftOf(FRAME_BYTES * 3));
    const first = transmission.current();
    for (let i = 0; i < transmission.total; i++) transmission.advance();
    expect(transmission.current()).toBe(first);
    expect(transmission.status().laps).toBe(1);
  });

  it('counts frames from one, the way the person watching does', () => {
    const transmission = transmit(draftOf(FRAME_BYTES * 2));
    expect(transmission.status().frame).toBe(1);
    transmission.advance();
    expect(transmission.status().frame).toBe(2);
  });

  it('estimates on the review screen what the transmit screen actually draws', () => {
    for (const size of [1, 399, 400, 401, 4000]) {
      const estimate = frameEstimate(size);
      const transmission = new Transmission(new Uint8Array(size), 'PSBT', 'labyrinth', 'x');
      expect(estimate.frames, `${size} bytes`).toBe(transmission.total);
      expect(estimate.seconds).toBe(transmission.passSeconds());
    }
  });
});

describe('the vault reading it back', () => {
  it('assembles the exact bytes that were sent', () => {
    const draft = draftOf(1500);
    const transmission = transmit(draft);
    const scanner = new Scanner();

    let payload: Uint8Array | null = null;
    for (let i = 0; i < transmission.total; i++) {
      payload = scanner.offer(transmission.current()).payload ?? payload;
      transmission.advance();
    }
    payload = scanner.offer(transmission.current()).payload ?? payload;

    expect(payload).not.toBeNull();
    expect(Array.from(payload!)).toEqual(Array.from(draft.unsigned));
  });

  it('finishes even when the camera misses half the animation', () => {
    const draft = draftOf(2000);
    const transmission = transmit(draft);
    const scanner = new Scanner();

    /* Every other frame, for three passes: a camera at an angle, in a room
     * with a person moving. This is the normal case, not the bad one. */
    let payload: Uint8Array | null = null;
    for (let i = 0; i < transmission.total * 6; i++) {
      if (i % 2 === 0) payload = scanner.offer(transmission.current()).payload ?? payload;
      transmission.advance();
    }

    expect(payload).not.toBeNull();
    expect(Array.from(payload!)).toEqual(Array.from(draft.unsigned));
  });

  it('throws away a scan that mixes two different transactions', () => {
    const first = transmit(draftOf(1500));
    const second = transmit(draftOf(1500).unsigned.length === 0 ? draftOf(1500) : { ...draftOf(1500), unsigned: new Uint8Array(1500).fill(9), digest: digestOf(new Uint8Array(1500).fill(9)) });
    const scanner = new Scanner();

    scanner.offer(first.current());
    first.advance();
    scanner.offer(first.current());
    /* A frame from a different payload restarts the collection rather than
     * merging into it. What must never happen is a payload assembled out of
     * halves of two transactions. */
    const progress = scanner.offer(second.current());
    expect(progress.have).toBe(1);
    expect(progress.payload).toBeNull();
  });
});
