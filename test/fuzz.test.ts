/**
 * Every parser, fed garbage on purpose.
 *
 * The parsers in this project stand where the input is least trustworthy: a
 * camera pointed at the world, a file picked from a filesystem, a PSBT built
 * by a device we assume may be hostile. Two properties have to hold there,
 * and they are different in kind:
 *
 *   1. **Never throw.** A scanner that crashes on a malformed frame is a
 *      denial of service that a sticker on a wall can trigger.
 *   2. **Never assemble wrong bytes.** Corruption may make a scan fail; it
 *      must never make it *succeed differently*. If a collector hands back a
 *      payload, that payload is byte-identical to one somebody actually
 *      encoded, or the whole model is broken.
 *
 * The fuzzing is deterministic: a seeded generator, so a failure is a
 * reproducible test case rather than an anecdote. Thousands of cases per
 * parser; the numbers are chosen to keep the suite fast enough that nobody is
 * tempted to skip it.
 */

import { describe, expect, it } from 'vitest';
import { Collector, encodeParts, parsePart } from '../src/airgap/envelope';
import { bytewordsDecode } from '../src/airgap/bytewords';
import { cborDecode } from '../src/airgap/cbor';
import { UrCollector, encodeUr, parseUr, urPayloadBytes } from '../src/airgap/ur';
import { Scanner } from '../src/airgap/scanner';
import { parseAccount } from '../src/keys/account';
import { openFromMnemonic } from '../src/keys/bitcoin';
import { describePsbt } from '../src/keys/psbt';
import { unseal, passphraseToBytes } from '../src/keys/seal';

/** xorshift32: tiny, seedable, and the same sequence on every run. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

function bytesFrom(random: () => number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(random() * 256);
  return out;
}

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:/-._ é❤';

/** Mutate a valid string: substitutions, deletions, insertions, truncation. */
function mangle(text: string, random: () => number): string {
  const edits = 1 + Math.floor(random() * 4);
  let out = text;
  for (let i = 0; i < edits; i++) {
    const at = Math.floor(random() * Math.max(1, out.length));
    const roll = random();
    if (roll < 0.4) {
      out = out.slice(0, at) + CHARS[Math.floor(random() * CHARS.length)] + out.slice(at + 1);
    } else if (roll < 0.7) {
      out = out.slice(0, at) + out.slice(at + 1);
    } else if (roll < 0.9) {
      out = out.slice(0, at) + CHARS[Math.floor(random() * CHARS.length)] + out.slice(at);
    } else {
      out = out.slice(0, at);
    }
  }
  return out;
}

describe('text parsers survive anything a camera can see', () => {
  it('parsePart, parseUr, bytewordsDecode: garbage in, null out, never a throw', () => {
    const random = rng(0xdecafbad);
    const payload = bytesFrom(rng(7), 900);
    const valid = [...encodeParts('PSBT', payload), ...encodeUr('crypto-psbt', payload, 120).firstPass()];
    for (let i = 0; i < 4000; i++) {
      const source = valid[Math.floor(random() * valid.length)]!;
      const input = random() < 0.15 ? String.fromCharCode(...bytesFrom(random, Math.floor(random() * 60))) : mangle(source, random);
      // The assertion is that none of these throw. Values are unconstrained;
      // a mangled frame that still parses is fine, it just is not this frame.
      parsePart(input);
      parseUr(input);
      bytewordsDecode(input, 'minimal');
    }
  });

  it('binary parsers: random bytes are an answer, never an exception', () => {
    const random = rng(0xfeedface);
    const wallet = openFromMnemonic(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    );
    for (let i = 0; i < 1500; i++) {
      const junk = bytesFrom(random, Math.floor(random() * 200));
      cborDecode(junk);
      parseAccount(junk);
      expect(unseal(junk, passphraseToBytes('pass')).ok).toBe(false);
      const summary = describePsbt(junk, wallet, { scanDepth: 3 });
      if (!summary.ok) expect(summary.signable).toBe(false);
    }
  });
});

