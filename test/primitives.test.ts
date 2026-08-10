/**
 * The vectors both languages have to agree with.
 *
 * `test/seal.test.ts` already pins Argon2id and XChaCha20-Poly1305 against the
 * reference C code and libsodium, but it pins them *in TypeScript*, in
 * expressions only TypeScript can evaluate. The moment a native implementation
 * of any of these exists — and docs/native-primitives.md is about when that
 * should happen — it needs the same oracle, and re-typing the digests into a
 * Swift file would create two copies that can drift.
 *
 * So the vectors live in a JSON file that either language can read, and this
 * test proves the TypeScript side agrees with it. `ios/LabyrinthVaultTests/`
 * holds the Swift half.
 *
 * The passphrase normalisation section is the one that is not merely
 * convenient. NFKD in `src/keys/seal.ts` and NFKD in Passphrase.swift are two
 * implementations of the same Unicode operation, in two runtimes, on two
 * Unicode versions that are not guaranteed to be the same one. If they ever
 * disagree the failure is silent and awful: a vault that opens on the phone
 * that sealed it and on nothing else, discovered by somebody restoring a
 * backup after losing that phone.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { argon2id } from '@noble/hashes/argon2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { passphraseToBytes } from '../src/keys/seal';

interface Fixture {
  note: string;
  why: string;
  argon2id: {
    password: string; salt: string; t: number; m: number; p: number; dkLen: number;
    key: string; source: string;
  }[];
  xchacha20poly1305: {
    keyPattern: string; noncePattern: string; adPattern: string;
    plaintext: string; ciphertext: string; source: string;
  }[];
  keccak256: { input: string; digest: string }[];
  passphraseNormalisation: { note: string; text: string; nfkdUtf8: string }[];
}

const fixture: Fixture = JSON.parse(
  readFileSync('test/fixtures/primitives.json', 'utf8'),
) as Fixture;

const enc = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

describe('the fixture is worth reading', () => {
  it('says where every value came from', () => {
    expect(fixture.note).toMatch(/not this repository/);
    for (const vector of fixture.argon2id) expect(vector.source).toMatch(/reference/i);
    for (const vector of fixture.xchacha20poly1305) expect(vector.source).toMatch(/libsodium/);
  });

  it('has enough in it to prove anything', () => {
    expect(fixture.argon2id.length).toBeGreaterThan(1);
    expect(fixture.keccak256.length).toBeGreaterThan(1);
    expect(fixture.passphraseNormalisation.length).toBeGreaterThan(9);
  });
});

describe('TypeScript agrees with the fixture', () => {
  it('Argon2id', () => {
    for (const v of fixture.argon2id) {
      const got = argon2id(enc(v.password), enc(v.salt), {
        t: v.t, m: v.m, p: v.p, dkLen: v.dkLen,
      });
      expect(hex(got), v.password).toBe(v.key);
    }
  });

  it('XChaCha20-Poly1305', () => {
    for (const v of fixture.xchacha20poly1305) {
      const key = Uint8Array.from({ length: 32 }, (_, i) => i);
      const nonce = Uint8Array.from({ length: 24 }, (_, i) => 0xa0 + i);
      const ad = Uint8Array.from({ length: 8 }, (_, i) => 0x50 + i);
      const got = xchacha20poly1305(key, nonce, ad).encrypt(enc(v.plaintext));
      expect(hex(got)).toBe(v.ciphertext);
    }
  });

  it('Keccak-256', () => {
    for (const v of fixture.keccak256) {
      expect(hex(keccak_256(enc(v.input))), v.input).toBe(v.digest);
    }
  });

  it('passphrase normalisation, character for character', () => {
    for (const v of fixture.passphraseNormalisation) {
      expect(hex(passphraseToBytes(v.text)), v.note).toBe(v.nfkdUtf8);
    }
  });
});

describe('the normalisation vectors actually test normalisation', () => {
  /* A set of vectors that are all plain ASCII would pass against an
   * implementation that did no normalising at all. These assertions are about
   * the fixture rather than the code: they fail if somebody trims the
   * interesting cases out of it. */

  it('includes inputs that normalisation changes', () => {
    const changed = fixture.passphraseNormalisation.filter(
      (v) => hex(new TextEncoder().encode(v.text)) !== v.nfkdUtf8,
    );
    expect(changed.length, 'no vector is affected by NFKD').toBeGreaterThan(4);
  });

  it('includes two spellings of the same passphrase', () => {
    /* The case that matters to a person: two keyboards, one visible
     * passphrase, and it has to open the same vault. */
    const pair = fixture.passphraseNormalisation.filter((v) => /e-acute/.test(v.note));
    expect(pair).toHaveLength(2);
    expect(pair[0]!.text).not.toBe(pair[1]!.text);
    expect(pair[0]!.nfkdUtf8).toBe(pair[1]!.nfkdUtf8);
  });

  it('includes a compatibility case, which is what the K in NFKD is for', () => {
    /* NFD would leave U+FB01 alone. NFKD folds it to "fi". Picking the wrong
     * one of those is the most likely way two implementations diverge, and it
     * would go unnoticed until somebody used a ligature in a passphrase. */
    const ligature = fixture.passphraseNormalisation.find((v) => /ligature/.test(v.note));
    expect(ligature).toBeDefined();
    expect(hex(passphraseToBytes(ligature!.text))).not.toBe(
      hex(new TextEncoder().encode(ligature!.text.normalize('NFD'))),
    );
  });
});
