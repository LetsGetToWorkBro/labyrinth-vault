/**
 * Guards that hold the two languages together.
 *
 * Everything here is a check no compiler can make: a name that has to match
 * across Swift and TypeScript, a Swift file that has to import the module it
 * calls into, a refusal code that has to exist on both sides. Most of the
 * Swift under `ios/` imports SwiftUI or JavaScriptCore, so
 * `scripts/swift-check.sh` can only parse it, and a parser is content with a
 * name that resolves to nothing. These tests are what stands in that gap.
 *
 * This file used to open with behavioural tests of `app/storage.ts` and
 * `app/session.ts`, running the React Native shell's logic against a Map
 * playing the Keychain. That shell has been deleted — it had no build system
 * and had never been compiled — and those tests went with it. What they
 * asserted about the Keychain now lives as source guards over
 * `SealedStore.swift`, which is the code that actually runs.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Every Swift source in the shipping app, for the tree-wide guards. */
function appSources(dir = 'ios/LabyrinthVault'): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...appSources(path));
    else if (/\.(swift|m|h)$/.test(entry.name)) out.push({ path, text: readFileSync(path, 'utf8') });
  }
  return out;
}

describe('guards over the app that actually ships', () => {
  const files = appSources();

  it('found the sources, so a pass means something', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('holds every keychain item to a passcode-bound, device-only class', () => {
    /* The blob is passcode-bound. The witness (which holds no secret, only
     * the fact a vault existed) is deliberately one class weaker so it
     * survives the passcode being turned off — that survival is its whole
     * purpose. The device half of the passphrase is passcode-bound like the
     * blob it protects: putting the two halves under different locks would
     * make the vault only as strong as the weaker one.
     *
     * No sync attribute in any form. Absence is the design, so presence, even
     * set to false, is a diff somebody has to explain. */
    const store = readFileSync('ios/LabyrinthVault/Support/SealedStore.swift', 'utf8');
    expect(store).toContain('kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly');
    expect(store).toContain('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
    expect(store).not.toContain('kSecAttrSynchronizable');
  });

  it('erases the device half with the vault it sealed', () => {
    /* Leaving it would mean the next vault made on this phone silently
     * inherits the last one's device secret, which is not a secret anybody
     * decided to reuse. */
    const store = readFileSync('ios/LabyrinthVault/Support/SealedStore.swift', 'utf8');
    const erase = store.slice(store.indexOf('static func erase()'));
    expect(erase).toContain('deviceAccount');
  });

  it('touches no clipboard', () => {
    const clipboard = /(UIPasteboard\s*\.|\bClipboard\s*\.)/;
    const guilty = files.filter((f) => clipboard.test(f.text)).map((f) => f.path);
    expect(guilty, 'clipboard code appears in these files').toEqual([]);
  });

  it('opens no network path', () => {
    const network = /\b(URLSession|NSURLConnection|CFSocket|fetch\s*\()/;
    const guilty = files.filter((f) => network.test(f.text)).map((f) => f.path);
    expect(guilty, 'network code appears in these files').toEqual([]);
  });
});

describe('a signature can leave the vault in a format somebody else reads', () => {
  /* The engine emits both wires; this is the half no compiler checks, which
   * is that the screen offers the second one. Frames nothing can display are
   * the same as no frames at all. */
  const signed = readFileSync('ios/LabyrinthVault/Screens/Signed.swift', 'utf8');

  it('offers the PSBT wire beside its own', () => {
    expect(signed).toMatch(/case psbt = "SPARROW · ELECTRUM"/);
    expect(signed).toMatch(/result\.urFrames/);
    expect(signed, 'the Labyrinth wire was dropped').toMatch(/result\.frames/);
  });

  it('decodes the field the engine actually sends', () => {
    const replies = readFileSync('ios/LabyrinthVault/Support/EngineReplies.swift', 'utf8');
    expect(replies).toMatch(/let urFrames: \[String\]\?/);
    expect(readFileSync('src/bridge/host.ts', 'utf8')).toMatch(/urFrames: new UrEncoder\(UR_PSBT/);
  });

  it('says which wallet each wire is for, rather than naming a format', () => {
    /* TXSIGNED and UR:CRYPTO-PSBT mean nothing to somebody holding two
     * phones. The names of the wallets do. */
    expect(signed).toMatch(/case labyrinth = "LABYRINTH"/);
    expect(signed.toLowerCase()).toContain('desktop wallets read');
  });
});

describe('the first screen explains the thing before asking for commitment', () => {
  const setup = readFileSync('ios/LabyrinthVault/Screens/Setup.swift', 'utf8');
  const declaration = setup.slice(
    setup.indexOf('private struct DeclarationView'),
    setup.indexOf('MARK: 02'),
  );

  it('names the parts of the model a person cannot guess', () => {
    /* The screen used to say what the phone becomes and stop there. Somebody
     * could finish setup without being told that a second device is required,
     * that everything crosses as a photograph, or that the backup is paper
     * they are about to write by hand. Each of those is a surprise that costs
     * money or time if it arrives late. */
    const said = declaration.toLowerCase();
    expect(said, 'never mentions the second device').toContain('another device');
    expect(said, 'never mentions how data crosses').toContain('qr code');
    expect(said, 'never mentions the paper backup').toMatch(/written by hand|on paper/);
    expect(said, 'never names what does the encrypting').toContain('argon2id');
  });

  it('holds the app to the same honesty rules as the site', () => {
    /* test/site-claims.test.ts bans these on the marketing site and the app
     * has never been held to them, which is backwards: the site is read once
     * and the app is the thing somebody trusts with keys.
     *
     * "No networking code in this build" is a claim about a binary and
     * survives inspection. "Never connects to the internet" is a claim about
     * a phone on a desk with its wifi on, and the app cannot see a radio. */
    const offline = /never\s+connects?\s+to\s+the\s+internet|is\s+(always\s+)?offline\b|cannot\s+connect\s+to\s+the\s+internet/i;
    const verified = /airgap\s+verified|verified\s+(the\s+)?airgap/i;
    const guilty: string[] = [];
    for (const { path, text } of appSources()) {
      const strings = [...text.matchAll(/"([^"\\]{12,})"/g)].map((m) => m[1]!).join(' ');
      if (offline.test(strings)) guilty.push(`${path}: claims the device is offline`);
      if (verified.test(strings)) guilty.push(`${path}: claims the airgap was verified`);
    }
    expect(guilty).toEqual([]);
  });

  it('claims nothing special about the cryptography', () => {
    /* Novel cryptography reads as a warning to anybody who knows the field,
     * and as a boast to anybody who does not. The interesting claim here is
     * about the build, not the algorithms. */
    const boast = /military[- ]grade|bank[- ]grade|unbreakable|proprietary\s+(encryption|cipher|algorithm)|our own (encryption|cipher)/i;
    const guilty: string[] = [];
    for (const { path, text } of appSources()) {
      if (boast.test(text)) guilty.push(path);
    }
    expect(guilty).toEqual([]);
  });
});

describe('every settings row says what is behind it', () => {
  /* From an audit of that screen. It was titled SECURITY, under a tab called
   * SECURITY, with a first row reading SECURITY DIAGNOSTICS, and its value
   * column mixed topics, statuses and facts with no pattern to learn. The
   * complaint that started it was the true one: you could not tell what any
   * row would open before tapping it.
   *
   * The fix is that every row carries a sentence naming what is inside. This
   * guards that, because a row added later without one costs nothing at
   * compile time and quietly undoes the audit. */
  const settings = readFileSync('ios/LabyrinthVault/Screens/Settings.swift', 'utf8');

  it('gives every row a description', () => {
    const entries = [...settings.matchAll(/Entry\(title: "([^"]+)"/g)].map((m) => m[1]!);
    expect(entries.length, 'no rows found, so a pass would mean nothing').toBeGreaterThanOrEqual(4);

    const insides = [...settings.matchAll(/inside: (?:vault\.[A-Za-z]+\s*\n?\s*\?\s*)?"([^"]+)"/g)];
    expect(insides.length, 'a row was added without an `inside`').toBeGreaterThanOrEqual(entries.length);
    for (const [, text] of insides) {
      expect(text!.length, `"${text}" is too short to tell anybody anything`).toBeGreaterThan(20);
    }
  });

  it('names the erase where a person can find it', () => {
    /* The one irreversible action in the app. It used to sit behind a row
     * labelled KEY MANAGEMENT with the value ENCRYPTED, which named neither
     * the recovery phrases nor the erase. */
    const recovery = settings.slice(settings.indexOf('RECOVERY PHRASES'));
    expect(recovery.slice(0, 400).toLowerCase()).toContain('erase');
  });

  it('marks rows that run something apart from rows that open something', () => {
    expect(settings).toMatch(/var acts: Bool = false/);
    expect(settings).toMatch(/acts: true/);
  });

  it('does not call the tab SECURITY any more, anywhere', () => {
    /* Three uses of one word for three different things was the original
     * complaint, and a stale VaultTabs(current:) elsewhere would light the
     * wrong tab. */
    const guilty: string[] = [];
    for (const { path, text } of appSources()) {
      if (/VaultTabs\(current: "SECURITY"\)/.test(text)) guilty.push(path);
    }
    expect(guilty).toEqual([]);
    expect(readFileSync('ios/LabyrinthVault/App.swift', 'utf8')).toContain('("SETTINGS", .settings)');
  });
});

describe('the vault seals under both layers, not just the typed one', () => {
  /* The device half is 32 bytes that never leave this phone's keychain, and
   * layering means AND: an extracted blob is useless off the device it was
   * sealed on. That property is worth more than any amount of key stretching
   * and it is one function call away from being silently lost, because a vault
   * sealed under the typed passphrase alone still works perfectly. It just
   * stops being protected against the case that matters.
   *
   * Nothing compiles this file off a Mac, so these are the guards.
   * `LayeredPassphraseTests` proves the bytes are right; this proves the app
   * asks for them. */
  const vault = readFileSync('ios/LabyrinthVault/Model/Vault.swift', 'utf8');
  const code = vault
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  it('creates under the layered passphrase', () => {
    const create = code.slice(code.indexOf('func beginCreate'), code.indexOf('func finishCreate'));
    expect(create, 'creation seals under the typed passphrase alone')
      .toMatch(/withLayeredBytes\(deviceHex:/);
    expect(create, 'creation still has an unlayered seal in it')
      .not.toMatch(/Passphrase\.withBytes\(of:/);
  });

  it('refuses to make a vault when the device half cannot be stored', () => {
    /* Falling back to a one-layer vault would be quietly giving somebody a
     * weaker vault than the one they asked for, which is the trade this whole
     * project exists to refuse. */
    const create = code.slice(code.indexOf('func beginCreate'), code.indexOf('func finishCreate'));
    expect(create).toMatch(/deviceHex == nil/);
    expect(create).toMatch(/No keys were made/);
  });

  it('tries the other scheme before calling a passphrase wrong', () => {
    /* The marker and the blob are two keychain items with no transaction
     * between them, so an interrupted migration can leave them disagreeing.
     * Without the fallback, a person with the right passphrase is told it is
     * wrong. */
    const open = code.slice(code.indexOf('func openVault'), code.indexOf('func migrateToLayeredScheme'));
    expect(open).toMatch(/existingDeviceSecret\(\)/);
    expect(open).toMatch(/attempt\(layeredWith: nil\)/);
  });

  it('migrates in an order where every interruption is survivable', () => {
    /* Device secret, then a re-seal the engine has already proved opens, then
     * the overwrite. Any earlier order can leave a blob nothing can open. */
    const migrate = code.slice(code.indexOf('func migrateToLayeredScheme'));
    const secretAt = migrate.indexOf('deviceSecretHex(orMakeWith');
    const resealAt = migrate.indexOf('engine.reseal');
    const saveAt = migrate.indexOf('SealedStore.save');
    expect(secretAt).toBeGreaterThan(-1);
    expect(resealAt).toBeGreaterThan(secretAt);
    expect(saveAt, 'the blob is overwritten before it has been re-sealed').toBeGreaterThan(resealAt);
  });

  it('re-seals inside the engine, so the secret never crosses the bridge', () => {
    const engine = readFileSync('ios/LabyrinthVault/Support/Engine.swift', 'utf8');
    expect(engine).toMatch(/func reseal\(sealedHex:/);
    const host = readFileSync('src/bridge/host.ts', 'utf8');
    expect(host).toMatch(/reseal: guarded\('reseal'/);
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

  it('refuses rather than continues when it does not recognize a code', () => {
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
    const appleOnly = /^import (SwiftUI|Combine|JavaScriptCore|CryptoKit|CoreImage|UIKit|Security)\b/m;
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

  it('normalizes the same way the engine does, and says NFKD not NFD', () => {
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
   * output with no address, and — worst — modeled a single `destination`,
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

describe('the native derivation is wired by the same name on both sides', () => {
  /* The one call that goes JavaScript to Swift rather than the other way, and
   * it is joined by a string literal in two languages neither of which can see
   * the other. Nothing in a compiler catches a typo here.
   *
   * What a typo does is not fail. `adoptNativeArgon2id` finds no function,
   * installs nothing, and every derivation quietly runs the interpreted path:
   * a working app with a sixty-seven second unlock, which is precisely the app
   * we already had. The version reply says "engine" instead of "native" and
   * nobody is looking at it. So the name is asserted here, in the one place
   * that reads both files. */
  const NAME = '__labyrinthArgon2id';

  it('Engine.swift installs it under that name, before evaluating the bundle', () => {
    const swift = readFileSync('ios/LabyrinthVault/Support/Engine.swift', 'utf8');
    expect(swift, `Engine.swift does not install ${NAME}`)
      .toMatch(new RegExp(`setObject\\(derive, forKeyedSubscript: "${NAME}"`));

    /* Order matters and is invisible at a glance: the bundle's top level reads
     * the global as it loads, so an install after `evaluateScript` would be an
     * install nothing ever sees. */
    const installedAt = swift.indexOf(NAME);
    const evaluatedAt = swift.indexOf('context.evaluateScript(source)');
    expect(installedAt).toBeGreaterThan(-1);
    expect(evaluatedAt).toBeGreaterThan(-1);
    expect(installedAt, 'the derivation is installed after the bundle is evaluated, so it is never adopted')
      .toBeLessThan(evaluatedAt);
  });

  it('Engine.swift imports the module Argon2id lives in', () => {
    /* This one cost an archive. `Argon2id` is in the LabyrinthVaultKDF module
     * because it is a separate SwiftPM target, which is the whole reason
     * `swift build` can check it on Linux. The price is that Engine.swift
     * needs an import, and Engine.swift imports JavaScriptCore and CryptoKit,
     * so it is tier 2 in scripts/swift-check.sh: parsed, never type checked.
     * A parser is perfectly happy with a name that resolves to nothing.
     *
     * So the pairing is asserted here, where both halves are just text. If a
     * file calls into that module, it has to say so. */
    const swift = readFileSync('ios/LabyrinthVault/Support/Engine.swift', 'utf8');
    expect(swift, 'Engine.swift calls Argon2id without importing LabyrinthVaultKDF')
      .toMatch(/^import LabyrinthVaultKDF$/m);
  });

  it('and no other Apple-only file calls Argon2id without importing it', () => {
    /* The general form of the same mistake, for the next file that reaches for
     * the native derivation. Everything under ios/LabyrinthVault is parsed and
     * not compiled off a Mac, so this is the only place the two can be held
     * together before an archive. */
    const guilty: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.swift')) {
          const text = readFileSync(path, 'utf8');
          const code = text
            .split('\n')
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join('\n');
          if (/\bArgon2id\s*\./.test(code) && !/^import LabyrinthVaultKDF$/m.test(text)) {
            guilty.push(path);
          }
        }
      }
    };
    walk('ios/LabyrinthVault');
    expect(guilty, 'these call Argon2id without importing LabyrinthVaultKDF').toEqual([]);
  });

  it('host.ts reads that same name', () => {
    const host = readFileSync('src/bridge/host.ts', 'utf8');
    expect(host, `host.ts does not read ${NAME}`).toContain(NAME);
  });

  it('seal.ts keeps every decision, and takes only bytes and numbers across', () => {
    /* The rule in docs/native-primitives.md is that the primitive moves and
     * the judgement does not. These are the names of the judgement: if any of
     * them ever needs to be known on the far side of the seam, the seam is in
     * the wrong place. */
    const seal = readFileSync('src/keys/seal.ts', 'utf8');
    expect(seal).toMatch(/export function setNativeArgon2id/);
    for (const decision of ['KDF_LIMITS', 'paramsAcceptable', 'HEADER_BYTES', 'MAGIC']) {
      expect(seal, `${decision} left seal.ts`).toContain(decision);
    }
    const swift = readFileSync('ios/LabyrinthVault/Support/Engine.swift', 'utf8');
    for (const decision of ['KDF_LIMITS', 'paramsAcceptable', 'HEADER_BYTES']) {
      expect(swift, `${decision} appears in Swift; judgement is leaking across the seam`)
        .not.toContain(decision);
    }
  });
});

describe('the QR aperture never subscripts a frame it does not have', () => {
  /* Opening Export crashed the app, every time, and it was not the engine.
   *
   * SwiftUI evaluates a view's body before its `onAppear`. `ExportView` starts
   * with no frames and fetches them on appear, because the watch-only export
   * comes from the engine's live session and there is no session until the
   * vault is open. So the first render asked an empty array for element zero,
   * which in Swift is not nil — it is a trap instruction and a dead process.
   *
   * The fix belongs in the aperture rather than in Export: three other screens
   * pass frames straight out of a reply and happen to be non-empty today, and
   * "happens to be non-empty" is not an invariant anybody wrote down. */
  const aperture = 'ios/LabyrinthVault/Support/QRCode.swift';

  it('reads through a guarded accessor, not a bare subscript', () => {
    const text = readFileSync(aperture, 'utf8');
    const code = text
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code, 'frames[...] is subscripted directly again').not.toMatch(/frames\[\s*index\s*\]/);
    expect(code, 'the empty case is not handled').toMatch(/frames\.isEmpty/);
  });

  it('clamps the index it does use, because the count is the caller\'s', () => {
    const text = readFileSync(aperture, 'utf8');
    expect(text, 'a payload that shrinks would index past the end')
      .toMatch(/min\(index, frames\.count - 1\)/);
  });
});

describe('a screen that runs the KDF holds the phone awake', () => {
  /* The vault crashed on the setup screen on the first phone it ever ran on,
   * and the reason was not the cryptography.
   *
   * Argon2id interpreted takes minutes per pass, and making a vault runs two.
   * Both are on a detached task, so the main thread stays responsive and the
   * screen keeps drawing, which is why this looked like a working screen right
   * up until it died. The screen also asks a person to sit and watch it
   * without touching anything, and Auto Lock is thirty seconds out of the box.
   * The phone locks itself, the app goes to the background, and iOS stops an
   * app that is still burning CPU there.
   *
   * The copy said DO NOT LEAVE THIS SCREEN, which was addressed to the wrong
   * party. Nobody left. The phone did.
   *
   * So both screens that can be up while a derivation runs turn the idle timer
   * off, and both turn it back on. That second half is what this mostly
   * guards: `isIdleTimerDisabled` is a system-wide setting owned by whoever
   * set it last, and a screen that disables it and never restores it is a
   * battery bug that gets filed against something else entirely. */

  const screens = {
    'Setup.swift': 'ios/LabyrinthVault/Screens/Setup.swift',
    'Unlock.swift': 'ios/LabyrinthVault/Screens/Unlock.swift',
  };

  for (const [name, path] of Object.entries(screens)) {
    it(`${name} keeps the screen awake while the key is derived`, () => {
      const text = readFileSync(path, 'utf8');
      expect(text, `${name} does not touch the idle timer`).toMatch(/isIdleTimerDisabled/);
      expect(text, `${name} turns the idle timer off and never restores it`)
        .toMatch(/isIdleTimerDisabled = false/);
    });
  }

  it('leaves it alone everywhere else', () => {
    /* Scoped to the two screens that wait on a derivation. Anywhere else it
     * would be a phone that stops sleeping for no reason a reader could find. */
    const guilty: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.swift')) {
          const code = readFileSync(path, 'utf8')
            .split('\n')
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join('\n');
          if (/isIdleTimerDisabled/.test(code) && !Object.values(screens).includes(path)) {
            guilty.push(path);
          }
        }
      }
    };
    walk('ios/LabyrinthVault');
    expect(guilty, 'these files hold the screen awake and should not').toEqual([]);
  });

  it('says the wait is expected, on the screen where it is longest', () => {
    /* A clock that moves is the part a person actually believes, so the screen
     * has to have one. Checking for the reading rather than for reassuring
     * words: copy can be rewritten, but a screen with no elapsed time on it
     * has gone back to being indistinguishable from a hung one. */
    const setup = readFileSync('ios/LabyrinthVault/Screens/Setup.swift', 'utf8');
    expect(setup, 'the key generation screen shows no elapsed time').toMatch(/"ELAPSED"/);
    expect(setup, 'nothing tells the person this is not frozen').toMatch(/NOT FROZEN/i);
  });
});

describe('every screen the router can show has a way in', () => {
  /* The bug this exists for shipped. `SettingsView` was written, wired into
   * the router, given a `Route` case, given transition rules in Flow.swift and
   * a test in FlowContractTests, described in review notes as the path to key
   * management — and never once navigated to. Nothing said `go(.settings)`.
   *
   * That is not a dead screen, it is a dead *capability*: settings is the only
   * route to `RecoveryView`, so the recovery phrases, the switch that stops
   * using Face ID and ERASE VAULT were reachable exactly once, from a lever on
   * the setup completion screen. Tap OPEN VAULT instead and your seed words
   * are gone for good, on a device whose whole purpose is holding them.
   *
   * Nothing caught it, and nothing could have: every existing guard checks
   * that a thing is correctly *defined*. This one checks it is reached. It is
   * deliberately about the payload-free routes — the chrome — because those
   * are the ones a person navigates to. The signing path's routes carry a
   * summary or a reply, cannot be constructed without one, and are already
   * covered by Flow.
   */

  const vault = readFileSync('ios/LabyrinthVault/Model/Vault.swift', 'utf8');

  /** The chrome routes: `Route` cases with no associated value. */
  const chromeRoutes = (() => {
    const start = vault.indexOf('enum Route: Equatable {');
    expect(start, 'the Route enum moved').toBeGreaterThan(-1);
    const body = vault.slice(start, vault.indexOf('\n}', start));
    return [...body.matchAll(/^\s{4}case (\w+)$/gm)].map((m) => m[1]!);
  })();

  /**
   * Every route literal that is a *use* rather than a declaration or a switch
   * arm.
   *
   * Lines beginning with `case ` are dropped, which removes the enum
   * declarations and all three exhaustive switches over `Route` in one rule —
   * including the arm bodies, since `case .settings: SettingsView()` puts the
   * route and its screen on one line. What survives is navigation: a
   * `go(.export)` call, a `route = .unlock` assignment, and the tab bar and
   * settings tables, which hold their destinations as `(String, Route)` pairs
   * and so never spell `go(` at all. The first draft of this guard missed
   * those tables and reported the airgap screen as orphaned, which is the
   * opposite of the truth.
   */
  const reached = (() => {
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.swift')) {
          const code = readFileSync(path, 'utf8')
            .split('\n')
            .filter((line) => !/^\s*(case |\/\/|\*|\/\*)/.test(line))
            .join('\n');
          for (const match of code.matchAll(/\.(\w+)\b/g)) found.add(match[1]!);
        }
      }
    };
    walk('ios/LabyrinthVault');
    return found;
  })();

  it('found both lists, so a pass means something', () => {
    expect(chromeRoutes).toContain('settings');
    expect(chromeRoutes).toContain('recovery');
    expect(chromeRoutes.length).toBeGreaterThan(8);
    expect(reached.size).toBeGreaterThan(50);
  });

  it('navigates to every one of them', () => {
    const orphaned = chromeRoutes.filter((route) => !reached.has(route)).sort();
    expect(orphaned, 'these screens exist and nothing can reach them').toEqual([]);
  });

  it('keeps the recovery screen reachable after setup, not only during it', () => {
    /* The specific regression, named. Setup's completion screen offers the
     * phrases once; the tab bar is what makes them permanent. If the only
     * `go(.recovery)` left in the tree is the one inside Setup.swift, this
     * vault has become a box you can put a seed into and not get it out of. */
    const outsideSetup = readdirSync('ios/LabyrinthVault/Screens')
      .filter((name) => name.endsWith('.swift') && name !== 'Setup.swift')
      .map((name) => readFileSync(join('ios/LabyrinthVault/Screens', name), 'utf8'))
      .join('\n');
    expect(outsideSetup, 'only setup can reach the recovery phrases')
      .toMatch(/\.recovery/);
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