describe('corruption can fail a scan, never redirect it', () => {
  /* The property that matters more than not crashing. Frames from two real
   * payloads, mangled frames, and noise are all thrown at one collector; if
   * it ever reports success, the bytes must exactly equal one of the two
   * payloads. "Almost one of them" is the catastrophic outcome. */

  it('holds for our own wire', () => {
    const random = rng(0xab1e);
    const payloadA = bytesFrom(rng(1), 1700);
    const payloadB = bytesFrom(rng(2), 1700);
    const framesA = encodeParts('PSBT', payloadA, 300);
    const framesB = encodeParts('PSBT', payloadB, 300);
    const okA = JSON.stringify([...payloadA]);
    const okB = JSON.stringify([...payloadB]);

    for (let round = 0; round < 120; round++) {
      const collector = new Collector();
      for (let step = 0; step < 40; step++) {
        const roll = random();
        const pool = roll < 0.45 ? framesA : roll < 0.9 ? framesB : null;
        const frame = pool
          ? pool[Math.floor(random() * pool.length)]!
          : mangle(framesA[Math.floor(random() * framesA.length)]!, random);
        const progress = collector.offer(random() < 0.2 ? mangle(frame, random) : frame);
        if (progress.payload) {
          const got = JSON.stringify([...progress.payload]);
          expect(got === okA || got === okB, 'assembled bytes nobody encoded').toBe(true);
        }
      }
    }
  });

  it('holds for BC-UR, mixed frames included', () => {
    const random = rng(0xcafe2);
    const payloadA = bytesFrom(rng(3), 1100);
    const payloadB = bytesFrom(rng(4), 1100);
    const encoderA = encodeUr('crypto-psbt', payloadA, 100);
    const encoderB = encodeUr('crypto-psbt', payloadB, 100);
    const framesA: string[] = [];
    const framesB: string[] = [];
    for (let i = 0; i < 30; i++) framesA.push(encoderA.nextPart());
    for (let i = 0; i < 30; i++) framesB.push(encoderB.nextPart());
    const okA = JSON.stringify([...payloadA]);
    const okB = JSON.stringify([...payloadB]);

    for (let round = 0; round < 60; round++) {
      const collector = new UrCollector();
      for (let step = 0; step < 50; step++) {
        const roll = random();
        const pool = roll < 0.45 ? framesA : roll < 0.9 ? framesB : null;
        const frame = pool
          ? pool[Math.floor(random() * pool.length)]!
          : mangle(framesB[Math.floor(random() * framesB.length)]!, random);
        const progress = collector.offer(random() < 0.2 ? mangle(frame, random) : frame);
        if (progress.cbor) {
          /* A finding this fuzzer made on its first run, kept as documentation:
           * delete the `12-30/` sequence component from a multi-part frame and
           * what remains is a *valid single-part UR* — the body is untouched,
           * so its bytewords checksum still passes — whose CBOR is the fountain
           * frame's five-element array. The reference implementation accepts it
           * too; it is inherent to the frame syntax, and a QR camera cannot
           * actually produce it (QR error correction is all-or-nothing). The
           * boundary that holds is the type shape: a message for the byte-
           * string types must BE a byte string, which is what urPayloadBytes
           * enforces and the Scanner refuses on. So the property is asserted
           * there: anything that comes through as bytes is a real payload. */
          const payload = urPayloadBytes(progress.cbor);
          if (payload) {
            const got = JSON.stringify([...payload]);
            expect(got === okA || got === okB, 'assembled bytes nobody encoded').toBe(true);
          }
          break;
        }
      }
    }
  });

  it('holds through the combined scanner too', () => {
    const random = rng(0x5ca11e);
    const payload = bytesFrom(rng(5), 800);
    const frames = [...encodeParts('PSBT', payload, 200), ...encodeUr('crypto-psbt', payload, 200).firstPass()];
    const ok = JSON.stringify([...payload]);
    for (let round = 0; round < 80; round++) {
      const scanner = new Scanner();
      for (let step = 0; step < 30; step++) {
        const frame = frames[Math.floor(random() * frames.length)]!;
        const progress = scanner.offer(random() < 0.3 ? mangle(frame, random) : frame);
        if (progress.payload) {
          expect(JSON.stringify([...progress.payload])).toBe(ok);
        }
      }
    }
  });
});
