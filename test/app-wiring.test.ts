/**
 * The React Native wiring, run through the same code paths the phone runs.
 *
 * app/storage.ts and app/session.ts take their platform as arguments — the
 * store, the RNG, the foreground events — precisely so this file can be the
 * platform: a Map plays the Keychain, a counter plays the CSPRNG, a function
 * call plays the app switcher. What is asserted here is the behaviour the
 * README promises: ciphertext-only at rest, transient unseal with a
 * guaranteed wipe, both-layers-required passphrases, and keys that die when
 * the app leaves the foreground while watching survives.
 *
 * The tail of the file is guards over the source itself, in the house style
 * of no-network.test.ts: the polyfill order in boot.js, the Keychain
 * accessibility class, the absence of any sync attribute, and the absence of
 * clipboard code anywhere in the app tree.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEVICE_KEY,
  SEALED_KEY,
  calibrateForThisDevice,
  createVault,
  destroyVault,
  vaultExists,
  withUnsealedSeed,
  type SecretStore,
} from '../app/storage';
import { Session } from '../app/session';
import { KDF_LIMITS, looksSealed } from '../src/keys/seal';
import { addressAt, mnemonicFromEntropy, privateKeyAt } from '../src/keys/bitcoin';
import { toHex } from '../src/keys/monero';

/** Small enough to keep the suite fast; the floors in seal.ts still apply. */
const FAST_KDF = { t: 1, m: 8192, p: 1 };

/** The Keychain, played by a Map that remembers how it was asked to store. */
function fakeStore() {
  const items = new Map<string, { value: string; accessibility?: string }>();
  const store: SecretStore = {
    get: async (key) => items.get(key)?.value ?? null,
    set: async (key, value, options) => {
      items.set(key, { value, ...(options?.accessibility ? { accessibility: options.accessibility } : {}) });
    },
    remove: async (key) => {
      items.delete(key);
    },
  };
  return { store, items };
}

/** Deterministic bytes that never repeat, which is all seal() asks of them. */
function fakeRng() {
  let counter = 0;
  return (bytes: number) => {
    const out = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) out[i] = (i * 31 + ++counter) & 0xff;
    return out;
  };
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const mnemonic = mnemonicFromEntropy(new Uint8Array(32).fill(9));
const seedBytes = () => new TextEncoder().encode(mnemonic);

