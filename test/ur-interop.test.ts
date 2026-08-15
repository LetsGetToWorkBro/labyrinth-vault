/*
 * The way home for a wallet that is not ours.
 *
 * The vault could always *read* `ur:crypto-psbt`, so a PSBT from Sparrow or
 * Electrum came in fine. It had no way to hand one back: signing returned this
 * project's own LV1 frames, which nobody else reads, and the BC-UR encoder in
 * src/airgap/ur.ts was written, tested against the published vectors, and
 * called by nothing at all.
 *
 * So a round trip with any third-party wallet was import-only, and would have
 * failed at the last step of the first real signet test, after somebody had
 * already moved coins to set it up.
 *
 * These tests are the round trip in miniature: sign, then decode the frames
 * the way the far side will, and insist on getting back the exact bytes.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { UrCollector, parseUr, urPayloadBytes } from '../src/airgap/ur';
import { Scanner, formatOf } from '../src/airgap/scanner';

const BUNDLE = 'ios/LabyrinthVault/Resources/vault.bundle.js';
type Api = Record<string, (...args: unknown[]) => string>;

/** Fast stand-in derivation; the KDF is pinned elsewhere. See reseal.test.ts. */
const cheapKdf = (passphrase: number[], salt: number[], t: number, m: number, p: number, dkLen: number) => {
  const out: number[] = [];
  for (let i = 0; i < dkLen; i++) {
    let h = 0x811c9dc5 ^ (i * 2654435761) ^ (t * 31) ^ (m * 17) ^ (p * 7);
    for (const b of passphrase) h = Math.imul(h ^ b, 16777619) >>> 0;
    for (const b of salt) h = Math.imul(h ^ b, 16777619) >>> 0;
    out.push(h & 0xff);
  }
  return out;
};

const call = (api: Api, name: string, ...args: unknown[]) => JSON.parse(api[name]!(...args));

