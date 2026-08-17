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
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
/* The one import of the code under guard, rather than of its text. It earns
 * its exception: see "is reachable" below, where a text guard passed against
 * a wire that had genuinely stopped carrying the payload. */
import { encodeParts, parsePart } from '../src/airgap/envelope';
import { codeOnly, sourcesUnder } from './support/source';

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

  it('offers the PSBT wires beside its own', () => {
    /* This used to assert `case psbt = "SPARROW · ELECTRUM"` — it pinned the
     * false claim rather than catching it, which is worth leaving a note
     * about. A guard written from the code it is guarding inherits that code's
     * mistakes; the only thing that found this one was reading Electrum. The
     * replacement below is in "the wire picker names only wallets that can
     * read the wire", and it checks the claim against the format instead of
     * against the string that was there yesterday. */
    expect(signed).toMatch(/case psbt = "SPARROW · BLUEWALLET"/);
    expect(signed).toMatch(/case cake = "CAKE"/);
    expect(signed).toMatch(/result\.urFrames/);
    expect(signed).toMatch(/result\.urPsbtFrames/);
    expect(signed, 'the Labyrinth wire was dropped').toMatch(/result\.frames/);
  });

  it('emits both registry names for the same payload', () => {
    /* BC-UR renamed its types in 2023 and the wallets did not move together.
     * Sparrow subscribes to crypto-psbt; Cake tests startsWith("ur:psbt/")
     * and takes nothing else. Emitting one name is being incompatible with
     * half the ecosystem for the length of a string. */
    const host = readFileSync('src/bridge/host.ts', 'utf8');
    expect(host).toMatch(/UrEncoder\(UR_PSBT,/);
    expect(host).toMatch(/UrEncoder\(UR_PSBT_MODERN,/);
  });

  it('decodes the field the engine actually sends', () => {
    const replies = readFileSync('ios/LabyrinthVault/Support/EngineReplies.swift', 'utf8');
    expect(replies).toMatch(/let urFrames: \[String\]\?/);
    expect(readFileSync('src/bridge/host.ts', 'utf8')).toMatch(/urFrames: new UrEncoder\(UR_PSBT/);
  });

  it('labels the wires by wallet, never by format', () => {
    /* TXSIGNED and UR:CRYPTO-PSBT mean nothing to somebody holding two
     * phones. The names of the wallets do.
     *
     * Checked structurally rather than by matching a sentence: the first
     * version of this test asserted a phrase from the copy and broke the
     * moment the copy was improved, which is a guard that punishes the thing
     * it exists to encourage. */
    const labels = [...signed.matchAll(/case \w+ = "([^"]+)"/g)].map((m) => m[1]!);
    expect(labels.length, 'no wires found').toBeGreaterThanOrEqual(3);
    for (const label of labels) {
      expect(label, `"${label}" names a format, not a wallet`)
        .not.toMatch(/\bUR\b|PSBT|LV1|CBOR|TXSIGNED/i);
    }
    expect(labels).toContain('LABYRINTH');
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

  it('runs the migration off the main thread, like every other derivation', () => {
    /* Ordering was the only thing checked here, and ordering is not the only
     * thing that can be wrong.
     *
     * `reseal` is an unseal, a seal and a proof unseal: three Argon2id
     * derivations. This class is `@MainActor`, so a bare call runs all three on
     * the thread that draws, and it runs on the success path of the first
     * unlock after an upgrade. On a build where the native derivation fails to
     * adopt, which Settings.swift documents as silent, that is minutes of a
     * frozen app under copy that says it is not frozen. Every other derivation
     * site in this file already hops off; this one was the exception, and an
     * exception nothing checks is an exception that comes back. */
    const migrate = code.slice(code.indexOf('func migrateToLayeredScheme'));
    const detachedAt = migrate.indexOf('Task.detached');
    const resealAt = migrate.indexOf('engine.reseal');
    expect(detachedAt, 'the migration does not leave the main actor at all').toBeGreaterThan(-1);
    expect(resealAt).toBeGreaterThan(-1);
    expect(detachedAt, 'the re-seal runs before the hop off the main actor').toBeLessThan(resealAt);
  });

  it('re-seals inside the engine, so the secret never crosses the bridge', () => {
    const engine = readFileSync('ios/LabyrinthVault/Support/Engine.swift', 'utf8');
    expect(engine).toMatch(/func reseal\(sealedHex:/);
    const host = readFileSync('src/bridge/host.ts', 'utf8');
    expect(host).toMatch(/reseal: guarded\('reseal'/);
  });
});

describe('ERASE VAULT clears every keychain account this app writes', () => {
  /*
   * V-H1. `eraseVault()` called `SealedStore.erase()` and `lock()`, which
   * between them clear the sealed blob, the witness, the timing record and
   * the device half. `BiometricUnlock` keeps its own account,
   * `unlock-passphrase`, and nothing on the erase route touched it: the only
   * caller of `forget()` was the recovery screen's STOP USING lever and a
   * self-heal inside the unlock path, neither reachable after an erase.
   *
   * So a person who erased their vault, sold the phone, and had the buyer
   * restore from an iCloud keychain backup would be handing over the
   * passphrase to a vault they believe is gone. The blob is gone, which is
   * why this is a High and not a Critical, and a passphrase surviving an
   * ERASE is still a promise broken.
   *
   * Written against the accounts each file declares rather than a list typed
   * here, because a list typed here is a list that stops matching. Comments
   * are stripped first, or the guard fires on the paragraph above the
   * constant it is looking for.
   */
  const accountsIn = (source: string): string[] =>
    [...codeOnly(source).matchAll(/let (\w*[Aa]ccount\w*) = "([^"]+)"/g)].map((match) => match[2]!);

  const storeSource = readFileSync('ios/LabyrinthVault/Support/SealedStore.swift', 'utf8');
  const biometricSource = readFileSync('ios/LabyrinthVault/Support/BiometricUnlock.swift', 'utf8');
  const vaultSource = codeOnly(readFileSync('ios/LabyrinthVault/Model/Vault.swift', 'utf8'));

  it('finds the keychain accounts, so a pass means something', () => {
    /* The degenerate version of every check below is an empty list, which
     * passes silently. These are the five items this app writes; a new one
     * arriving here is somebody being asked whether the erase covers it. */
    expect(accountsIn(storeSource).sort()).toEqual([
      'device-passphrase.v1',
      'pass-seconds',
      'sealed-vault',
      'vault-witness',
    ]);
    expect(accountsIn(biometricSource)).toEqual(['unlock-passphrase']);
  });

  it('drops every account the sealed store owns', () => {
    const erase = codeOnly(storeSource).slice(codeOnly(storeSource).indexOf('static func erase()'));
    const names = [...codeOnly(storeSource).matchAll(/let (\w*[Aa]ccount\w*) = "([^"]+)"/g)];
    const missed = names.filter(([, name]) => !erase.includes(name!)).map(([, , value]) => value!);
    expect(missed, 'SealedStore.erase() leaves these in the keychain').toEqual([]);
  });

  it('drops the passphrase kept for biometric unlock', () => {
    const erase = vaultSource.slice(
      vaultSource.indexOf('func eraseVault()'),
      vaultSource.indexOf('func acknowledgeVanished'),
    );
    expect(erase, 'eraseVault() was not found').toBeTruthy();
    expect(erase).toMatch(/SealedStore\.erase\(\)/);
    expect(
      erase,
      'the passphrase kept for biometric unlock survives ERASE VAULT, and no screen reachable afterwards can remove it',
    ).toMatch(/forgetPassphrase\(\)|BiometricUnlock\.forget\(\)/);
  });
});

describe('a refusal screen states no fact it was never given', () => {
  /*
   * V-M1. `Refusal` is an enum with no associated values: it knows which
   * condition fired and nothing else. Its `findings` printed
   * "APPROVED SUMMARY DIGEST 9F2A1C04" against "PRESENTED BYTES DIGEST
   * 71D3E80B", and the first of those is the leading characters of the test
   * fixture at Vault.swift's `Fixtures.tx.digest` while the second matches
   * nothing anywhere in this repository. `.changeMismatch`, `.duplicateInput`
   * and the rest likewise numbered inputs and outputs the enum never saw.
   *
   * The screen renders these rows verbatim under a refusal, which is the
   * moment somebody is deciding whether their vault or their phone is lying
   * to them. Two hex strings that came from nowhere, one of them from a test,
   * is the worst possible place for invented detail.
   *
   * The pattern is deliberately blunt: any run of six or more hex-looking
   * uppercase characters, and any INPUT or OUTPUT followed by a number.
   * Nothing legitimate in these rows needs either, because nothing in this
   * type knows a digest or a position.
   */
  const refusal = codeOnly(readFileSync('ios/LabyrinthVault/Model/Refusal.swift', 'utf8'));
  const findings = refusal.slice(refusal.indexOf('var findings:'));

  it('finds the findings, so a pass means something', () => {
    expect(findings, 'the findings property moved or was renamed').toContain('NO SIGNATURE PRODUCED');
    expect(findings.length).toBeGreaterThan(500);
  });

  it('quotes no digest and numbers no input or output', () => {
    const rows = [...findings.matchAll(/\("([^"]*)"/g)].map((match) => match[1]!);
    expect(rows.length, 'the row matcher found nothing, so this asserts on an empty list').toBeGreaterThan(20);
    const invented = rows.filter((row) => /\b[0-9A-F]{6,}\b/.test(row) || /\b(INPUT|OUTPUT)\s+\d/.test(row));
    expect(
      invented,
      'Refusal never sees the transaction, so a digest or a position printed here was made up',
    ).toEqual([]);
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

describe('no Result carries a sentence as its failure', () => {
  /*
   * `Result<Success, Failure>` requires `Failure: Error`, and `String` does not
   * conform. `Result<Engine.KeyImageFileReply, String>` shipped in Vault.swift
   * and reads perfectly well:
   *
   *     error: Type 'String' does not conform to protocol 'Error'
   *
   * The suite could not see it. `Package.swift` builds the platform-free half
   * of the app for real, but Vault.swift is on its `exclude:` list precisely
   * because it imports SwiftUI, so everything in that file is parsed for syntax
   * and type-checked by nobody until Xcode opens. This is the cheap half of
   * that gap closed: one mistake, spelled one way, caught without a Mac.
   *
   * The fix is never to wrap the sentence in an error type. Both places that
   * hit this named their outcomes instead, `BiometricUnlock.Recalled` and
   * `Vault.FileOutcome`, because a sentence written for a person is not an
   * `Error`, and making it one to satisfy a generic is how the words end up
   * behind a `localizedDescription`.
   */
  it('never writes Result<_, String>', () => {
    const offenders: string[] = [];
    for (const { path, text } of appSources()) {
      text.split('\n').forEach((line, i) => {
        /* Comments are skipped: both files that hit this explain it in prose,
         * and a guard that fires on its own documentation teaches people to
         * delete the documentation. */
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/Result\s*<[^>]*,\s*String\s*>/.test(line)) offenders.push(`${path}:${i + 1}`);
      });
    }
    expect(
      offenders,
      'Result needs a Failure conforming to Error. Name the outcomes instead, as Vault.FileOutcome does.',
    ).toEqual([]);
  });
});

describe('no two files in the app target share a name', () => {
  /*
   * Swift refuses to build a target holding two files with the same basename,
   * whatever directories they sit in:
   *
   *     error: Filename "MoneroFile.swift" used twice:
   *       '.../Screens/MoneroFile.swift' and '.../Model/MoneroFile.swift'
   *     note: Filenames are used to distinguish private declarations with the
   *       same name
   *
   * `Model/MoneroFile.swift` and `Screens/MoneroFile.swift` shipped in the same
   * commit, and the commit passed everything. It had to: the whole suite runs
   * without a Mac, and this is a linker-adjacent rule no regex over the sources
   * was looking for. Worse, an `.xcodeproj` generated *before* those files
   * existed builds happily, so the person who discovers it is whoever next runs
   * `xcodegen generate` — and what they see first is seven cascading "cannot
   * find type" errors that read like a broken pull rather than a name clash.
   *
   * The repository already had the answer in `Model/Refusal.swift` beside
   * `Screens/RefusalScreen.swift`: the screen takes the suffix. This is that
   * convention with a test under it.
   */
  it('has no duplicate basenames anywhere under the app', () => {
    const seen = new Map<string, string[]>();
    for (const { path } of appSources()) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      seen.set(name, [...(seen.get(name) ?? []), path]);
    }
    const clashes = [...seen.entries()]
      .filter(([, paths]) => paths.length > 1)
      .map(([name, paths]) => `${name}: ${paths.join(' and ')}`);
    expect(
      clashes,
      'Swift will not build a target with two files of the same name. Suffix the screen, as RefusalScreen.swift does.',
    ).toEqual([]);
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
    readFileSync('ios/LabyrinthVault/Model/MoneroSummary.swift', 'utf8') +
    readFileSync('ios/LabyrinthVault/Model/MoneroFile.swift', 'utf8');

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
    'WireMoneroFileTx[]': '[MoneroFileTx]',
    'WireMoneroFilePayment[]': '[MoneroFilePayment]',
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
    ['WireMoneroFile', 'MoneroFile'],
    ['WireMoneroFileTx', 'MoneroFileTx'],
    ['WireMoneroFilePayment', 'MoneroFilePayment'],
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

  /** The `Route` enum's body, declarations only. */
  const routeEnum = (() => {
    const start = vault.indexOf('enum Route: Equatable {');
    expect(start, 'the Route enum moved').toBeGreaterThan(-1);
    return vault.slice(start, vault.indexOf('\n}', start));
  })();

  /** The chrome routes: `Route` cases with no associated value. */
  const chromeRoutes = [...routeEnum.matchAll(/^\s{4}case (\w+)$/gm)].map((m) => m[1]!);

  /** Every route name, payload-carrying ones included, so that the collector
   *  below can keep route literals and drop everything else it sweeps up. */
  const routeNames = new Set([...routeEnum.matchAll(/^\s{4}case (\w+)/gm)].map((m) => m[1]!));

  /**
   * Every route a person can actually arrive at, and only those.
   *
   * The first version of this collected every `.token` in every Swift file
   * after dropping lines that begin with `case `, on the theory that what
   * survived was navigation. It was not. `Flow.swift` states its transition
   * rules as comparisons — `return from == .scanner || from == .received` —
   * and those are not lines beginning with `case `, so the table of which
   * moves are *permitted* was being read as proof that the moves *happen*.
   * `Flow.swift` alone kept five chrome routes alive, and one route
   * (`received`) had no other mention anywhere. A guard whose whole purpose is
   * catching a screen with no way in could not fail for any route on the scan
   * path.
   *
   * So the collection is now by construction rather than by subtraction. Four
   * shapes, each of which is a person moving:
   *
   *   - the argument of a `go(...)` call, whatever its syntax. Taking the
   *     whole argument rather than a literal straight after the paren is what
   *     catches `go(vault.hasVault ? .airgap : .setup(.boundary))`, and the
   *     looseness costs nothing because only names the `Route` enum declares
   *     are kept.
   *   - `route = .unlock`, the two places that set it without going.
   *   - `route: .airgap`, the destination field of the settings table and the
   *     `var route: Route = .launch` the app opens on.
   *   - the tab bar's `(String, Route)` pairs, which never spell `go(` at all.
   *     The first draft missed those and reported the airgap screen as
   *     orphaned, which is the opposite of the truth.
   *
   * Comments are stripped rather than filtered by line, so the paragraph above
   * `go(.settings)` in App.swift explaining that nothing used to call it does
   * not count as calling it.
   */
  const reached = (() => {
    const found = new Set<string>();
    const add = (text: string, pattern: RegExp) => {
      for (const match of text.matchAll(pattern)) {
        if (routeNames.has(match[1]!)) found.add(match[1]!);
      }
    };

    /** The text between `go(` and its matching close paren. */
    const goArguments = (code: string): string[] => {
      const out: string[] = [];
      for (const call of code.matchAll(/\bgo\(/g)) {
        let depth = 1;
        let i = call.index + call[0].length;
        const from = i;
        while (i < code.length && depth > 0) {
          if (code[i] === '(') depth += 1;
          else if (code[i] === ')') depth -= 1;
          i += 1;
        }
        out.push(code.slice(from, i - 1));
      }
      return out;
    };

    for (const file of sourcesUnder('ios/LabyrinthVault', ['.swift'])) {
      for (const argument of goArguments(file.code)) add(argument, /\.(\w+)/g);
      add(file.code, /\broute\s*=\s*\.(\w+)/g);
      add(file.code, /\broute:\s*\.(\w+)/g);
      add(file.code, /:\s*Route\??\s*=\s*\.(\w+)/g);
      /* A literal assigned to something whose declared type names Route: the
       * destinations are `.home`, `.scanner` and friends inside it. */
      for (const table of file.code.matchAll(/:\s*\[[^\]]*\bRoute\b[^\]]*\]\s*=\s*\[([\s\S]*?)\n\s*\]/g)) {
        add(table[1]!, /\.(\w+)/g);
      }
    }
    return found;
  })();

  it('found both lists, so a pass means something', () => {
    expect(chromeRoutes).toContain('settings');
    expect(chromeRoutes).toContain('recovery');
    expect(chromeRoutes.length).toBeGreaterThan(8);
    /* Low, because the set is now navigation rather than every token in the
     * app. It is here to catch a renamed `go` or a moved directory, which
     * would otherwise empty the set and report every screen as orphaned. */
    expect(reached.size).toBeGreaterThan(8);
    expect(reached, 'the tab bar table is no longer being read').toContain('settings');
    expect(reached, 'the go() call sites are no longer being read').toContain('acquiring');
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

  it('exports nothing Swift never names', () => {
    /* The same contract read the other way, which is the direction that had
     * no guard at all.
     *
     * A Swift call to a function the engine dropped fails on a phone, and the
     * test above catches it. An engine function nothing on the far side names
     * fails more quietly: it ships, it is documented, and the documentation is
     * the only place it exists. `calibrateKdf` is the worked example. It is
     * reachable from `Engine.swift` and from nowhere above it, and three
     * documents describe the KDF as calibrated on the device, which no build
     * has ever done.
     *
     * The allowlist is for one thing and one thing only: an export whose Swift
     * caller is a commit away, named here so the promise is written down where
     * the next person will see it rather than left as an export nobody can
     * account for. It is not a place to park something that was decided
     * against; four of those were deleted rather than listed.
     *
     * It is empty again. `restore` was its one entry for exactly as long as
     * the Swift took to catch up, which is the shape an entry here should
     * have: if one is still sitting here in a month, the promise was not one. */
    const unwired = new Set<string>();
    const orphaned = [...hostFunctions].filter((name) => !swiftCalls.has(name) && !unwired.has(name)).sort();
    expect(orphaned, 'the engine exports these and no Swift call site names them').toEqual([]);
    expect([...unwired].filter((name) => swiftCalls.has(name)), 'this is wired now, take it off the list').toEqual([]);
  });

  it('passes each function its arguments in the order that function declares', () => {
    /* The fourth direction, and the one that survives both checks above.
     *
     * `call` takes `[Any]`, so Swift can hand four strings across in any order
     * it likes and both sides compile. `restore` is the worked example:
     * swapping its first two arguments is a one-character edit that produces
     * "Bitcoin phrase: those words fail their own checksum" against a phrase
     * that is perfectly correct, on a screen somebody has just typed
     * thirty-seven words into, with no way to tell which half is lying. Two
     * `String` parameters next to each other is all it takes, and `sign`,
     * `reseal` and `create` all have that shape too.
     *
     * Both sides name the same things the same way, so the check is simply
     * that the lists are equal. That is a convention rather than a law, and if
     * a future function has a good reason to break it, this test is where the
     * reason gets written down. */
    const swiftArguments = new Map<string, string[]>();
    for (const found of codeOnly(engine).matchAll(/call\w*\(\s*'?"(\w+)"\s*,\s*\[([^\]]*)\]/g)) {
      swiftArguments.set(
        found[1]!,
        found[2]!.split(',').map((piece) => piece.trim()).filter(Boolean),
      );
    }

    const hostParameters = new Map<string, string[]>();
    const body = host.slice(host.indexOf('export const api = {'));
    for (const found of body.matchAll(/^  (\w+): guarded\(\s*'\w+',\s*\n?\s*\(([^)]*)\)/gm)) {
      hostParameters.set(
        found[1]!,
        found[2]!.split(',').map((piece) => piece.trim().split(':')[0]!.trim()).filter(Boolean),
      );
    }

    /* Only the functions that take arguments can have them out of order, so
     * the floor is about those rather than about the whole api. */
    expect(swiftArguments.size, 'no argument lists found in Engine.swift').toBeGreaterThan(10);

    for (const [name, passed] of swiftArguments) {
      const declared = hostParameters.get(name);
      expect(declared, `host.ts declares no parameters for ${name}`).toBeDefined();
      expect(passed, `Engine.swift passes ${name} its arguments in a different order`).toEqual(declared);
    }
  });

  it('has a caller for every method it wraps', () => {
    /* The third direction, and the one the other two were quietly propping up.
     *
     * `Engine.swift` carried wrappers for `calibrate`, `checkAddress`,
     * `checkPhrase` and `checkExtendedKey`. Every one compiled, named a real
     * host function, and had never been called by a screen. They were what
     * kept the check above green: the engine exported four functions nothing
     * used, and four Swift methods nothing used were the proof that something
     * did. A guard satisfied by dead code on the far side is measuring the
     * wrong thing, so this asks the question the other two cannot.
     *
     * Private plumbing is excluded by the `private` keyword rather than by a
     * list, so a new helper does not have to be registered anywhere. Anything
     * a caller could reach has to have one. */
    const elsewhere = sourcesUnder('ios/LabyrinthVault', ['.swift'])
      .filter((file) => !file.path.endsWith('Support/Engine.swift'))
      .map((file) => file.code)
      .join('\n');
    expect(elsewhere.length, 'no Swift outside Engine.swift, so this guard is checking nothing').toBeGreaterThan(
      5000,
    );

    const methods = [...codeOnly(engine).matchAll(/^ {4}(?:static )?func (\w+)/gm)].map((m) => m[1]!);
    expect(methods.length, 'Engine.swift declares no methods, so this guard is checking nothing').toBeGreaterThan(
      12,
    );

    const uncalled = methods.filter((name) => !new RegExp(`\\.${name}\\b`).test(elsewhere)).sort();
    expect(uncalled, 'Engine.swift wraps these and no screen or model calls them').toEqual([]);
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

describe('the vendored CryptoNight is wired the way it is documented', () => {
  /* Everything here is a text guard over Package.swift, and each one exists
   * because the failure it catches is invisible on this machine.
   *
   * `swift build` runs on x86 Linux in CI. `slow-hash.c` contains three
   * complete implementations of `cn_slow_hash` selected by the preprocessor,
   * and all three pass the official vectors — so dropping `NO_AES` would leave
   * CI perfectly green while changing which code derives a wallet key on the
   * phone, and dropping `FORCE_USE_HEAP` would leave CI green while putting a
   * 2 MiB array on a 512 KiB iOS thread stack. Neither is a thing a test on
   * this machine can observe by running anything.
   */
  const manifest = readFileSync('Package.swift', 'utf8');
  const target = (name: string) => {
    /* Anchored on the `.target(` that opens the declaration, not on the name
     * alone. The first version of this cut at `name: "LabyrinthVaultKDF"` and
     * found the *product* of that name up in `products:`, so the slice it
     * returned held none of the settings it was asserting about — and said so
     * by failing, which is the only reason this comment exists rather than a
     * guard that passed on the wrong text. */
    const open = new RegExp(String.raw`\.target\(\s*\n\s*name: "${name}",`);
    const at = manifest.search(open);
    expect(at, `Package.swift has no target named ${name}`).toBeGreaterThan(-1);
    /* To the start of the next target, or the end. This is a cut and not a
     * parse — enough to keep one target's settings from being read as
     * another's, which is the only ambiguity that matters here. */
    const rest = manifest.slice(at + 1);
    const next = rest.search(/\n\s*\.(test)?[Tt]arget\(/);
    return next === -1 ? rest : rest.slice(0, next);
  };

  const cryptonight = target('CCryptoNight');

  it('sets the two defines that choose which implementation computes a key', () => {
    /* Cross-checked against the manifest rather than hardcoded twice. If the
     * two ever disagree, one of them is describing a build that does not
     * happen, and MANIFEST.json is the one a reviewer reads. */
    const pinned: { buildDefines: Record<string, string> } = JSON.parse(
      readFileSync('vendor/cryptonight/MANIFEST.json', 'utf8'),
    );
    for (const define of Object.keys(pinned.buildDefines)) {
      expect(cryptonight, `Package.swift does not define ${define}, which MANIFEST.json says it does`)
        .toContain(`.define("${define}")`);
    }
    expect(Object.keys(pinned.buildDefines).length).toBe(2);
  });

  it('points at the vendored tree and not at somebody’s checkout', () => {
    expect(cryptonight).toContain('path: "vendor/cryptonight"');
    expect(cryptonight).toContain('.headerSearchPath("src/crypto")');
    expect(cryptonight).toContain('.headerSearchPath("contrib/epee/include")');
    expect(cryptonight).toContain('.headerSearchPath("shim")');
  });

  it('reaches the app through the one product Xcode names', () => {
    /* ios/project.yml names LabyrinthVaultKDF and nothing else, so the C only
     * gets into an archive if the Swift target depends on it. A CryptoNight.swift
     * that compiles on Linux and is absent from the app is exactly the shape of
     * the missing-import bug that already cost one archive. */
    const kdf = target('LabyrinthVaultKDF');
    expect(kdf).toContain('"CCryptoNight"');
    expect(kdf).toContain('"CryptoNight.swift"');
    expect(kdf).toContain('"Argon2id.swift"');

    const project = readFileSync('ios/project.yml', 'utf8');
    expect(project).toMatch(/product:\s*LabyrinthVaultKDF/);
  });

  it('keeps the variant bound in C, where Swift cannot pass another one', () => {
    /* `cn_slow_hash` takes a variant, and four of the five are proof-of-work
     * history that never appears in a wallet file. The C entry point takes no
     * variant argument at all, so the binding cannot be undone by a caller —
     * only by editing this file, which is what the assertion is for. */
    const header = readFileSync('vendor/cryptonight/include/labyrinth_cryptonight.h', 'utf8');
    expect(header).toMatch(/void labyrinth_cn_slow_hash_v0\(const uint8_t \*data, size_t length, uint8_t out\[32\]\)/);

    const shim = readFileSync('vendor/cryptonight/shim/labyrinth_cn.c', 'utf8');
    expect(shim).toMatch(/cn_slow_hash\(data, length, \(char \*\)out, 0 \/\*variant\*\/, 0 \/\*prehashed\*\/, 0 \/\*height\*\/\)/);

    /* Comments stripped first. That file's header quotes the upstream call it
     * is standing in front of, which is exactly the sentence a reader needs
     * and exactly the sentence a naive grep mistakes for the call itself. */
    const swift = readFileSync('ios/LabyrinthVaultKDF/CryptoNight.swift', 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(swift, 'Swift calls cn_slow_hash directly, going around the bound variant')
      .not.toMatch(/\bcn_slow_hash\b/);
  });

  it('no Apple-only file calls CryptoNight without importing the module', () => {
    /* The same pairing Argon2id needs, for the same reason: everything under
     * ios/LabyrinthVault is parsed and never type checked off a Mac. */
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
          if (/\bCryptoNight\s*\./.test(code) && !/^import LabyrinthVaultKDF$/m.test(text)) {
            guilty.push(path);
          }
        }
      }
    };
    walk('ios/LabyrinthVault');
    expect(guilty, 'these call CryptoNight without importing LabyrinthVaultKDF').toEqual([]);
  });
});

describe('the wire picker names only wallets that can read the wire', () => {
  /* This is the guard for a defect that shipped: the signed screen offered one
   * BC-UR button labelled "SPARROW · ELECTRUM", and Electrum reads no BC-UR at
   * all — no `crypto-psbt`, no fountain decoder, nothing in the source. So the
   * app named a wallet on a button that could never have worked with it, and
   * nothing here noticed, because every test asked whether the frames were
   * well-formed and none asked who could read them.
   *
   * The rule these encode: a wallet's name may appear on a wire only if this
   * repository emits the format that wallet actually reads. Adding a name is
   * therefore adding a format, which is the point.
   */
  const signed = readFileSync('ios/LabyrinthVault/Screens/Signed.swift', 'utf8');
  const exportScreen = readFileSync('ios/LabyrinthVault/Screens/Export.swift', 'utf8');
  const host = readFileSync('src/bridge/host.ts', 'utf8');

  /* Only the wire labels: the string literals a person reads off a button.
   * Prose about a wallet is fine and is most of why these files are readable;
   * a label is a promise. */
  const labels = (source: string) =>
    [...source.matchAll(/case\s+\w+\s*=\s*"([^"]+)"/g)].map((m) => m[1]!);

  it('does not put Electrum on a BC-UR button, because Electrum has no BC-UR', () => {
    for (const [name, source] of [['Signed', signed], ['Export', exportScreen]] as const) {
      const urLabels = labels(source).filter((l) => /SPARROW|BLUEWALLET|CAKE/.test(l));
      for (const label of urLabels) {
        expect(label, `${name}.swift offers Electrum a UR wire`).not.toMatch(/ELECTRUM/);
      }
    }
  });

  it('gives Electrum its own wire, carrying base43', () => {
    /* Named separately and wired to the base43 frames. If somebody deletes the
     * case, this fails rather than quietly going back to a vault Electrum
     * cannot receive from. */
    expect(labels(signed)).toContain('ELECTRUM');
    expect(signed).toMatch(/case\s+\.electrum:\s*return result\.electrumFrames/);
    expect(host).toContain('electrumFrames: base43Frame(');
  });

  it('gives Coldcard a wire, carrying BBQr', () => {
    expect(labels(signed).some((l) => /COLDCARD/.test(l)), 'no Coldcard wire').toBe(true);
    expect(signed).toMatch(/case\s+\.bbqr:\s*return result\.bbqrFrames/);
    expect(host).toContain('bbqrFrames: bbqrEncode(');
  });

  it('decodes every wire it offers back out of the engine reply', () => {
    /* A case in the picker with no field behind it renders an empty QR and no
     * explanation. The Swift side is parsed and never type-checked off a Mac,
     * so the two halves can only be held together here. */
    const replies = readFileSync('ios/LabyrinthVault/Support/EngineReplies.swift', 'utf8');
    for (const field of ['urFrames', 'urPsbtFrames', 'electrumFrames', 'bbqrFrames']) {
      expect(replies, `Sign reply has no ${field}`).toMatch(
        new RegExp(String.raw`let ${field}: \[String\]\?`),
      );
      expect(host, `host.ts never emits ${field}`).toContain(`${field}:`);
    }
  });

  it('no longer tells anyone to switch to a wire that does not exist', () => {
    /* The empty-frames message named "SPARROW · ELECTRUM" as the wire to
     * switch to. Renaming the case left the instruction pointing at nothing,
     * which is the kind of thing only a reader notices. */
    const quoted = [...signed.matchAll(/"([^"]{20,})"/g)].map((m) => m[1]!);
    const names = new Set(labels(signed));
    for (const line of quoted) {
      const claim = /SWITCH TO ([A-Z0-9 ·]+?) FOR/.exec(line)?.[1];
      if (!claim) continue;
      expect(names.has(claim) || claim === 'ANY PSBT WIRE',
        `the screen says "switch to ${claim}" and there is no such wire`).toBe(true);
    }
  });
});

describe('the descriptor pairing wire, and the multisig this vault does not do', () => {
  const host = readFileSync('src/bridge/host.ts', 'utf8');
  const exportScreen = readFileSync('ios/LabyrinthVault/Screens/Export.swift', 'utf8');
  const replies = readFileSync('ios/LabyrinthVault/Support/EngineReplies.swift', 'utf8');

  it('emits descriptors from the export, and decodes them on the far side', () => {
    /* A zpub says which keys and nothing else: not the script type, not the
     * path, not the seed. A descriptor says all three, and it is the only
     * pairing form that needs no scanner and no registry support, which is
     * what makes it the answer for Electrum. */
    expect(host).toContain('bip84Descriptors(');
    /* Shorthand property, so there is no `descriptors:` to match. Asserting
     * the reply carries it rather than the syntax it carries it with. */
    expect(host).toMatch(/done\(\{[^}]*\bdescriptors\b[^}]*\}\)/);
    expect(replies).toMatch(/let descriptors: Descriptors\?/);
    expect(exportScreen).toContain('exported.descriptors?.combined');
  });

  it('offers the descriptor as its own wire rather than burying it', () => {
    const labels = [...exportScreen.matchAll(/case\s+\w+\s*=\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(labels).toContain('DESCRIPTOR');
    expect(exportScreen).toMatch(/case \.descriptor: return descriptorFrames/);
  });

  /* The standing boundary. This vault signs single-signature BIP84 and nothing
   * else, and multisig is not a missing feature so much as a different
   * security model: change has to be verified against a script rather than
   * against a key, and a confirmation screen that cannot do that is worse than
   * no multisig at all.
   *
   * So the rule is that no screen, no wire label and no descriptor may imply
   * otherwise, anywhere either app can reach.
   *
   * Two things this guard got wrong before, both of which made it report
   * coverage it did not have:
   *
   * `descriptor.ts` and `monerotx.ts` were exempt by path. The reason was that
   * `descriptor.ts` names `wsh(sortedmulti(2,...))` in the paragraph arguing
   * why this vault does not emit one, which is the comment-stripping problem
   * solved the wrong way: the exemption bought silence for the prose and threw
   * in the whole file. A real 2-of-2 written into that file passed the entire
   * suite. Comments are stripped now and the file is walked like every other,
   * so the paragraph stays sayable and the code does not. `monerotx.ts` never
   * needed an exemption at all: it says "multisig" in order to refuse a
   * container, and "multisig" matches none of these patterns.
   *
   * And the walk covered `src/` and the vault only. That was true when the
   * companion was watch-only and stopped being true when a PSBT build-and-sign
   * path landed in `wallet/src/`, which put the half most likely to grow a
   * script type outside the only mechanism enforcing the rule.
   */
  const MULTISIG = /\bsortedmulti(_a)?\(|\bmulti(_a)?\(|\bwsh\(|\bsh\(/;

  const scanned = [
    ...sourcesUnder('src', ['.ts', '.js']),
    ...sourcesUnder('ios/LabyrinthVault', ['.swift']),
    ...sourcesUnder('wallet/src', ['.ts', '.tsx']),
    
  ];

  it('walks all three halves, so a pass is not an empty walk', () => {
    /* A guard whose directory was renamed reads exactly like a guard that
     * found nothing wrong. These floors are the difference. */
    for (const dir of ['src/', 'ios/LabyrinthVault/', 'wallet/src/']) {
      expect(scanned.filter((f) => f.path.startsWith(dir)).length, `nothing scanned under ${dir}`).toBeGreaterThan(5);
    }
    expect(scanned.some((f) => f.path === 'src/keys/descriptor.ts'), 'the descriptor builder is not walked').toBe(true);
  });

  it('never offers multisig anywhere a person could read it as working', () => {
    const guilty: string[] = [];
    for (const file of scanned) {
      file.code.split('\n').forEach((line, index) => {
        if (MULTISIG.test(line)) guilty.push(`${file.path}:${index + 1}: ${line.trim().slice(0, 80)}`);
      });
    }
    expect(guilty, 'these could emit or claim a multisig script').toEqual([]);
  });

  it('describes only wpkh, in the one file that builds a descriptor', () => {
    const descriptor = readFileSync('src/keys/descriptor.ts', 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(descriptor).toContain("`wpkh([${origin}/${accountPath}]${xpub}`");
    expect(descriptor).not.toMatch(/sortedmulti|\bmulti\(/);
  });
});

describe('the read-only Monero screen describes and does not sign', () => {
  /* The screen this guards replaced a blanket refusal, and the risk it carries
   * is the mirror image of the one the refusal carried.
   *
   * The refusal's fault was saying no to a question the vault could answer:
   * `Monero unsigned tx set` opens now, and telling somebody their perfectly
   * good file is unsupported sends them off to re-export something that was
   * never wrong.
   *
   * The new screen's fault would be worse. It renders amounts, a fee, a ring
   * size and a destination, in the same house style as the confirmation
   * screens, and every one of those figures is the *sending* wallet's account
   * of its own transaction. Nothing in the file is evidence for anything else
   * in it. So what is checked here is that the screen cannot be mistaken for
   * an approval: no lever that signs, no hold, no green, and a route that
   * touches neither end of the signing path.
   */

  const host = readFileSync('src/bridge/host.ts', 'utf8');
  const engine = readFileSync('ios/LabyrinthVault/Support/Engine.swift', 'utf8');
  const vault = readFileSync('ios/LabyrinthVault/Model/Vault.swift', 'utf8');
  const app = readFileSync('ios/LabyrinthVault/App.swift', 'utf8');
  const screen = readFileSync('ios/LabyrinthVault/Screens/MoneroFileScreen.swift', 'utf8');
  const model = readFileSync('ios/LabyrinthVault/Model/MoneroFile.swift', 'utf8');
  const envelope = readFileSync('src/airgap/envelope.ts', 'utf8');

  /** The screen without its prose, for guards about what the code does. */
  const code = screen
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  it('found the files, so a pass means something', () => {
    expect(screen.length).toBeGreaterThan(2000);
    expect(code.length).toBeGreaterThan(1000);
  });

  it('is reachable: a wire kind, a dispatch, a route and a view', () => {
    /* The four links, each of which is a string in one language matched by a
     * string in another. This is the chain that was missing when the reader
     * existed and nothing could reach it.
     *
     * The first link is asserted by running the wire rather than by reading
     * it, and that is not fastidiousness: the text guard that stood here
     * passed against a deliberately broken envelope. `PayloadKind` and the
     * `KINDS` array are two lists in one file and only the array decides what
     * `parsePart` accepts, so deleting the array entry left `'XMRFILE'` in the
     * union for a regex to find while every scanned frame of one became "not
     * a Labyrinth code" and the screen went back to being unreachable. */
    const frame = encodeParts('XMRFILE', new Uint8Array([1, 2, 3]))[0]!;
    expect(parsePart(frame)?.kind, 'the wire does not carry a wallet2 file').toBe('XMRFILE');
    expect(envelope, 'the kind is undocumented').toMatch(/XMRFILE/);
    expect(vault, 'nothing dispatches on the XMRFILE kind').toMatch(/reply\.kind == "XMRFILE"/);
    expect(vault, 'the dispatch does not call the engine').toMatch(/engine\.moneroFile\(payloadHex:/);
    expect(vault, 'there is no route to carry the description').toMatch(/case xmrFile\(MoneroFile\)/);
    expect(app, 'the router cannot show the screen').toMatch(/case \.xmrFile\(let \w+\): MoneroFileView/);
    expect(engine, 'Engine.swift has no method for it').toMatch(/func moneroFile\(payloadHex:/);
    expect(host, 'the engine does not export it').toMatch(/^ {2}moneroFile: guarded\('moneroFile'/m);
  });

  it('renders every field the engine sends, so nothing arrives and vanishes', () => {
    /* `Decodable` is happy to decode a field nobody reads, and a screen that
     * quietly drops one shows a shorter truth than the engine told it. Every
     * stored property of the three types has to appear somewhere in the view.
     *
     * `position` is the exception and it is used rather than shown: it is the
     * `Identifiable` key these lists are keyed by, which is a use the naive
     * version of this guard could not see and reported as a dropped field. */
    const properties = [...model.matchAll(/^ {4}let (\w+):/gm)].map((m) => m[1]!);
    expect(properties.length).toBeGreaterThan(12);
    const unshown = [...new Set(properties)]
      .filter((name) => name !== 'position')
      .filter((name) => !new RegExp(`\\.${name}\\b`).test(code))
      .sort();
    expect(unshown, 'these fields cross the bridge and reach no pixel').toEqual([]);
  });

  it('offers no way to sign what it is showing', () => {
    /* The central property. A confirmation screen ends in a lever; this one
     * ends in a way back to the vault, and the difference has to be structural
     * rather than a matter of which words are on the button. */
    expect(code).not.toMatch(/HoldToSign|completeSigning|completeMoneroSigning/);
    expect(code).not.toMatch(/\.xmrApprove|\.approve\b|\.xmrReview|\.review\b/);
    expect(code).not.toMatch(/moneroSign|reviewedDigest|\bdigest\b/);
    // The one control, and where it goes.
    const levers = [...code.matchAll(/Lever\(title: "([^"]+)"/g)].map((m) => m[1]!);
    expect(levers, 'the read-only screen grew a second control').toEqual(['DONE']);
    expect(code).toMatch(/vault\.go\(\.home\)/);
  });

  it('never paints an unverified figure in the color that means verified', () => {
    /* `Ink.verified` is the app's one green, and on the confirmation screens
     * it means "the vault re-derived this and it matched". Nothing here has
     * been re-derived. A green row on this screen would be a lie told in a
     * color, which is harder to notice than a lie told in a sentence. */
    expect(code, 'the read-only screen uses the verified color')
      .not.toMatch(/Ink\.verified|tone: \.verified/);
  });

  it('says whose figures these are, before it shows any of them', () => {
    /* Order matters more than presence. The caveat is the frame the numbers
     * are read through, and a person who reads the amounts first has already
     * formed an impression that a footnote has to undo. */
    const caveat = screen.indexOf("THESE ARE THE SENDER'S OWN FIGURES");
    const firstAmount = screen.indexOf('payingFormatted');
    expect(caveat, 'the screen does not say whose figures these are').toBeGreaterThan(-1);
    expect(caveat, 'the caveat comes after the numbers it qualifies').toBeLessThan(firstAmount);
    expect(screen).toMatch(/has not checked any of them/);
    expect(screen).toMatch(/THE VAULT WILL NOT SIGN THIS/);
  });

  it('tells somebody where to go instead, so the screen is not a dead end', () => {
    /* A refusal that explains itself and stops is still a person holding a
     * phone with nothing to do next. There is a route that works, and naming
     * it is the difference between honest and merely correct. */
    expect(screen).toMatch(/Labyrinth wallet/);
  });

  it('pins the engine contract, because the screen needs a function to exist', () => {
    /* An app that can route here against a bundle with no `moneroFile` would
     * get "undefined is not a function" at the end of a scan. The version
     * check turns that into a sentence at launch. */
    const hostVersion = /export const HOST_VERSION = (\d+)/.exec(host)?.[1];
    expect(Number(hostVersion)).toBeGreaterThanOrEqual(6);
  });
});

describe('Package.swift accounts for every Swift file in the app', () => {
  /* The failure this catches is silent and it happened while the file above
   * was being written. `MoneroFile.swift` was added under `Model/`, which is
   * inside the `LabyrinthVaultCore` target's path, and the target names its
   * sources one by one — so the new file was neither compiled nor excluded.
   * SwiftPM said "found 1 file(s) which are unhandled" among the build noise
   * and carried on; Xcode globs the directory and compiled it regardless.
   *
   * The result is a file that builds on a Mac and is invisible to
   * `swift build` on Linux, which is the whole tier-1 check. A type error in
   * it would surface for the first time in an archive.
   *
   * So: every Swift file under the target's path is either a listed source or
   * a listed exclusion, and adding one is a deliberate claim about which.
   */

  const manifest = readFileSync('Package.swift', 'utf8');

  const listed = (field: string) => {
    const at = manifest.indexOf(`${field}: [`);
    expect(at, `Package.swift has no ${field} list`).toBeGreaterThan(-1);
    return [...manifest.slice(at, manifest.indexOf(']', at)).matchAll(/"([^"]+)"/g)]
      .map((m) => m[1]!);
  };

  const sources = listed('sources');
  const excluded = listed('exclude');

  /** Every Swift file under the target's path, relative to it. */
  const present = (() => {
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path, relative);
        else if (entry.name.endsWith('.swift')) out.push(relative);
      }
    };
    walk('ios/LabyrinthVault', '');
    return out;
  })();

  it('found both lists, so a pass means something', () => {
    expect(sources.length).toBeGreaterThan(5);
    expect(excluded.length).toBeGreaterThan(3);
    expect(present.length).toBeGreaterThan(20);
    expect(sources).toContain('Model/Flow.swift');
  });

  it('has a decision recorded for every one of them', () => {
    /* An exclusion may name a directory, which covers everything under it.
     * That is how `Screens` and `Design` are handled and it is right: those
     * are wholesale Apple-only, and listing forty files would be noise that
     * nobody reads and therefore nobody maintains. */
    const covered = (file: string) =>
      sources.includes(file) || excluded.some((e) => file === e || file.startsWith(`${e}/`));
    const unhandled = present.filter((file) => !covered(file)).sort();
    expect(unhandled, 'these are neither compiled nor excluded, so only Xcode sees them')
      .toEqual([]);
  });

  it('lists no source that is not there', () => {
    const missing = sources.filter((file) => !present.includes(file)).sort();
    expect(missing, 'Package.swift names sources that do not exist').toEqual([]);
  });
});

describe('the key image answer has two wires and offers the second honestly', () => {
  /* The defect this closes was the third of its kind in this repository, and
   * the largest: `exportKeyImageBlob` writes the file Cake, Feather and
   * `monero-wallet-cli` import, it has been checked against bytes Monero's own
   * crypto produced since the CryptoNight work, and nothing could ask for one.
   * Thirty-four files of vendored C were in the archive for a capability no
   * screen offered. `src/keys/monerotx.ts` said "this vault *writes* this one",
   * which was true of the code and false of the product.
   *
   * So these guards are about reachability first and honesty second.
   */

  const host = readFileSync('src/bridge/host.ts', 'utf8');
  const engine = readFileSync('ios/LabyrinthVault/Support/Engine.swift', 'utf8');
  const vault = readFileSync('ios/LabyrinthVault/Model/Vault.swift', 'utf8');
  const screen = readFileSync('ios/LabyrinthVault/Screens/KeyImages.swift', 'utf8');
  const replies = readFileSync('ios/LabyrinthVault/Support/EngineReplies.swift', 'utf8');

  const code = screen
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  it('found the files, so a pass means something', () => {
    expect(screen.length).toBeGreaterThan(2000);
    expect(code.length).toBeGreaterThan(1000);
  });

  it('is reachable: a host function, a call, a model method and a control', () => {
    expect(host, 'the engine does not export it')
      .toMatch(/^ {2}moneroKeyImageFile: guarded\('moneroKeyImageFile'/m);
    expect(engine, 'Engine.swift has no method for it')
      .toMatch(/func moneroKeyImageFile\(randomHex:/);
    expect(vault, 'nothing in the model calls it').toMatch(/engine\.moneroKeyImageFile\(randomHex:/);
    expect(code, 'no control on the screen asks for it').toMatch(/writeFile\(\)/);
    expect(code, 'the picker offers no second wire').toMatch(/case moneroFile = "MONERO FILE"/);
  });

  it('offers the second wire only when the engine says it can be written', () => {
    /* The reason `version` reports `cryptonight` and the reason the reply
     * carries `fileRandomBytes` at all. A build without the vendored C signs
     * and answers on this project's own wire exactly as before; the one thing
     * it cannot do is write this file. A button whose only possible answer is
     * "this build cannot do that" is chrome pretending to be a feature. */
    expect(host).toMatch(/fileRandomBytes: nativeCnSlowHashInstalled\(\)/);
    expect(replies, 'the reply cannot express "cannot be written"')
      .toMatch(/let fileRandomBytes: Int\?/);
    expect(code, 'the picker is drawn unconditionally')
      .toMatch(/if fileOffered \{ picker \}/);
    expect(code).toMatch(/result\.fileRandomBytes != nil/);
  });

  it('never re-derives how much randomness the file costs', () => {
    /* The same rule the Monero signing path follows: the engine owns the
     * formula, the platform CSPRNG owns the bytes, and Swift asks for exactly
     * the number it was given. A second copy of `(n + 1) * 32 + 8` in Swift
     * is a second chance to be wrong about a length that decides whether a
     * file can be written at all. */
    const swiftTree = readdirSync('ios/LabyrinthVault', { withFileTypes: true });
    expect(swiftTree.length).toBeGreaterThan(0);
    expect(vault).toMatch(/answer\.fileRandomBytes \?\? 0/);
    expect(vault, 'the model computes a byte count of its own')
      .not.toMatch(/\* 32 \+ 8|\+ 1\) \* 32/);
    expect(code, 'the screen computes a byte count of its own')
      .not.toMatch(/\* 32 \+ 8|\+ 1\) \* 32/);
  });

  it('says the file is matched by position, because that is what breaks it', () => {
    /* `import_key_images` pairs each record with `m_transfers[i + offset]`. A
     * screen that showed the codes without saying so would be handing somebody
     * a file whose correctness depends on an ordering they were never told
     * about. The engine refuses to write one at all when an output was
     * refused, for the same reason. */
    expect(screen).toMatch(/by position/);
    expect(screen).toMatch(/TRANSFER OFFSET/);
    expect(host).toMatch(/pairs records\s*\n?\s*\*? ?with transfers \*by position\*/);
    /* And the module that actually refuses says the same thing, because the
     * screen's sentence and the engine's rule have to be the same rule. */
    expect(readFileSync('src/keys/keyimages.ts', 'utf8')).toMatch(/matches \*\*by position\*\*/);
  });

  it('names the wallets that read each wire, and only wallets that do', () => {
    /* The same rule the Bitcoin wire picker follows, and the defect it was
     * written for: a button named after a wallet that cannot read what is on
     * it. Cake, Feather and monero-wallet-cli all import
     * `Monero key image export`; none of them reads this project's own wire. */
    expect(screen).toMatch(/Cake, Feather and monero-wallet-cli import this one/);
    expect(screen).toMatch(/The Labyrinth wallet reads this one/);
  });

  it('carries the file on the wire that carries Monero files', () => {
    expect(host).toMatch(/encodeParts\('XMRFILE' satisfies PayloadKind, result\.file\)/);
  });

  it('forgets the request when the vault locks', () => {
    /* A locked vault answers nothing, and that has to include the request it
     * was halfway through answering. */
    expect(host).toMatch(/lastKeyImageRequest = null;/);
    expect(vault).toMatch(/pendingKeyImageRandomBytes = 0/);
  });
});

describe('SECURITY.md cites defenses that exist', () => {
  /*
   * "The claims above are tests, not prose: delete a defense and the suite
   * goes red." That sentence had nothing behind it, and the row it was least
   * true of proved the point: "Tuning weakening the vault" cited
   * `calibrateKdf`, a function that walks memory upward, cannot weaken
   * anything, and has never been called by any build. `seal` takes no
   * parameters across the bridge, so there is no path from a measurement to a
   * sealed blob. The mitigation was real code, correctly described, and
   * entirely inert.
   *
   * This is the cheap half of what that sentence promises: every file the
   * table points at exists, and every symbol it names is somewhere a reader
   * could find it. It cannot tell a live defense from a dead one, and saying
   * so here is better than implying it can. What it does catch is the rot
   * that produced the citation above: a rename, a deletion, a file that moved
   * and took the argument with it.
   */
  const security = readFileSync('SECURITY.md', 'utf8');
  const table = security.slice(
    security.indexOf('| Threat | Defense | Where |'),
    security.indexOf('## What is explicitly out of scope'),
  );
  /* Every backticked thing in the third column, which is the column that
   * points at code. The first two are prose and are allowed to mention
   * anything. */
  const cited = [
    ...new Set(
      table
        .split('\n')
        .filter((line) => line.startsWith('|') && !line.startsWith('|---') && !line.includes('| Threat |'))
        .flatMap((line) => line.split('|').slice(3, 4))
        .flatMap((cell) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!)),
    ),
  ].sort();

  const haystack = [
    ...sourcesUnder('src', ['.ts']),
    ...sourcesUnder('test', ['.ts']),
    ...sourcesUnder('ios', ['.swift']),
  ]
    .map((entry) => entry.text)
    .join('\n');

  it('finds the table, so a pass is not an empty walk', () => {
    expect(table.length, 'the threat table moved or its heading changed').toBeGreaterThan(1000);
    expect(cited.length, 'the third column matcher found nothing').toBeGreaterThan(12);
  });

  /* Four kinds of citation, and the classification is the interesting part:
   * a bucket nothing lands in is a bucket that checks nothing, so each has
   * its own count assertion. The table mixes full paths, bare filenames
   * (`envelope.ts`, `ur.ts`), package names and plain identifiers, and an
   * earlier version of this block quietly checked only two of the four. */
  const packages = cited.filter((name) => name.startsWith('@'));
  const rest = cited.filter((name) => !name.startsWith('@'));
  const paths = rest.filter((name) => name.includes('/'));
  const filenames = rest.filter((name) => !name.includes('/') && /\.\w+$/.test(name));
  const symbols = rest.filter((name) => !name.includes('/') && !/\.\w+$/.test(name));

  it('sorts every citation into exactly one kind', () => {
    expect(paths.length + filenames.length + packages.length + symbols.length).toBe(cited.length);
    expect(paths.length, 'no full paths cited').toBeGreaterThanOrEqual(5);
    expect(filenames.length, 'no bare filenames cited').toBeGreaterThanOrEqual(2);
    expect(packages.length, 'no packages cited').toBeGreaterThanOrEqual(1);
    expect(symbols.length, 'no bare symbols cited').toBeGreaterThanOrEqual(2);
  });

  it('names no file that is not there', () => {
    const missing = paths.filter((name) => !existsSync(name));
    expect(missing, 'SECURITY.md points at files that do not exist').toEqual([]);
  });

  it('names no bare filename that is nowhere in the tree', () => {
    const known = new Set(
      [
        ...sourcesUnder('src', ['.ts']),
        ...sourcesUnder('test', ['.ts']),
        ...sourcesUnder('ios', ['.swift']),
      ].map((entry) => entry.path.slice(entry.path.lastIndexOf('/') + 1)),
    );
    const missing = filenames.filter((name) => !known.has(name));
    expect(missing, 'SECURITY.md points at files that have been renamed or removed').toEqual([]);
  });

  it('names no package this project does not depend on', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    const missing = packages.filter((name) => declared[name] === undefined);
    expect(missing, 'SECURITY.md credits a package that is not a dependency').toEqual([]);
  });

  it('names no symbol that appears nowhere in the source', () => {
    const missing = symbols.filter((name) => !new RegExp(`\\b${name}\\b`).test(haystack));
    expect(missing, 'SECURITY.md credits a defense with no code behind the name').toEqual([]);
  });

  it('does not cite the calibration that never ran', () => {
    /* Named rather than left to the general check, because `calibrateKdf` is
     * still in `seal.ts` with its own tests: every check above passes on it.
     * It is unreachable rather than absent, which is the case a symbol search
     * is blind to, and it is the case this whole block was written for. */
    expect(
      table,
      'the tuning row is back, and no build has ever calibrated anything',
    ).not.toMatch(/calibrate/i);
  });
});

describe('every state the engine can report about its own KDF reaches a screen', () => {
  /*
   * V-L8's second half. `seal.ts` was changed to measure which Argon2id a
   * build actually runs rather than whether one was installed, because a host
   * whose `deriveKey` returns nil on every call is installed and runs the
   * JavaScript. That gave three answers where there had been two, and the new
   * one is the one worth having: `mismatch` means something compiled is doing
   * the work, `deriveKey` is using it because the length is right, and it is
   * not Argon2id. A vault sealed on that build opens on that build and
   * nowhere else.
   *
   * Swift collapsed all three into `kdfIsNative: Bool`, so `mismatch`
   * rendered as INTERPRETED, which is the label for the slow-but-correct
   * build. That is not a smaller version of the problem, it is a different
   * problem described in place of it.
   *
   * A cross-language contract with nothing but this connecting the two ends,
   * which is the same shape as the refusal-codes guard above. Nothing here
   * compiles Swift.
   */
  const seal = readFileSync('src/keys/seal.ts', 'utf8');
  const replies = codeOnly(readFileSync('ios/LabyrinthVault/Support/EngineReplies.swift', 'utf8'));
  const settings = codeOnly(readFileSync('ios/LabyrinthVault/Screens/Settings.swift', 'utf8'));

  /** The states the engine can put in a version reply, from the engine. */
  const states = (/export type KdfSource = ([^;]+);/.exec(seal)?.[1] ?? '')
    .split('|')
    .map((part) => part.trim().replace(/'/g, ''))
    .filter(Boolean)
    .sort();

  it('finds the engine-side states, so a pass means something', () => {
    expect(states, 'KdfSource moved or changed shape in seal.ts').toEqual([
      'engine',
      'mismatch',
      'native',
    ]);
  });

  it('decodes every one of them on the Swift side', () => {
    /* The words themselves, because the reply carries strings. `mismatch` is
     * deliberately absent from the Swift switch: anything unrecognized falls
     * to it, which is what makes a future fourth state safe rather than
     * silently read as working. */
    expect(replies, 'no KdfSource type in Swift; the boolean is back').toMatch(/enum KdfSource/);
    for (const state of ['engine', 'native']) {
      expect(replies, `Swift does not decode "${state}"`).toContain(`"${state}"`);
    }
    for (const state of states) {
      expect(replies, `Swift has no case for ${state}`).toMatch(new RegExp(`case ${state}\\b`));
    }
  });

  it('gives each state its own words on the settings screen', () => {
    /* Three distinct labels. Two states sharing one is exactly the defect:
     * the label a person reads has to distinguish "slow" from "do not trust a
     * vault sealed here". */
    const labels = [...replies.matchAll(/case \.\w+: return "([^"]+)"/g)].map((match) => match[1]!);
    expect(labels.length, 'the label mapping was not found').toBe(states.length);
    expect(new Set(labels).size, 'two states share a label, which is the collapse again').toBe(
      states.length,
    );
    expect(settings, 'the screen does not read the three-state value').toMatch(
      /vault\.kdfSource/,
    );
    expect(settings, 'the boolean is back on the screen').not.toMatch(/kdfIsNative/);
  });

  it('does not render a wrong algorithm in the tone that means merely slow', () => {
    expect(settings).toMatch(/kdfSource == \.mismatch \? \.refused/);
  });
});