describe('sealed storage against the keystore', () => {
  it('stores only ciphertext, and the device passphrase goes passcode-bound', async () => {
    const { store, items } = fakeStore();
    const result = await createVault(store, fakeRng(), seedBytes(), { params: FAST_KDF });
    expect(result.ok).toBe(true);

    // Exactly two items: the device passphrase and the blob. Nothing else.
    expect([...items.keys()].sort()).toEqual([DEVICE_KEY, SEALED_KEY].sort());
    expect(items.get(DEVICE_KEY)!.accessibility).toBe('whenPasscodeSetThisDeviceOnly');
    expect(items.get(SEALED_KEY)!.accessibility).toBe('whenPasscodeSetThisDeviceOnly');

    // The blob is a sealed blob, and the seed appears nowhere in the store
    // in any encoding the store ever saw.
    expect(looksSealed(fromHex(items.get(SEALED_KEY)!.value))).toBe(true);
    const seedHex = toHex(seedBytes());
    for (const { value } of items.values()) {
      expect(value.includes(seedHex)).toBe(false);
      expect(value.includes(mnemonic)).toBe(false);
    }
  });

  it('round-trips the seed, and wipes it after use even so', async () => {
    const { store } = fakeStore();
    await createVault(store, fakeRng(), seedBytes(), { params: FAST_KDF });

    let captured: Uint8Array | null = null;
    const outcome = await withUnsealedSeed(store, undefined, (seed) => {
      captured = seed;
      return new TextDecoder().decode(seed);
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.value).toBe(mnemonic);
    // The buffer the callback saw has been zeroed behind it.
    expect(captured).not.toBeNull();
    expect([...captured!].every((byte) => byte === 0)).toBe(true);
  });

  it('wipes the seed even when the callback throws', async () => {
    const { store } = fakeStore();
    await createVault(store, fakeRng(), seedBytes(), { params: FAST_KDF });

    let captured: Uint8Array | null = null;
    await expect(
      withUnsealedSeed(store, undefined, (seed) => {
        captured = seed;
        throw new Error('mid-use failure');
      }),
    ).rejects.toThrow('mid-use failure');
    expect([...captured!].every((byte) => byte === 0)).toBe(true);
  });

  it('a layered user passphrase means both layers or nothing', async () => {
    const { store } = fakeStore();
    await createVault(store, fakeRng(), seedBytes(), {
      params: FAST_KDF,
      userPassphrase: 'correct horse',
    });

    const without = await withUnsealedSeed(store, undefined, () => 'opened');
    const wrong = await withUnsealedSeed(store, 'wrong horse', () => 'opened');
    const right = await withUnsealedSeed(store, 'correct horse', () => 'opened');

    expect(without.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    expect(right.ok).toBe(true);
  });

  it('exists and destroys, with no recovery path left behind', async () => {
    const { store, items } = fakeStore();
    expect(await vaultExists(store)).toBe(false);
    await createVault(store, fakeRng(), seedBytes(), { params: FAST_KDF });
    expect(await vaultExists(store)).toBe(true);
    await destroyVault(store);
    expect(await vaultExists(store)).toBe(false);
    expect(items.size).toBe(0);
  });

  it('calibration returns parameters this build will actually run', () => {
    // A timer that reports the target met immediately, so the walk stops at
    // its first, smallest step without burning CI minutes on real Argon2id.
    const ticks = [0, 5000];
    const params = calibrateForThisDevice(() => ticks.shift() ?? 10000);
    expect(params.m).toBeGreaterThanOrEqual(KDF_LIMITS.minM);
    expect(params.m).toBeLessThanOrEqual(KDF_LIMITS.maxM);
    expect(params.t).toBeGreaterThanOrEqual(KDF_LIMITS.minT);
  });
});

describe('the session and the foreground', () => {
  function openSession() {
    const session = new Session();
    session.unlock(seedBytes());
    return session;
  }

  it('unlocking opens a signing wallet', () => {
    const session = openSession();
    expect(session.state).toBe('signing');
    expect(privateKeyAt(session.current!, 0, 0)).not.toBeNull();
  });

  it('leaving the foreground wipes keys but keeps watching', () => {
    const session = openSession();
    const before = addressAt(session.current!, 0, 0).address;

    session.handleForeground('background');

    expect(session.state).toBe('watching');
    // Watching survives: same object, same addresses, no secrets.
    expect(addressAt(session.current!, 0, 0).address).toBe(before);
    expect(privateKeyAt(session.current!, 0, 0)).toBeNull();
  });

  it('the app switcher counts as leaving', () => {
    const session = openSession();
    session.handleForeground('inactive');
    expect(session.state).toBe('watching');
  });

  it('signing again requires a fresh unseal, and a fresh unseal restores it', () => {
    const session = openSession();
    session.handleForeground('background');
    expect(session.state).toBe('watching');
    session.unlock(seedBytes());
    expect(session.state).toBe('signing');
  });

  it('attaches to foreground events and locks through them', () => {
    const session = openSession();
    let emit: ((next: 'active' | 'background' | 'inactive') => void) | null = null;
    session.attach((handler) => {
      emit = handler;
      return () => {
        emit = null;
      };
    });
    emit!('background');
    expect(session.state).toBe('watching');
    session.detach();
    expect(emit).toBeNull();
  });
});

describe('guards over the app source itself', () => {
  function sources(dir: string): { path: string; text: string }[] {
    const out: { path: string; text: string }[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sources(path));
      else if (/\.(ts|tsx|js|swift|m|h)$/.test(entry.name)) {
        out.push({ path, text: readFileSync(path, 'utf8') });
      }
    }
    return out;
  }
  const files = sources('app');

  it('boot.js loads the CSPRNG before anything else', () => {
    const boot = readFileSync('app/boot.js', 'utf8');
    const firstImport = boot.match(/^\s*(import|const .* = require).*$/m)?.[0] ?? '';
    expect(firstImport).toContain('react-native-get-random-values');
    // And the entry point loads boot before the app.
    const entry = readFileSync('app/index.js', 'utf8');
    expect(entry.indexOf("import './boot'")).toBeGreaterThanOrEqual(0);
    expect(entry.indexOf("import './boot'")).toBeLessThan(entry.indexOf('./App'));
  });

  it('the keychain item class is passcode-bound and device-only', () => {
    const keychain = readFileSync('app/ios/VaultKeychain.swift', 'utf8');
    expect(keychain).toContain('kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly');
    // No sync attribute in any form: absence is the design, so presence —
    // even set to false — is a diff somebody has to explain.
    expect(keychain).not.toContain('kSecAttrSynchronizable');
  });

  it('nothing in the app tree touches the clipboard', () => {
    const clipboard = /(UIPasteboard\s*\.|@react-native-clipboard|\bClipboard\s*\.|expo-clipboard)/;
    const guilty = files.filter((f) => clipboard.test(f.text)).map((f) => f.path);
    expect(guilty, 'clipboard code appears in these files').toEqual([]);
  });

  it('nothing in the app tree opens a network path', () => {
    const network = /\b(URLSession|fetch\s*\(|XMLHttpRequest|WebSocket)\b/;
    const guilty = files.filter((f) => network.test(f.text)).map((f) => f.path);
    expect(guilty, 'network code appears in these files').toEqual([]);
  });
});

describe('the screen can name every refusal the reader makes', () => {
  /* A cross-language contract, and the reason it needs a guard: the refusals
   * live in TypeScript and the screen that shows them lives in Swift, so
   * nothing but this test connects the two. It had already drifted once — the
   * Swift enum said "the three conditions the reader refuses over" while
   * psbt.ts had grown to six — and a fatal condition the screen cannot name is
   * a fatal condition somebody has to guess at, or worse, one that arrives as
   * a default case that carries on.
   *
   * The mapping is by comment marker (`/// code-name`) rather than by parsing
   * Swift properly: crude, but it fails loudly when it goes stale, which is
   * the entire job. */

  const psbt = readFileSync('src/keys/psbt.ts', 'utf8');
  const swift = readFileSync('ios/LabyrinthVault/Model/Vault.swift', 'utf8');

  /** Codes that psbt.ts can raise with fatal: true. */
  const fatalCodes = new Set(
    [...psbt.matchAll(/code:\s*'([a-z-]+)',\s*\n\s*fatal:\s*true/g)].map((m) => m[1]!),
  );
  // `unreadable` is raised through failed(), which does not match the pattern.
  fatalCodes.add('unreadable');

  it('found the fatal codes, so a pass means something', () => {
    expect(fatalCodes.size).toBeGreaterThanOrEqual(6);
    expect(fatalCodes.has('opaque-output')).toBe(true);
    expect(fatalCodes.has('unusual-sighash')).toBe(true);
  });

  it('has a Swift case for every one of them', () => {
    const named = new Set(
      [...swift.matchAll(/\/\/\/\s*`([a-z-]+)`/g)].map((m) => m[1]!),
    );
    const missing = [...fatalCodes].filter((code) => !named.has(code)).sort();
    expect(missing, 'fatal codes with no case in Refusal').toEqual([]);
  });

  it('refuses rather than continues when it does not recognise a code', () => {
    // The catch-all exists and is a refusal, not a fallthrough.
    expect(swift).toMatch(/case unrecognised\(String\)/);
    expect(swift).toMatch(/NO SIGNATURE PRODUCED/);
  });

  it('offers no way forward from a refusal', () => {
    /* A refusal screen with a "continue" is not a refusal screen. Comments are
     * stripped first: the previous version of this test matched the word
     * "override" inside the doc comment that promises there isn't one, which
     * is a guard failing on the prose that describes it. */
    const code = swift
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/\b(continueAnyway|signRegardless|forceSign|ignoreWarnings)\b/i);
    expect(code).not.toMatch(/case\s+override\b/i);
  });
});