describe('a signed transaction can go back to a wallet that is not ours', () => {
  let api: Api;
  let signed: Record<string, unknown>;

  beforeAll(() => {
    const context: Record<string, unknown> = { __labyrinthArgon2id: cheapKdf };
    runInNewContext(readFileSync(BUNDLE, 'utf8'), context);
    api = context.LabyrinthVault as Api;

    /* The demo vault and its demo transaction: a genuine PSBT built by the
     * same signer the online wallet uses, unbroadcastable by construction. It
     * comes back as frames, so it is read here the way the camera reads one,
     * which makes this the real path rather than a shortcut around it. */
    const demo = call(api, 'demoUnsigned');
    expect(demo.ok, demo.problem).toBe(true);
    const reader = new Scanner();
    let read;
    for (const frame of demo.frames as string[]) read = reader.offer(frame);
    expect(read!.payload, 'the demo frames did not reassemble').not.toBeNull();
    const psbtHex = Array.from(read!.payload!, (b) => b.toString(16).padStart(2, '0')).join('');

    const described = call(api, 'describe', psbtHex);
    expect(described.ok, described.problem).toBe(true);
    signed = call(api, 'sign', psbtHex, (described.summary as Record<string, string>).digest);
    expect(signed.ok, signed.problem as string).toBe(true);
  });

  it('emits BC-UR frames at all, which is the whole of the fix', () => {
    expect(Array.isArray(signed.urFrames)).toBe(true);
    expect((signed.urFrames as string[]).length).toBeGreaterThan(0);
  });

  it('labels them crypto-psbt, which is what the far side subscribes to', () => {
    for (const frame of signed.urFrames as string[]) {
      expect(frame.toLowerCase().startsWith('ur:crypto-psbt/')).toBe(true);
      expect(formatOf(frame)).toBe('ur');
      expect(parseUr(frame)?.type).toBe('crypto-psbt');
    }
  });

  it('decodes back to the exact signed PSBT, byte for byte', () => {
    /* The test that would have caught the CBOR trap the encoder warns about:
     * frames without the wrapper look right and are unreadable. */
    const collector = new UrCollector();
    let progress;
    for (const frame of signed.urFrames as string[]) progress = collector.offer(frame);
    expect(progress!.cbor, 'the frames never reassembled').not.toBeNull();

    const psbt = urPayloadBytes(progress!.cbor!);
    expect(psbt, 'the CBOR wrapper is missing or wrong').not.toBeNull();
    const hex = Array.from(psbt!, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe(signed.psbt);
    // And it really is a PSBT, not a finished transaction.
    expect(hex.startsWith('70736274ff')).toBe(true);
  });

  it('is readable by the vault\'s own scanner, so the two directions agree', () => {
    /* The scanner is what reads Sparrow's codes on the way in. If it can read
     * what we emit, the format we speak and the format we understand are the
     * same one, which is a claim worth checking rather than assuming. */
    const scanner = new Scanner();
    let last;
    for (const frame of signed.urFrames as string[]) last = scanner.offer(frame);
    expect(last!.format).toBe('ur');
    expect(last!.payload).not.toBeNull();
  });

  it('still speaks its own wire for the Labyrinth wallet', () => {
    /* The LV1 frames carry the finished transaction, which is what our own
     * wallet broadcasts. Adding a second format must not remove the first. */
    expect(signed.frames).not.toBeNull();
    expect((signed.frames as string[])[0]!.startsWith('LV1:')).toBe(true);
  });
});

describe('a wallet that is not ours can be paired by camera', () => {
  /* The other half of interoperating, and the one that comes first in time:
   * without it there is nothing to send a PSBT *from*. Sparrow and Electrum
   * set up a watch-only wallet by scanning `ur:crypto-account`, and the vault
   * offered only its own frames, so pairing meant reading a zpub off the glass
   * and typing it. */
  let api: Api;

  beforeAll(() => {
    const context: Record<string, unknown> = { __labyrinthArgon2id: cheapKdf };
    runInNewContext(readFileSync(BUNDLE, 'utf8'), context);
    api = context.LabyrinthVault as Api;
    const demo = call(api, 'demoUnsigned');
    expect(demo.ok, demo.problem).toBe(true);
  });

  it('emits crypto-account frames for Bitcoin', () => {
    const exported = call(api, 'exportAccount', 'btc');
    expect(exported.ok, exported.problem as string).toBe(true);
    expect(Array.isArray(exported.urFrames)).toBe(true);
    for (const frame of exported.urFrames as string[]) {
      expect(frame.toLowerCase().startsWith('ur:crypto-account/')).toBe(true);
    }
  });

  it('carries the master fingerprint and one wpkh descriptor', () => {
    const exported = call(api, 'exportAccount', 'btc');
    const collector = new UrCollector();
    let progress;
    for (const frame of exported.urFrames as string[]) progress = collector.offer(frame);
    expect(progress!.cbor, 'the frames never reassembled').not.toBeNull();

    const hex = Array.from(progress!.cbor!, (b) => b.toString(16).padStart(2, '0')).join('');
    // a2 = map(2), 01 1a <fingerprint>, 02 81 = one descriptor,
    // then 308(404(303(...))) as BCR-2020-015 nests them.
    expect(hex.startsWith('a2011a')).toBe(true);
    expect(hex).toContain('0281d90134d90194d9012f');
  });

  it('offers nothing for Monero, because the registry has no type for it', () => {
    /* An empty answer rather than an invented one. Monero has no
     * crypto-account equivalent, and a payload shaped like one would be a
     * promise no wallet can keep. */
    const exported = call(api, 'exportAccount', 'xmr');
    expect(exported.ok, exported.problem as string).toBe(true);
    expect(exported.urFrames).toBeNull();
    // Its own wire still works.
    expect((exported.frames as string[]).length).toBeGreaterThan(0);
  });
});
