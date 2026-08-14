/*
 * Re-sealing a vault under a different passphrase.
 *
 * This exists for one caller: the migration that moves a vault sealed under a
 * typed passphrase alone onto the two-layer scheme, where the device's
 * keychain secret participates. That migration overwrites the only copy of
 * somebody's keys, so the interesting tests here are not the happy path. They
 * are the ones about what must still be true when it goes wrong.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const BUNDLE = 'ios/LabyrinthVault/Resources/vault.bundle.js';

type Api = Record<string, (...args: unknown[]) => string>;

/**
 * A stand-in derivation, so these tests can be about re-sealing.
 *
 * `runInNewContext` gives the bundle no JIT, which makes one real Argon2id
 * pass at DEFAULT_KDF take about ninety seconds here — the same effect that
 * made an unlock take a minute on the phone. Seven vaults would be eleven
 * minutes of test suite to check some `if` statements.
 *
 * So the tests install their own derivation through the same seam
 * `Engine.swift` uses. This is legitimate precisely because the derivation is
 * not what is under test: that agreement is pinned against the Argon2
 * reference in test/primitives.test.ts and ios/LabyrinthVaultKDFTests, and the
 * seam itself in test/native-kdf.test.ts. What is under test here is whether
 * re-sealing keeps the keys and refuses the right things.
 *
 * It must still be a real function of its inputs, or a wrong passphrase would
 * produce the right key and every refusal test would pass for the wrong
 * reason. This mixes every byte of both.
 */
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

const load = (): Api => {
  const context: Record<string, unknown> = { __labyrinthArgon2id: cheapKdf };
  runInNewContext(readFileSync(BUNDLE, 'utf8'), context);
  const api = context.LabyrinthVault as Api;
  // If the seam ever stops working, these tests must not silently start
  // taking ninety seconds a vault instead.
  expect(JSON.parse(api.version!()).kdf).toBe('native');
  return api;
};

const call = (api: Api, name: string, ...args: unknown[]) => JSON.parse(api[name]!(...args));
const bytes = (text: string) => Array.from(new TextEncoder().encode(text));
const hexOf = (n: number, seed: number) =>
  Array.from({ length: n }, (_, i) => ((i * seed + 11) & 0xff).toString(16).padStart(2, '0')).join('');

const OLD = 'the passphrase it was made with';
const DEVICE = 'c1d0a4f7e2b95836aa41c07d9e3f5b28c1d0a4f7e2b95836aa41c07d9e3f5b28';
const NEW = `${DEVICE}\n${OLD}`;

describe('reseal', () => {
  let api: Api;
  let sealed: string;

  beforeEach(() => {
    api = load();
    const made = call(api, 'create', hexOf(88, 37), bytes(OLD));
    expect(made.ok, made.problem).toBe(true);
    sealed = made.sealed;
  });

  it('produces a blob that opens under the new passphrase and not the old', () => {
    const again = call(api, 'reseal', sealed, bytes(OLD), bytes(NEW), hexOf(40, 13));
    expect(again.ok, again.problem).toBe(true);
    expect(again.sealed).not.toBe(sealed);

    expect(call(api, 'unlock', again.sealed, bytes(NEW)).ok).toBe(true);
    expect(call(api, 'unlock', again.sealed, bytes(OLD)).ok).toBe(false);
  });

  it('keeps the same keys, which is the entire point', () => {
    /* A migration that silently produced a *different* vault would look like
     * a success and lose the money. The account key is the identity. */
    const before = call(api, 'unlock', sealed, bytes(OLD));
    const beforeZpub = before.btcAccount.zpub;
    const beforeXmr = before.xmrAddress;

    const again = call(api, 'reseal', sealed, bytes(OLD), bytes(NEW), hexOf(40, 13));
    const after = call(api, 'unlock', again.sealed, bytes(NEW));

    expect(after.btcAccount.zpub).toBe(beforeZpub);
    expect(after.xmrAddress).toBe(beforeXmr);
  });

  it('refuses a wrong current passphrase without touching anything', () => {
    const attempt = call(api, 'reseal', sealed, bytes('not it'), bytes(NEW), hexOf(40, 13));
    expect(attempt.ok).toBe(false);
    expect(attempt.sealed).toBeUndefined();
    // The original still opens, unchanged.
    expect(call(api, 'unlock', sealed, bytes(OLD)).ok).toBe(true);
  });

  it('refuses anything that is not a sealed vault', () => {
    for (const bad of ['', 'zz', hexOf(20, 3)]) {
      const attempt = call(api, 'reseal', bad, bytes(OLD), bytes(NEW), hexOf(40, 13));
      expect(attempt.ok).toBe(false);
    }
  });

  it('refuses randomness of the wrong length rather than stretching it', () => {
    for (const bad of [hexOf(39, 5), hexOf(41, 5), '']) {
      const attempt = call(api, 'reseal', sealed, bytes(OLD), bytes(NEW), bad);
      expect(attempt.ok).toBe(false);
      expect(attempt.problem).toMatch(/randomness/);
    }
  });

  it('refuses a passphrase that arrives as a string', () => {
    /* Same contract as everywhere else: a string cannot be wiped, so the
     * convenient path must not quietly become the unwipeable one. */
    const attempt = call(api, 'reseal', sealed, OLD, NEW, hexOf(40, 13));
    expect(attempt.ok).toBe(false);
  });

  it('leaves the session alone', () => {
    /* Re-sealing is not unlocking. A locked vault stays locked, so a migration
     * cannot be a back door into an open session. */
    expect(call(api, 'unlocked').unlocked).toBe(false);
    const again = call(api, 'reseal', sealed, bytes(OLD), bytes(NEW), hexOf(40, 13));
    expect(again.ok).toBe(true);
    expect(call(api, 'unlocked').unlocked).toBe(false);
  });
});
