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
    expect(call(api, 'version')).toEqual({ ok: true, version: 1 });
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
  let sealed = '';
  let zpub = '';

  it('makes a vault and hands back only ciphertext', () => {
    const made = call(api, 'create', random, 'a passphrase', '');
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
    expect(call(api, 'unlock', sealed, 'wrong').ok).toBe(false);
    const opened = call(api, 'unlock', sealed, 'a passphrase');
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
    const reopened = call(api, 'unlock', sealed, 'a passphrase');
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
