/**
 * What the key derivation actually costs, on this machine, right now.
 *
 * This exists because seal.ts used to assert that the default parameters
 * "land near a second on the old hardware this app is for", and nobody had
 * measured it. They do not. On a modern server CPU with a JIT, one derivation
 * at the default 64 MiB / t=3 takes over a second — and the phone this app is
 * for has neither a modern CPU nor, inside an app's own JavaScriptCore
 * context, a JIT at all. The entitlement that enables one is Apple's; a
 * third-party app gets the interpreter.
 *
 * So the number this prints is a *floor*, not an estimate. The device will be
 * worse and the only way to find out how much worse is to run the same
 * derivation on the device. docs/native-primitives.md is about what to do with
 * the answer.
 *
 * Deliberately not a test. A wall-clock assertion in the suite is a test that
 * fails on a busy CI runner and teaches everyone to ignore it.
 *
 *   npm run bench:kdf
 */

import { argon2id } from '@noble/hashes/argon2.js';
import { build } from 'esbuild';

/* The real constants, not a copy of them.
 *
 * A benchmark that hard-codes "64 MiB, t=3" measures what somebody once
 * believed the defaults were. seal.ts is TypeScript with extensionless
 * imports, which Node will not resolve on its own, so it goes through the
 * bundler that is already a dependency and comes back as a module. */
const compiled = await build({
  entryPoints: ['src/keys/seal.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
});
const { DEFAULT_KDF, KDF_LIMITS } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(compiled.outputFiles[0].text).toString('base64')
);

const password = new TextEncoder().encode('a passphrase of ordinary length');
const salt = new Uint8Array(16).fill(7);

/* ## The interpreter run, and why V8 stands in for JavaScriptCore
 *
 * `node --jitless` turns off every tier of V8's compiler and leaves the
 * bytecode interpreter. That is not JavaScriptCore's LLInt, and this script
 * has no way to run JSC, so the ratio it prints is an *analogy* rather than a
 * measurement of the shipping engine. It is worth having anyway: the previous
 * version of this file said the phone would be slower "by a factor nobody
 * here can guess honestly", which invited the reader to imagine a small one.
 * It is not small, and one command now shows that rather than asserting it.
 *
 * The device number is still the only one that decides anything. See the gate
 * in docs/native-primitives.md.
 */
const jitless = process.execArgv.includes('--jitless');

/** Best of three with a warm JIT, one cold run without: interpreted, a warmup
 *  buys nothing and the ceiling row would take half an hour. */
function timeOne({ t, m, p }) {
  if (jitless) {
    const started = performance.now();
    argon2id(password, salt, { t, m, p, dkLen: 32 });
    return performance.now() - started;
  }
  argon2id(password, salt, { t, m, p, dkLen: 32 }); // warm up
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    argon2id(password, salt, { t, m, p, dkLen: 32 });
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

const rows = [
  ['floor this build accepts', { t: KDF_LIMITS.minT, m: KDF_LIMITS.minM, p: 1 }],
  ['default (RFC 9106 #2)', DEFAULT_KDF],
  ['default, doubled memory', { ...DEFAULT_KDF, m: DEFAULT_KDF.m * 2 }],
  ['ceiling this build accepts', { t: DEFAULT_KDF.t, m: KDF_LIMITS.maxM, p: 1 }],
]./* The ceiling costs 12 s with a JIT. Interpreted that is over eight minutes
   * for a row nothing should ever seal at. */
  filter(([, params]) => !(jitless && params.m === KDF_LIMITS.maxM));

console.log(
  jitless
    ? 'Argon2id, one derivation, interpreted (node --jitless)\n'
    : 'Argon2id, one derivation, best of three\n',
);
console.log('  parameters                        cost');
console.log('  ' + '-'.repeat(46));
for (const [label, params] of rows) {
  const ms = timeOne(params);
  const shape = `t=${params.t} m=${(params.m / 1024).toFixed(0)}MiB p=${params.p}`;
  console.log(`  ${label.padEnd(28)} ${shape.padEnd(20)} ${ms.toFixed(0).padStart(6)} ms`);
}

console.log(
  jitless
    ? `
Interpreted, on this machine. Compare against the same script without the
flag: the gap between the two is what an engine with no JIT costs, and
JavaScriptCore inside a third-party iOS app is such an engine.

Read the floor row first. It is the weakest thing this build will accept, and
if it is already slow here it is worse on a phone, which means no parameter
choice inside KDF_LIMITS is both usable and memory-hard. See the gate in
docs/native-primitives.md.`
    : `
This is a floor, and a generous one. JavaScriptCore inside a third-party iOS
app has no JIT, so the phone pays an interpreter penalty on top of being
slower hardware. To see the shape of that penalty:

    node --jitless scripts/bench-kdf.mjs

What it is not is a security problem. calibrateKdf starts at the default and
only ever walks upward, so a slow device gets a slow unlock, never a weaker
vault. See docs/native-primitives.md.`,
);
