/**
 * The bundle the phone actually runs.
 *
 * Every other test in this suite imports TypeScript modules. The device does
 * not: it loads one compiled JavaScript file into JavaScriptCore and calls
 * into it across a bridge where everything is a string. That is a different
 * artefact with different failure modes — a tree-shake that drops something, a
 * target that compiles away BigInt, an export the app expects and the bundle
 * does not have — and none of them are visible from the module tests.
 *
 * So this file evaluates the built file the way the app does, in a bare
 * context with no Node globals, and drives the whole flow through it: make a
 * vault, open it, export the watch-only key, scan a transaction, read it,
 * sign it. If this passes, the parts are connected.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as btc from '@scure/btc-signer';
import { addressAt, openWatch } from '../src/keys/bitcoin';
import { passphraseToBytes } from '../src/keys/seal';
import { codeOnly } from './support/source';

const BUNDLE = 'ios/LabyrinthVault/Resources/vault.bundle.js';

/** The API, loaded the way JavaScriptCore loads it: evaluate, read the global. */
function loadBundle(): Record<string, (...args: never[]) => string> {
  const source = readFileSync(BUNDLE, 'utf8');
  /* A bare object as the global. Nothing from Node is in scope, which is the
   * point: if the bundle needs `process` or `Buffer` it fails here rather than
   * on a phone that has neither. */
  const globalObject: Record<string, unknown> = {};
  new Function('globalThis', source).call(globalObject, globalObject);
  const api = globalObject['LabyrinthVault'];
  expect(api, 'the bundle did not publish LabyrinthVault').toBeDefined();
  return api as Record<string, (...args: never[]) => string>;
}

const call = (api: ReturnType<typeof loadBundle>, name: string, ...args: unknown[]) =>
  JSON.parse((api[name] as (...a: unknown[]) => string)(...args));

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

