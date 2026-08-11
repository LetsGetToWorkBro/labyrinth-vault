/**
 * The stand-in vault, and the gate that keeps it off a stranger's phone.
 *
 * `demo/standin.ts` signs with the seed phrase published in BIP84. That is
 * exactly right on a desk with no second device, and exactly wrong in a build
 * somebody installs from TestFlight, where a signature made from a seed the
 * whole world holds could reach a real session.
 *
 * The gate is `__DEV__`. Metro replaces it with `false` in a release bundle
 * and strips the branch, so the signing code is not in the build. That is the
 * nice half. The half that carries the guarantee is tested here: the function
 * checks the flag itself, so even where the constant survives minification,
 * nothing can call it into producing a signature.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEMO, PUBLISHED_TEST_WORDS, standInVault } from '../src/demo/standin';
import type { Draft } from '../src/core/model';

/** Enough of a draft to be signable, if anything were willing to sign it. */
const draft = {
  asset: 'BTC',
  psbt: new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]),
} as unknown as Draft;

describe('the gate', () => {
  it('is off wherever __DEV__ is not a React Native bundle', () => {
    /* Vitest is such a context. The point is the direction of the default: an
     * unreadable flag disables the signer rather than enabling it. */
    expect(typeof (globalThis as { __DEV__?: boolean }).__DEV__).toBe('undefined');
    expect(DEMO).toBe(false);
  });

  it('refuses to sign when it is off, rather than throwing', () => {
    /* Null is what a vault that refused looks like to the caller, so the
     * screen already knows what to do with it. A throw here would surface as
     * a crash on the one screen where calm matters most. */
    expect(standInVault(draft, PUBLISHED_TEST_WORDS, 'sign')).toBeNull();
    expect(standInVault(draft, PUBLISHED_TEST_WORDS, 'tamper')).toBeNull();
  });

  it('checks the flag inside the function, not only at the call site', () => {
    /* A guard that lives only in the screen is a guard one refactor away from
     * being gone. This one is in the function, so every present and future
     * caller inherits it. */
    const source = readFileSync('src/demo/standin.ts', 'utf8');
    const body = source.slice(source.indexOf('export function standInVault'));
    expect(body).toMatch(/if \(!DEMO\) return null;/);
  });

  it('is the published test vector, and says so', () => {
    /* If this ever stopped being the BIP84 vector it would be somebody's real
     * phrase, which is the whole reason the gate exists. */
    expect(PUBLISHED_TEST_WORDS).toBe(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    );
    expect(readFileSync('src/demo/standin.ts', 'utf8')).toMatch(/published|everybody's/i);
  });
});
