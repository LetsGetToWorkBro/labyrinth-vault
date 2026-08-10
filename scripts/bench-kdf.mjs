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

/** Best of three: we want the cost with a warm JIT, which is the kind number. */
function timeOne({ t, m, p }) {
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
];

console.log('Argon2id, one derivation, best of three\n');
console.log('  parameters                        cost');
console.log('  ' + '-'.repeat(46));
for (const [label, params] of rows) {
  const ms = timeOne(params);
  const shape = `t=${params.t} m=${(params.m / 1024).toFixed(0)}MiB p=${params.p}`;
  console.log(`  ${label.padEnd(28)} ${shape.padEnd(20)} ${ms.toFixed(0).padStart(6)} ms`);
}

console.log(`
This is a floor. JavaScriptCore inside an iOS app has no JIT, so the phone
will be slower than whatever is printed above, by a factor nobody here can
guess honestly — measure it on the device.

What it is not is a security problem. calibrateKdf starts at the default and
only ever walks upward, so a slow device gets a slow unlock, never a weaker
vault. See docs/native-primitives.md.`);
