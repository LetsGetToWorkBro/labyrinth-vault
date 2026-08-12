/**
 * The bundle, run in the runtime it actually runs in.
 *
 * ## What this exists to catch
 *
 * Every other test here runs the engine under Node, where `TextEncoder`,
 * `console`, `setTimeout` and a dozen other conveniences are simply present.
 * The vault runs it in JavaScriptCore embedded in an iOS app, which is a bare
 * ECMAScript engine: the language, and nothing else. No DOM, no Web APIs, no
 * timers, no console.
 *
 * That gap shipped. `src/platform.d.ts` documented `TextEncoder` as safe and
 * listed the runtimes it had checked, and JavaScriptCore-in-an-app was not
 * among them. Ten modules called it, 600-odd tests passed, and the first build
 * that ever reached a device stopped on its own launch gate:
 *
 *     ReferenceError: Can't find variable: TextEncoder
 *
 * Nothing on Linux could have found that, because the thing missing on the
 * phone was present in the room. So this file removes it: the bundle is
 * evaluated in a context where every host global has been deleted, and then
 * asked to do real work.
 *
 * ## Why the whole self-test rather than a smoke check
 *
 * A reach for a missing global is a `ReferenceError` at the moment of the
 * reach, not at load, so a bundle can evaluate cleanly and fail on the first
 * transaction. `selfTest` walks the derivations against published vectors,
 * which touches the encoder, the hashes and the curve, and it is the same
 * thing the launch gate runs. If it passes here it has passed in a runtime
 * shaped like the phone's.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const BUNDLE = 'ios/LabyrinthVault/Resources/vault.bundle.js';

/**
 * Everything JavaScriptCore does not give an embedded script. Deleting them
 * one by one, rather than trusting `vm`'s empty context, because Node puts
 * several of these on a fresh context itself.
 */
const ABSENT_IN_JSC = [
  'TextEncoder',
  'TextDecoder',
  'console',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'queueMicrotask',
  'setImmediate',
  'process',
  'Buffer',
  'require',
  'module',
  'exports',
  'fetch',
  'crypto',
  'atob',
  'btoa',
  'structuredClone',
  'URL',
  'URLSearchParams',
  'performance',
  'global',
];

/** A context shaped like the engine's, with the conveniences taken away. */
function bareContext(): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {};
  const context = runInNewContext(
    `(function () {
       const gone = ${JSON.stringify(ABSENT_IN_JSC)};
       for (const name of gone) { try { delete globalThis[name]; } catch (e) {} }
       return globalThis;
     })()`,
    sandbox,
  ) as Record<string, unknown>;
  return context;
}

describe('the engine runs where there is only the language', () => {
  const built = existsSync(BUNDLE);

  it('found the bundle to run', () => {
    /* `npm test` builds it before this file runs. A missing bundle must fail
     * rather than skip: a guard that quietly checks nothing reads as coverage. */
    expect(built, `${BUNDLE} is missing; run npm run build:bundle`).toBe(true);
  });

  it('has none of the host globals it is about to be denied', () => {
    /* Proves the sandbox is doing what it claims before anything is concluded
     * from a pass inside it. */
    const context = bareContext();
    for (const name of ABSENT_IN_JSC) {
      expect((context as Record<string, unknown>)[name], `${name} survived`).toBeUndefined();
    }
  });

  /* 90 seconds because this is the real self-test: Argon2id is calibrated to
   * cost time on purpose, and it takes about twelve here. The default five
   * would fail on the work rather than on a fault. */
  it('evaluates, and passes its own self-test, with nothing but the language', { timeout: 90_000 }, () => {
    const source = readFileSync(BUNDLE, 'utf8');
    const sandbox: Record<string, unknown> = {};
    const result = runInNewContext(
      `
      const gone = ${JSON.stringify(ABSENT_IN_JSC)};
      for (const name of gone) { try { delete globalThis[name]; } catch (e) {} }
      ${source}
      JSON.stringify(JSON.parse(globalThis.LabyrinthVault.selfTest()));
      `,
      sandbox,
      { timeout: 60_000 },
    ) as string;

    const reply = JSON.parse(result) as {
      passed: boolean;
      checks: { name: string; ok: boolean; detail: string }[];
    };
    const failed = reply.checks.filter((check) => !check.ok);
    expect(
      failed.map((check) => `${check.name}: ${check.detail}`),
      'the engine failed its own vectors in a bare runtime',
    ).toEqual([]);
    expect(reply.passed).toBe(true);
    /* And it really ran something: an empty check list would pass the filter
     * above while proving nothing at all. */
    expect(reply.checks.length).toBeGreaterThan(3);
  });

  it('carries its own UTF-8 rather than hoping for the runtime to have it', () => {
    /* The polyfill is installed unconditionally, so one implementation runs
     * everywhere. Installing it only when absent would put the native codec
     * under test and this one on the phone, which is the shape of the bug it
     * is fixing. */
    const banner = readFileSync(BUNDLE, 'utf8').slice(0, 12_000);
    expect(banner, 'the bundle does not carry an encoder').toMatch(
      /globalThis\.TextEncoder = function TextEncoder/,
    );
    /* Comments stripped first. The prose above the polyfill explains why it is
     * unconditional by quoting the conditional form, and a guard that reads
     * its own documentation as a violation is the sixth in this repository to
     * make that mistake. */
    const code = banner.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(
      code,
      'the encoder is installed conditionally, so tests and device would run different code',
    ).not.toMatch(/typeof TextEncoder === ['"]undefined['"]/);
  });
});