describe('the built bundle', () => {
  let api: ReturnType<typeof loadBundle>;
  beforeAll(() => {
    api = loadBundle();
  });

  it('is the bundle this source produces, not a stale one', () => {
    /* The committed artefact and the source it came from must agree, or the
     * device runs code nobody reviewed. `npm test` rebuilds first, so this
     * compares the rebuild against its recorded digest. */
    const built = createHash('sha256').update(readFileSync(BUNDLE)).digest('hex');
    const recorded = readFileSync(`${BUNDLE}.sha256`, 'utf8').trim();
    expect(built).toBe(recorded);
  });

  it('tells Swift the same digest it wrote next to the bundle', () => {
    /* The app hashes the bundle at launch and compares it against a constant
     * compiled into the binary. That is only worth something if the constant
     * is generated from the same build — a hand-edited digest is a launch
     * check that passes for whatever it is pointed at. */
    const recorded = readFileSync(`${BUNDLE}.sha256`, 'utf8').trim();
    const swift = readFileSync('ios/LabyrinthVault/Support/BundleDigest.swift', 'utf8');
    const declared = /static let sha256 = "([0-9a-f]{64})"/.exec(swift)?.[1];
    expect(declared, 'BundleDigest.swift declares no digest').toBe(recorded);
    expect(swift, 'the generated file should say it is generated').toMatch(/Do not edit/);
  });

  it('checks that digest before it runs a line of the bundle', () => {
    /* Order is the whole point. Hashing after evaluating would prove the file
     * was intact right after it had already had its way with the process.
     *
     * Comments stripped first, and not as a formality: the first version of
     * this test failed because the doc comment above the check says the word
     * "evaluateScript" while explaining that the check comes before it. That
     * is the fourth time a source guard in this repository has matched the
     * prose describing the rule instead of the rule. */
    const engine = codeOnly(readFileSync('ios/LabyrinthVault/Support/Engine.swift', 'utf8'));
    const compare = engine.indexOf('BundleDigest.sha256');
    const evaluate = engine.indexOf('evaluateScript');
    expect(compare, 'Engine.swift never mentions the digest').toBeGreaterThan(-1);
    expect(evaluate).toBeGreaterThan(-1);
    expect(compare, 'the digest is checked after the bundle has already run').toBeLessThan(evaluate);
    // And it must be a refusal, not a log line.
    expect(engine).toMatch(/guard measured == BundleDigest\.sha256 else \{[\s\S]*?throw/);
  });

  it('ships Swift fixtures that were generated from this source', () => {
    /* The Swift tests decode JSON that the TypeScript produced, which is a far
     * better contract than two regexes comparing field lists — but only while
     * the JSON is current. A fixture generated in March describes March's
     * shape and passes happily against April's. So it is regenerated and
     * compared, the same way the bundle is. */
    const paths = [
      'ios/LabyrinthVaultTests/Fixtures/summary.json',
      'ios/LabyrinthVaultTests/Fixtures/primitives.json',
    ];
    const before = paths.map((path) => readFileSync(path));
    execFileSync('node', ['scripts/emit-swift-fixtures.mjs'], { stdio: 'pipe' });
    paths.forEach((path, i) => {
      expect(readFileSync(path).equals(before[i]!), `${path} is stale`).toBe(true);
    });
  });

  it('gives Swift the same cross-language vectors, byte for byte', () => {
    /* Two copies exist because SwiftPM will not copy a symlinked resource, and
     * a resource that silently fails to arrive turns the contract test into a
     * test that passes by not running. Two copies that can differ would be
     * worse than one, hence this. */
    const canonical = readFileSync('test/fixtures/primitives.json');
    const forSwift = readFileSync('ios/LabyrinthVaultTests/Fixtures/primitives.json');
    expect(forSwift.equals(canonical), 'the Swift copy has drifted').toBe(true);
  });

  it('builds byte-for-byte the same way twice', () => {
    const before = readFileSync(BUNDLE);
    execFileSync('node', ['scripts/build-bundle.mjs'], { stdio: 'pipe' });
    expect(readFileSync(BUNDLE).equals(before), 'the build is not reproducible').toBe(true);
  });

  it('carries no network code into the bundle either', () => {
    /* The source guard walks `src/`. It cannot see what a dependency dragged
     * in, and the bundle is what actually runs, so it is scanned on its own. */
    const source = readFileSync(BUNDLE, 'utf8');
    for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /\bnew\s+EventSource\b/]) {
      expect(source, `bundle contains ${pattern}`).not.toMatch(pattern);
    }
  });

  it('needs nothing from Node to run', () => {
    // It loaded in a bare context in beforeAll; this asserts the consequence.
    expect(call(api, 'version')).toEqual({ ok: true, version: 2 });
  });

  it('passes its own self-test inside the bundle', () => {
    const result = call(api, 'selfTest');
    expect(result.passed, JSON.stringify(result.checks?.filter((c: { ok: boolean }) => !c.ok))).toBe(true);
    expect(result.checks.length).toBeGreaterThan(10);
  });
});

