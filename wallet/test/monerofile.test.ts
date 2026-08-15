/**
 * The sender for the wire kind the vault could receive and nothing could send.
 *
 * Two things are worth testing here and the second is the one that would hurt.
 *
 * The first is the ordinary one: a real `unsigned_monero_tx` becomes frames,
 * and the vault's own collector puts them back together into the same bytes.
 * The fixture is the file `oracle/` produced from Monero's own serializer, so
 * what crosses this wire is a file wallet2 actually wrote rather than one this
 * repository invented to test itself with.
 *
 * The second is what gets refused, and refused *here* rather than at the far
 * end. Every trip to the vault costs somebody a walk to a drawer and a minute
 * of holding two phones at each other, and a screen that cheerfully animates
 * anything is a screen that spends those minutes on files the vault will only
 * name back. The judgement uses the vault's own `readContainer`, so the two
 * halves cannot come to disagree about which files are worth the trip.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Scanner } from '@vault/airgap/scanner';
import { MAX_FILE_BYTES, moneroFileTransmission, offerMoneroFile } from '../src/core/monerofile';
import { FRAME_BYTES } from '../src/core/wire';

const fixture = JSON.parse(
  readFileSync('../test/fixtures/monero-unsigned-tx-set.json', 'utf8'),
) as { file: string };

const bytes = (hex: string): Uint8Array =>
  new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** A wallet2 container header, for the kinds with no fixture. */
function container(magic: string, version: number, body = 512): Uint8Array {
  const out = new Uint8Array(magic.length + 1 + body);
  for (let i = 0; i < magic.length; i++) out[i] = magic.charCodeAt(i);
  out[magic.length] = version;
  for (let i = 0; i < body; i++) out[magic.length + 1 + i] = (i * 37 + 11) & 0xff;
  return out;
}

const REAL = bytes(fixture.file);

describe('a real unsigned transaction set, offered', () => {
  it('found the fixture, so a pass means something', () => {
    expect(REAL.length).toBeGreaterThan(500);
  });

  it('is accepted, named, and costed in frames and seconds', () => {
    const offer = offerMoneroFile(REAL);
    expect(offer.problem ?? null).toBeNull();
    expect(offer.ok).toBe(true);
    expect(offer.what).toBe('a Monero unsigned transaction set');
    expect(offer.frames).toBe(Math.ceil(REAL.length / FRAME_BYTES));
    /* The number a person reads before deciding to fetch the other phone. It
     * has to come from the frame count and the real cadence, not from a
     * guess. */
    expect(offer.seconds).toBeGreaterThan(0);
    expect(offer.seconds).toBeLessThan(10);
  });

  it('reassembles, through the vault\'s own collector, into the same file', () => {
    /* The end-to-end claim: what this wallet draws is what the vault reads.
     * The scanner is the vault's, not a stand-in, and it refuses a payload
     * whose digest does not match — so arriving at all is the assertion. */
    const transmission = moneroFileTransmission(REAL)!;
    expect(transmission).not.toBeNull();
    expect(transmission.kind).toBe('XMRFILE');

    const scanner = new Scanner();
    let payload: Uint8Array | null = null;
    for (let i = 0; i < transmission.total; i++) {
      const progress = scanner.offer(transmission.current());
      if (progress.payload) payload = progress.payload;
      transmission.advance();
    }
    expect(payload, 'the frames never assembled').not.toBeNull();
    expect(Array.from(payload!)).toEqual(Array.from(REAL));
  });

  it('survives a scan that misses frames, because every scan does', () => {
    /* The animation loops forever for exactly this reason. A camera that
     * catches every other frame still finishes, one pass later. */
    const transmission = moneroFileTransmission(REAL)!;
    const scanner = new Scanner();
    let payload: Uint8Array | null = null;
    for (let i = 0; i < transmission.total * 3 && !payload; i++) {
      if (i % 2 === 0) {
        const progress = scanner.offer(transmission.current());
        if (progress.payload) payload = progress.payload;
      }
      transmission.advance();
    }
    expect(payload, 'a lossy scan never completed').not.toBeNull();
    expect(Array.from(payload!)).toEqual(Array.from(REAL));
  });
});

