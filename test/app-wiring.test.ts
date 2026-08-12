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
  /* The refusal model moved out of Vault.swift into a file with no SwiftUI
   * in it, so that a compiler can check it — see Package.swift. Both are read
   * here: the enum lives in one and the screen that routes to it in the
   * other, and a code with no case in either is the drift this guards. */
  const swift =
    readFileSync('ios/LabyrinthVault/Model/Refusal.swift', 'utf8') +
    readFileSync('ios/LabyrinthVault/Model/Vault.swift', 'utf8');

  /** Codes that psbt.ts can raise with fatal: true. */
  const fatalCodes = new Set(
    [...psbt.matchAll(/code:\s*'([a-z-]+)',\s*\n\s*fatal:\s*true/g)].map((m) => m[1]!),
  );
  // `unreadable` is raised through failed(), which does not match the pattern.
  fatalCodes.add('unreadable');

  /* Codes raised by the bridge rather than by the reader. They are exported
   * as constants and read from the constant here rather than retyped, so a
   * rename cannot be made to pass by renaming the copy in this file. */
  for (const module of ['src/keys/monerotx.ts']) {
    const text = readFileSync(module, 'utf8');
    for (const match of text.matchAll(/^export const [A-Z_]+ = '([a-z-]+)';/gm)) {
      fatalCodes.add(match[1]!);
    }
  }

  it('found the fatal codes, so a pass means something', () => {
    expect(fatalCodes.size).toBeGreaterThanOrEqual(6);
    expect(fatalCodes.has('opaque-output')).toBe(true);
    expect(fatalCodes.has('unusual-sighash')).toBe(true);
    expect(fatalCodes.has('monero-file-unsupported')).toBe(true);
  });

  it('names its bridge refusals with constants, not with literals', () => {
    /* A literal in host.ts is a code the loop above cannot see, which means a
     * code the Swift side was never checked against. */
    const host = readFileSync('src/bridge/host.ts', 'utf8');
    expect(host).toMatch(/failCoded\(MONERO_UNSUPPORTED,/);
    const literals = [...host.matchAll(/failCoded\('([a-z-]+)'/g)].map((m) => m[1]!);
    expect(literals, 'these refusal codes should come from a constant').toEqual([]);
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

describe('the Swift a compiler can actually check', () => {
  /* Package.swift builds the platform-free half of the app — the transaction
   * shapes, the refusal model, the passphrase encoding — as a real SwiftPM
   * target with real tests, on any machine with a Swift toolchain. That is
   * worth a great deal more than the regex guards in this file, and it works
   * only while the boundary stays clean: one Apple import in a listed file and
   * the target stops building everywhere except Xcode, at which point the
   * tempting fix is to drop the target from the pipeline. */

  const manifest = readFileSync('Package.swift', 'utf8');
  /* Only the `sources:` array. The first version of this matched every Swift
   * path in the file and therefore also matched the `exclude:` list — which is
   * where Vault.swift is named precisely *because* it imports SwiftUI. A guard
   * that reads the exclusion list as the inclusion list fails on the file it
   * was told to ignore. */
  const sourcesBlock = /sources:\s*\[([^\]]*)\]/.exec(manifest)?.[1] ?? '';
  const listed = [...sourcesBlock.matchAll(/"([^"]+\.swift)"/g)].map((m) => m[1]!);

  it('lists the files it claims to compile', () => {
    expect(listed.length, 'Package.swift compiles nothing').toBeGreaterThan(3);
    expect(listed).toContain('Model/Refusal.swift');
    expect(listed).toContain('Model/TxSummary.swift');
    expect(listed).toContain('Support/Passphrase.swift');
  });

  it('compiles nothing that imports an Apple framework', () => {
    /* The whole boundary in one assertion. `Refusal` and `TxSummary` were
     * inside Vault.swift next to `import SwiftUI` until they were pulled out
     * — which is why a non-exhaustive switch in `Refusal.detail`, missing five
     * of its nine cases, survived in this repository unnoticed. */
    const appleOnly = /^import (SwiftUI|Combine|JavaScriptCore|CryptoKit|CoreImage|UIKit)\b/m;
    for (const relative of listed) {
      const text = readFileSync(`ios/LabyrinthVault/${relative}`, 'utf8');
      const found = appleOnly.exec(text)?.[1];
      expect(found, `${relative} imports ${found}, so it can only build in Xcode`).toBeUndefined();
    }
  });

  it('keeps the security-critical model on the compiled side', () => {
    /* Not merely "some files compile". These specific ones: what a
     * confirmation screen is allowed to know, what stops a signature, and how
     * a passphrase becomes bytes. */
    const refusal = readFileSync('ios/LabyrinthVault/Model/Refusal.swift', 'utf8');
    expect(refusal).toMatch(/enum Refusal/);
    expect(refusal).toMatch(/var detail: String/);
    const summary = readFileSync('ios/LabyrinthVault/Model/TxSummary.swift', 'utf8');
    expect(summary).toMatch(/struct TxSummary/);
  });

  it('runs those tests as part of the suite, and says so when it cannot', () => {
    const script = readFileSync('scripts/swift-check.sh', 'utf8');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test'], 'npm test does not run the Swift check').toMatch(/swift:check/);
    expect(script).toMatch(/swift build/);
    expect(script).toMatch(/swift test/);
    /* A missing toolchain must skip loudly rather than either failing the
     * suite or passing silently. Both of those teach people to ignore it. */
    expect(script).toMatch(/being skipped/);
    expect(script).toMatch(/syntax only/);
    /* And it must say how to stop having to skip. A check that reports its own
     * absence and leaves you to work out the fix gets skipped forever. */
    expect(script).toMatch(/install-swift\.sh/);
    const install = readFileSync('scripts/install-swift.sh', 'utf8');
    /* The toolchain compiles everything in this repository that ends up on a
     * signing device, so it is checked twice and neither check is optional:
     * the signature says the Swift project made it, the digest says it is the
     * build this repository was checked against. */
    expect(install).toMatch(/gpg --status-fd 1 --verify/);
    expect(install).toMatch(/GOODSIG/);
    expect(install).toMatch(/KEY_FINGERPRINT="[0-9A-F]{40}"/);
    expect(install).toMatch(/SHA256="[0-9a-f]{64}"/);
  });
});

describe('a passphrase is never a string on either side of the bridge', () => {
  /* The rule and its enforcement, because this is a property that is true when
   * written and quietly false after the first "just pass the text through"
   * convenience. Three places have to hold it: the engine's Swift signatures,
   * the call sites, and the bridge itself, which refuses a string rather than
   * encoding one. */

  const engine = readFileSync('ios/LabyrinthVault/Support/Engine.swift', 'utf8');
  const vault = readFileSync('ios/LabyrinthVault/Model/Vault.swift', 'utf8');
  const passphrase = readFileSync('ios/LabyrinthVault/Support/Passphrase.swift', 'utf8');
  const host = readFileSync('src/bridge/host.ts', 'utf8');

  it('takes bytes in every Swift signature that carries one', () => {
    const signatures = [...engine.matchAll(/func \w+\([^)]*passphrase:\s*([^,)]+)/g)]
      .map((m) => m[1]!.trim());
    expect(signatures.length, 'Engine.swift has no passphrase parameters at all').toBeGreaterThan(1);
    for (const type of signatures) expect(type, 'a passphrase crosses as text').toBe('[UInt8]');
  });

  it('wipes what it made, on every path', () => {
    // withBytes, not bytes(from:), because withBytes is the one with the defer.
    expect(vault).toMatch(/Passphrase\.withBytes\(of:/);
    expect(passphrase).toMatch(/defer \{ Self\.wipe\(&bytes\) \}/);
    expect(passphrase).toMatch(/memset_s/);
  });

  it('normalises the same way the engine does, and says NFKD not NFD', () => {
    /* decomposedStringWithCanonicalMapping is NFD and is the easy thing to
     * type. It would agree with the engine on almost every passphrase and
     * disagree on ligatures, full-width characters and Roman numerals — a
     * vault that opens on the device that made it and nowhere else. */
    expect(passphrase).toMatch(/decomposedStringWithCompatibilityMapping/);
    expect(passphrase, 'that is NFD, and the engine uses NFKD')
      .not.toMatch(/decomposedStringWithCanonicalMapping/);
    const seal = readFileSync('src/keys/seal.ts', 'utf8');
    expect(seal).toMatch(/normalize\('NFKD'\)/);
  });

  it('refuses a string at the bridge rather than encoding one', () => {
    const wire = /function passphraseFromWire[\s\S]*?\n\}/.exec(host)?.[0];
    expect(wire, 'host.ts has no passphraseFromWire').toBeDefined();
    expect(wire!, 'it must require an array, not merely prefer one')
      .toMatch(/if \(!Array\.isArray\(value\)/);
    expect(wire!).not.toMatch(/TextEncoder|typeof value === 'string'/);
  });

  it('has a Swift test for the half of the contract TypeScript cannot reach', () => {
    /* NFKD is implemented twice, in two runtimes, against two Unicode
     * versions. TypeScript's half is checked in test/primitives.test.ts; the
     * Swift half is a real XCTest that `npm run swift:check` runs. */
    const swiftTest = readFileSync(
      'ios/LabyrinthVaultTests/PassphraseContractTests.swift', 'utf8',
    );
    expect(swiftTest).toMatch(/primitives/);
    expect(swiftTest).toMatch(/passphraseNormalisation/);
    /* It runs now — `swift test`, in this suite. What it must keep saying is
     * the limit of what a pass off a device proves: NFKD on Linux is
     * swift-corelibs-foundation's, and on a phone it is Apple's. Two
     * implementations of one Unicode annex. A file that stopped saying so
     * would be overclaiming, which is the failure this repository minds most. */
    expect(swiftTest, 'it should state what a non-Apple pass does and does not prove')
      .toMatch(/swift-corelibs-foundation/);
  });
});

describe('the screen model matches the wire, field for field', () => {
  /* The seam that had already drifted once. `TxSummary` in Swift is a hand
   * written mirror of `WireSummary` in TypeScript, and nothing but this test
   * connects them. The first version was missing `yourNet`, had no case for an
   * output with no address, and — worst — modelled a single `destination`,
   * so a transaction paying two people would have shown one of them.
   *
   * Parsing Swift with regexes is crude. It is also the only thing standing
   * between the two halves, and it fails loudly, which is the requirement. */

  const wire = readFileSync('src/bridge/summary.ts', 'utf8');
  /* The shapes now live in their own file, compiled by Package.swift and
   * decoded from real engine output by WireContractTests.swift. This guard
   * still earns its place alongside that one: `Decodable` ignores a field it
   * has never heard of, so a wire field Swift silently drops would decode
   * cleanly and show nothing. Only comparing the lists catches that. */
  const swift = readFileSync('ios/LabyrinthVault/Model/TxSummary.swift', 'utf8') +
    readFileSync('ios/LabyrinthVault/Model/MoneroSummary.swift', 'utf8');

  /**
   * TypeScript types, translated into the Swift they must be written as.
   *
   * Names alone are not enough, and finding that out was the point of trying
   * to break this test: changing `address: String?` to `address: String` in
   * the Swift model broke nothing, because a name-only comparison cannot see
   * optionality. An output whose address is not optional is an output whose
   * unreadable case has quietly stopped existing.
   */
  const TYPES: Record<string, string> = {
    string: 'String',
    'string | null': 'String?',
    number: 'Int',
    boolean: 'Bool',
    'WireInput[]': '[TxInput]',
    'WireOutput[]': '[TxOutput]',
    'WireWarning[]': '[TxWarning]',
    'WireMoneroOutput[]': '[MoneroOutput]',
  };

  /** `name: SwiftType` for every field of a TypeScript interface. */
  function tsFields(name: string): string[] {
    const start = wire.indexOf(`export interface ${name} {`);
    expect(start, `${name} not found in the bridge`).toBeGreaterThan(-1);
    const body = wire.slice(start, wire.indexOf('\n}', start));
    return [...body.matchAll(/^\s{2}(\w+)([?]?):\s*([^;]+);/gm)]
      .map((m) => {
        const [, field, optional, type] = m;
        const swiftType = TYPES[type!.trim()];
        expect(swiftType, `no Swift equivalent recorded for "${type!.trim()}" on ${name}.${field}`)
          .toBeDefined();
        // An optional TS field and a nullable one both land as Swift optional.
        const finalType = optional === '?' && !swiftType!.endsWith('?') ? `${swiftType}?` : swiftType!;
        return `${field}: ${finalType}`;
      })
      .sort();
  }

  /** `name: Type` for every stored property of a Swift struct. */
  function swiftFields(name: string): string[] {
    const start = swift.indexOf(`struct ${name}:`);
    expect(start, `${name} not found in the Swift model`).toBeGreaterThan(-1);
    const body = swift.slice(start, swift.indexOf('\n}', start));
    return [...body.matchAll(/^\s{4}let (\w+):\s*(\S+)$/gm)]
      .map((m) => `${m[1]}: ${m[2]}`)
      .sort();
  }

  const pairs: [string, string][] = [
    ['WireSummary', 'TxSummary'],
    ['WireOutput', 'TxOutput'],
    ['WireInput', 'TxInput'],
    ['WireWarning', 'TxWarning'],
    ['WireMoneroSummary', 'MoneroSummary'],
    ['WireMoneroOutput', 'MoneroOutput'],
  ];

  it('found both sides, so a pass means something', () => {
    for (const [ts, sw] of pairs) {
      expect(tsFields(ts).length, ts).toBeGreaterThan(2);
      expect(swiftFields(sw).length, sw).toBeGreaterThan(2);
    }
  });

  for (const [ts, sw] of pairs) {
    it(`${sw} has exactly the fields and types of ${ts}`, () => {
      expect(swiftFields(sw), `${sw} drifted from ${ts}`).toEqual(tsFields(ts));
    });
  }

  it('models outputs as a list, not as one destination', () => {
    // The specific regression. A single destination cannot represent a
    // transaction that pays two people, and the screen would show one.
    expect(swift).toMatch(/let outputs:\s*\[TxOutput\]/);
    expect(swift).toMatch(/let inputs:\s*\[TxInput\]/);
    expect(swift).not.toMatch(/let destination:\s*String/);
  });

  it('makes an unreadable address representable on the output itself', () => {
    /* Scoped to TxOutput rather than grepping the file: TxInput also has an
     * optional address, so a whole-file match passed even with TxOutput's
     * made non-optional. */
    expect(swiftFields('TxOutput')).toContain('address: String?');
  });

  it('does no money arithmetic of its own, anywhere in the app tree', () => {
    /* Every amount arrives formatted by `formatBtc`, which has tests. A second
     * implementation of what a satoshi is worth is how two screens come to
     * disagree about a number, and the screen that is wrong is the one a
     * person read before approving. */
    const tree = readdirSync('ios/LabyrinthVault', { withFileTypes: true });
    const swiftFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.swift')) swiftFiles.push(path);
      }
    };
    expect(tree.length).toBeGreaterThan(0);
    walk('ios/LabyrinthVault');
    expect(swiftFiles.length).toBeGreaterThan(5);

    for (const path of swiftFiles) {
      /* The generated digest file is sixty-four characters of hexadecimal, and
       * a long enough hexadecimal string eventually contains `1e8`. One did.
       * That is the fifth guard in this repository to fail on text that was
       * never code, and the fix is the same as the other four: look only at
       * what somebody wrote. Nothing in a generated constant can be doing
       * arithmetic. */
      if (path.endsWith('BundleDigest.swift')) continue;
      const text = readFileSync(path, 'utf8');
      expect(text, `${path} converts satoshis`).not.toMatch(/100_?000_?000|1e8/);
      expect(text, `${path} formats a number itself`).not.toMatch(/NumberFormatter|Decimal\(/);
    }
  });
});

describe('Swift calls only functions the engine actually has', () => {
  /* The third cross-language contract in this file, and the one with the most
   * room to rot: Swift names host functions as *strings*, so a typo or a
   * renamed export compiles fine and fails on a phone, at the moment somebody
   * is trying to sign something. */

  const host = readFileSync('src/bridge/host.ts', 'utf8');
  const engine = readFileSync('ios/LabyrinthVault/Support/Engine.swift', 'utf8');

  /** Every key of the exported `api` object. */
  const hostFunctions = (() => {
    const start = host.indexOf('export const api = {');
    expect(start, 'the host api object moved').toBeGreaterThan(-1);
    const body = host.slice(start, host.indexOf('\n};', start));
    return new Set([...body.matchAll(/^  (\w+):\s*guarded\(/gm)].map((m) => m[1]!));
  })();

  /** Every name Swift passes to call/callVoid/raw. */
  const swiftCalls = new Set(
    [...engine.matchAll(/\b(?:call|callVoid|raw)\w*\(\s*"(\w+)"/g)].map((m) => m[1]!),
  );

  it('found both lists, so a pass means something', () => {
    expect(hostFunctions.size).toBeGreaterThan(8);
    expect(swiftCalls.size).toBeGreaterThan(8);
  });

  it('names nothing the host does not export', () => {
    const missing = [...swiftCalls].filter((name) => !hostFunctions.has(name)).sort();
    expect(missing, 'Swift calls these and the engine has no such function').toEqual([]);
  });

  it('pins the engine contract version on both sides', () => {
    const hostVersion = /export const HOST_VERSION = (\d+)/.exec(host)?.[1];
    const swiftVersion = /static let expectedVersion = (\d+)/.exec(engine)?.[1];
    expect(hostVersion).toBeDefined();
    expect(swiftVersion, 'Engine.swift does not pin a version').toBe(hostVersion);
  });

  it('has no path that returns a private key across the bridge', () => {
    /* The bridge hands out descriptions and signatures. If a function ever
     * returns key material, it becomes a string in Swift, unwipeable, one
     * `print` away from a log. */
    for (const banned of ['privateKey', 'spendSecret', 'viewSecret', 'seedHex', 'entropyHex']) {
      expect(hostFunctions.has(banned), `${banned} is an engine entry point`).toBe(false);
      expect(engine, `Engine.swift decodes ${banned}`).not.toMatch(new RegExp(`let ${banned}\\b`));
    }
  });

  it('keeps the reveal of recovery words conspicuous on both sides', () => {
    // It is allowed to exist. It is not allowed to be called something bland.
    expect(hostFunctions.has('revealBackup')).toBe(true);
    expect(engine).toMatch(/func revealBackup\(\)/);
  });
});