describe('the whole flow, through the bundle', () => {
  const api = loadBundle();
  /** Fixed randomness so the vault is the same one every run. */
  const random = hex(Uint8Array.from({ length: 88 }, (_, i) => (i * 7 + 11) & 0xff));
  /* The passphrase crosses as bytes, which is what Swift sends: a plain array
   * of numbers, never a string. `passphraseToBytes` is the only thing allowed
   * to turn text into these. */
  const passphrase = [...passphraseToBytes('a passphrase')];
  let sealed = '';
  let zpub = '';

  it('makes a vault and hands back only ciphertext', () => {
    const made = call(api, 'create', random, passphrase, '');
    expect(made.ok).toBe(true);
    sealed = made.sealed;
    expect(sealed).toMatch(/^[0-9a-f]+$/);
    // Nothing secret comes back out of create.
    expect(Object.keys(made).sort()).toEqual(['ok', 'sealed']);
  });

  it('refuses everything while locked', () => {
    expect(call(api, 'unlocked').unlocked).toBe(false);
    expect(call(api, 'describe', '70736274ff').ok).toBe(false);
    expect(call(api, 'exportAccount', 'btc').ok).toBe(false);
    expect(call(api, 'revealBackup').ok).toBe(false);
  });

  it('opens with the passphrase and not without it', () => {
    expect(call(api, 'unlock', sealed, [...passphraseToBytes('wrong')]).ok).toBe(false);
    const opened = call(api, 'unlock', sealed, passphrase);
    expect(opened.ok).toBe(true);
    zpub = opened.btcAccount.zpub;
    expect(zpub.startsWith('zpub')).toBe(true);
    expect(opened.xmrAddress).toHaveLength(95);
    expect(call(api, 'unlocked').unlocked).toBe(true);
  });

  it('exports a watch-only account as frames a camera can read', () => {
    const exported = call(api, 'exportAccount', 'btc');
    expect(exported.account.zpub).toBe(zpub);
    expect(Array.isArray(exported.frames)).toBe(true);
    expect(exported.frames[0]).toMatch(/^LV1:ACCOUNT:/);
    // The export carries nothing that can spend.
    expect(JSON.stringify(exported)).not.toContain('zprv');
  });

  it('shows both recovery phrases, and only when asked', () => {
    const backup = call(api, 'revealBackup');
    expect(backup.bitcoin).toHaveLength(12);
    expect(backup.monero).toHaveLength(25);
    // Two ecosystems, two phrases: each restores in its own official wallet.
    expect(backup.bitcoin.join(' ')).not.toBe(backup.monero.join(' '));
  });

  it('reads a transaction it can actually sign, and signs it', () => {
    const wallet = openWatch(zpub).wallet!;
    const tx = new btc.Transaction({ allowUnknownOutputs: true });
    tx.addInput({
      txid: new Uint8Array(32).fill(5),
      index: 0,
      witnessUtxo: { script: addressAt(wallet, 0, 0).script, amount: 200_000n },
    });
    tx.addOutputAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 150_000n);
    tx.addOutput({ script: addressAt(wallet, 1, 0).script, amount: 45_000n });
    const psbt = hex(tx.toPSBT());

    const read = call(api, 'describe', psbt);
    expect(read.ok).toBe(true);
    const summary = read.summary;
    expect(summary.outputs).toHaveLength(2);
    expect(summary.outputs[0].mine).toBe(false);
    expect(summary.outputs[1].mine, 'change is re-derived, not believed').toBe(true);
    expect(summary.leaving).toBe('0.0015');
    expect(summary.yourNet).toBe('0.00155');
    expect(summary.fee).toBe('0.00005');
    expect(summary.signable).toBe(true);
    expect(summary.refusal).toBeNull();

    const signed = call(api, 'sign', psbt, summary.digest);
    expect(signed.ok, signed.problem).toBe(true);
    expect(signed.signed).toBe(1);
    expect(signed.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.frames[0]).toMatch(/^LV1:TXSIGNED:/);
  });

  it('will not sign against a digest it did not produce', () => {
    const wallet = openWatch(zpub).wallet!;
    const tx = new btc.Transaction({ allowUnknownOutputs: true });
    tx.addInput({
      txid: new Uint8Array(32).fill(6),
      index: 0,
      witnessUtxo: { script: addressAt(wallet, 0, 0).script, amount: 100_000n },
    });
    tx.addOutputAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 90_000n);
    const psbt = hex(tx.toPSBT());
    call(api, 'describe', psbt);
    const wrong = call(api, 'sign', psbt, 'f'.repeat(64));
    expect(wrong.ok).toBe(false);
    expect(wrong.problem).toMatch(/does not match|nothing was signed/i);
  });

  it('will not take a passphrase as text, through the bundle', () => {
    /* The rule that makes the whole byte-passphrase change worth anything: if
     * a string is quietly accepted and encoded, the unwipeable path is the
     * convenient path and the rule stops being true within a release or two.
     * Driven through the built bundle because that is the artefact the phone
     * runs, and because the guard has to survive esbuild. */
    for (const badly of ['a passphrase', '', 61, null, [], [1, 2, 999], [1, 2, -1], [1, 'x'], [1.5]]) {
      const created = call(api, 'create', random, badly, '');
      expect(created.ok, `create accepted ${JSON.stringify(badly)}`).toBe(false);
      const opened = call(api, 'unlock', sealed, badly);
      expect(opened.ok, `unlock accepted ${JSON.stringify(badly)}`).toBe(false);
    }
    // And it says what the contract is, rather than "the vault did not open".
    expect(call(api, 'unlock', sealed, 'a passphrase').problem).toMatch(/bytes, not as text/);
  });

  it('names a Monero wallet file instead of calling it junk', () => {
    /* The whole point of recognising these: somebody holding a perfectly good
     * unsigned_monero_tx should be told what the vault cannot do with it, not
     * told their file is not a transaction. Driven through the bundle because
     * the refusal has to survive the bridge with its code attached, which is
     * what the Swift side switches on. */
    const file = 'Monero unsigned tx set' + 'encrypted bytes would follow';
    const asHex = hex(Uint8Array.from(file, (c) => c.charCodeAt(0) & 0xff));

    for (const answer of [call(api, 'describe', asHex), call(api, 'scan', file)]) {
      expect(answer.ok).toBe(false);
      expect(answer.code).toBe('monero-file-unsupported');
      expect(answer.problem).toContain('Monero unsigned transaction set');
      expect(answer.problem).toMatch(/CryptoNight/);
    }

    // And the Bitcoin path is not affected by any of it.
    const bitcoin = call(api, 'describe', '70736274ff');
    expect(bitcoin.ok, bitcoin.problem).toBe(true);
    expect(bitcoin.code).toBeUndefined();
  });

  it('assembles a scanned animation frame by frame', () => {
    call(api, 'scanReset');
    const wallet = openWatch(zpub).wallet!;
    const tx = new btc.Transaction({ allowUnknownOutputs: true });
    tx.addInput({
      txid: new Uint8Array(32).fill(7),
      index: 0,
      witnessUtxo: { script: addressAt(wallet, 0, 0).script, amount: 500_000n },
    });
    tx.addOutputAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 400_000n);
    const psbt = tx.toPSBT();

    // Frames as the vault itself would produce them, fed back in.
    const frames = call(api, 'exportAccount', 'btc').frames as string[];
    expect(frames.length).toBeGreaterThan(0);
    let last = call(api, 'scan', 'not a code at all');
    expect(last.payload).toBeNull();
    for (const frame of frames) last = call(api, 'scan', frame);
    expect(last.payload).toMatch(/^[0-9a-f]+$/);
    expect(last.kind).toBe('ACCOUNT');
    expect(psbt.length).toBeGreaterThan(0);
  });

  it('locks, and locking means the keys are gone', () => {
    expect(call(api, 'lock').locked).toBe(true);
    expect(call(api, 'unlocked').unlocked).toBe(false);
    expect(call(api, 'describe', '70736274ff').ok).toBe(false);
    expect(call(api, 'revealBackup').ok).toBe(false);
  });

  it('opens again to the same wallet, because the seal is the wallet', () => {
    const reopened = call(api, 'unlock', sealed, passphrase);
    expect(reopened.btcAccount.zpub).toBe(zpub);
  });
});