describe('what it will not carry across the room', () => {
  it('refuses anything that is not one of Monero\'s files', () => {
    for (const junk of [
      new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]), // a PSBT
      new Uint8Array(64).fill(0xab),
      new TextEncoder().encode('Monero is a cryptocurrency'),
    ]) {
      const offer = offerMoneroFile(junk);
      expect(offer.ok).toBe(false);
      expect(offer.problem).toMatch(/not one of Monero's wallet files/);
      // And it says what the vault does read, rather than only what it does not.
      expect(offer.problem).toMatch(/unsigned_monero_tx/);
    }
  });

  it('refuses an empty file with the plainest sentence available', () => {
    expect(offerMoneroFile(new Uint8Array(0))).toEqual({ ok: false, problem: 'That file is empty.' });
  });

  it('names a real Monero file the vault has no reader for, and stops', () => {
    /* The refusal worth having. These are perfectly good files; walking one to
     * the vault gets it named back at you, which is a wasted trip rather than
     * an error. The wallet knows because it asks the vault's own module. */
    for (const [magic, version] of [
      ['Monero signed tx set', 5],
      ['Monero output export', 4],
      ['Monero key image export', 3],
      ['Monero multisig unsigned tx set', 1],
    ] as const) {
      const offer = offerMoneroFile(container(magic, version));
      expect(offer.ok, magic).toBe(false);
      expect(offer.what, magic).toContain('Monero');
      expect(offer.problem, magic).toMatch(/no reader for it/);
    }
  });

  it('refuses multisig without ever making it look conditional', () => {
    /* Single-signature only, in both halves, deliberately. The sentence must
     * not read as "not yet". */
    const offer = offerMoneroFile(container('Monero multisig unsigned tx set', 1));
    expect(offer.problem).not.toMatch(/yet|soon|later|support/i);
  });

  it('refuses a file too long to animate, and says how long it is', () => {
    const huge = container('Monero unsigned tx set', 5, MAX_FILE_BYTES + 1);
    const offer = offerMoneroFile(huge);
    expect(offer.ok).toBe(false);
    expect(offer.problem).toMatch(/KB/);
    /* Refused rather than truncated. A truncated payload assembles into
     * nothing at the far end, and the failure would surface over there as
     * "the codes did not add up", which points at the camera. */
    expect(moneroFileTransmission(huge)).toBeNull();
  });

  it('accepts a file at exactly the limit', () => {
    /* The boundary, because an off-by-one here is a file that is refused for
     * being one byte too large. */
    const body = MAX_FILE_BYTES - 'Monero unsigned tx set'.length - 1;
    expect(offerMoneroFile(container('Monero unsigned tx set', 5, body)).ok).toBe(true);
  });

  it('builds no frames for anything the offer refused', () => {
    /* The two functions are separate so a screen can decide what to say before
     * it decides what to draw. That separation must not become a way around
     * the decision. */
    for (const refused of [
      new Uint8Array(0),
      new Uint8Array(64).fill(0xab),
      container('Monero signed tx set', 5),
      container('Monero unsigned tx set', 5, MAX_FILE_BYTES + 1),
    ]) {
      expect(moneroFileTransmission(refused)).toBeNull();
    }
  });
});

describe('the screen says what the round trip is', () => {
  const screen = readFileSync('src/screens/MoneroFile.tsx', 'utf8');

  it('promises no signature, in words rather than by omission', () => {
    expect(screen).toMatch(/NOTHING COMES BACK/);
    expect(screen).toMatch(/does not sign them/);
  });

  it('sends somebody to the path that does end in a signature', () => {
    /* A refusal that explains itself and stops is still somebody holding a
     * phone with nothing to do next. */
    expect(screen).toMatch(/use SEND on this wallet/);
  });

  it('never turns the camera on at the end of it', () => {
    /* The send flow's transmit step looks almost identical and finishes by
     * scanning the vault's answer. There is no answer here, and a handoff to
     * the camera would be the screen implying one. */
    const code = screen
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/navigate\('Scan'/);
    expect(code).not.toMatch(/purpose: 'wire'/);
  });
});