describe('nothing crosses the bridge as an exception', () => {
  const api = loadBundle();

  it('answers every entry point with JSON, however bad the input', { timeout: 30_000 }, () => {
    const junk = ['', 'zzzz', '\\u0000', 'ur:nonsense', '{}', 'ffff'.repeat(200)];
    /* `calibrate` is excluded because it is *supposed* to be slow: it walks
     * the key-stretching cost upward doing real Argon2 work at each step, so
     * even a junk argument means many seconds of honest computation. It gets
     * its own test below, with a small target. */
    for (const name of Object.keys(api).filter((n) => n !== 'calibrate')) {
      for (const bad of junk) {
        let raw: string;
        expect(() => {
          raw = (api[name] as (...a: unknown[]) => string)(bad, bad, bad);
        }, `${name} threw on ${JSON.stringify(bad.slice(0, 12))}`).not.toThrow();
        const parsed = JSON.parse(raw!);
        expect(typeof parsed.ok, `${name} did not answer with ok`).toBe('boolean');
        if (!parsed.ok) expect(typeof parsed.problem).toBe('string');
      }
    }
  });

  it('calibrates to parameters this build will actually run', { timeout: 60_000 }, () => {
    const result = call(api, 'calibrate', 250);
    expect(result.ok).toBe(true);
    // Never weaker than the default, whatever the device reports.
    expect(result.params.m).toBeGreaterThanOrEqual(65536);
    expect(result.params.p).toBe(1);
  });
});
