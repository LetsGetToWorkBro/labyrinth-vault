/*
 * The seam where the derivation leaves.
 *
 * Whether the two Argon2ids agree is settled elsewhere and by somebody else:
 * test/primitives.test.ts holds the TypeScript to test/fixtures/primitives.json
 * and ios/LabyrinthVaultKDFTests holds the C to the same file, and those
 * vectors come from the Argon2 reference by way of argon2-cffi. Neither side
 * is the oracle for the other.
 *
 * What is left is the plumbing, and the plumbing is where a fast unlock
 * quietly turns into a broken vault. These are the four ways that happens:
 * the native path is installed but never called, it is called with the wrong
 * arguments, it returns something the wrong shape and is believed anyway, or
 * a blob sealed by one path cannot be opened by the other.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { argon2id } from '@noble/hashes/argon2.js';
import {
  seal,
  setNativeArgon2id,
  nativeArgon2idInstalled,
  unseal,
  type KdfParams,
} from '../src/keys/seal';

const passphrase = new TextEncoder().encode('correct horse battery staple');
const secret = new Uint8Array(32).fill(9);
const random = new Uint8Array(40).map((_, i) => (i * 7 + 3) & 0xff);

/** Stands in for the host: the same algorithm, reached the other way. */
const workingNative = (
  pass: Uint8Array,
  salt: Uint8Array,
  params: KdfParams,
  dkLen: number,
) => argon2id(pass, salt, { t: params.t, m: params.m, p: params.p, dkLen });

afterEach(() => setNativeArgon2id(null));

describe('the native derivation seam', () => {
  beforeEach(() => setNativeArgon2id(null));

  it('is absent until a host installs one', () => {
    expect(nativeArgon2idInstalled()).toBe(false);
    setNativeArgon2id(workingNative);
    expect(nativeArgon2idInstalled()).toBe(true);
    setNativeArgon2id(null);
    expect(nativeArgon2idInstalled()).toBe(false);
  });

  it('is actually called, and given the parameters the header will carry', () => {
    const seen: Array<{ salt: number; params: KdfParams; dkLen: number }> = [];
    setNativeArgon2id((pass, salt, params, dkLen) => {
      seen.push({ salt: salt.length, params: { ...params }, dkLen });
      return workingNative(pass, salt, params, dkLen);
    });

    const sealed = seal(secret, passphrase, random, { t: 1, m: 8192, p: 1 });
    expect(sealed.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const [only] = seen;
    expect(only!.salt).toBe(16);
    expect(only!.dkLen).toBe(32);
    expect(only!.params).toEqual({ t: 1, m: 8192, p: 1 });
  });

  it('seals with one path and opens with the other, both ways round', () => {
    /* The property that matters. If these two ever disagree, a vault made on
     * a build with the native path does not open on a build without it, and
     * nothing on the way in would have said so. */
    const params: KdfParams = { t: 1, m: 8192, p: 1 };

    setNativeArgon2id(workingNative);
    const nativeSealed = seal(secret, passphrase, random, params);
    setNativeArgon2id(null);
    expect(unseal(nativeSealed.sealed!, passphrase).secret).toEqual(secret);

    setNativeArgon2id(null);
    const engineSealed = seal(secret, passphrase, random, params);
    setNativeArgon2id(workingNative);
    expect(unseal(engineSealed.sealed!, passphrase).secret).toEqual(secret);

    // And the bytes themselves are identical, which is the stronger claim.
    expect(nativeSealed.sealed).toEqual(engineSealed.sealed);
  });

  it('ignores a key of the wrong length rather than sealing under it', () => {
    /* A short key is a weaker vault that still opens, so it cannot be caught
     * later: by the time anything could notice, the blob exists. */
    let asked = 0;
    setNativeArgon2id((pass, salt, params, dkLen) => {
      asked += 1;
      return workingNative(pass, salt, params, dkLen).slice(0, 16);
    });

    const sealed = seal(secret, passphrase, random, { t: 1, m: 8192, p: 1 });
    expect(asked).toBe(1);
    expect(sealed.ok).toBe(true);

    setNativeArgon2id(null);
    expect(unseal(sealed.sealed!, passphrase).secret).toEqual(secret);
  });

  it('falls back rather than throwing when the host refuses', () => {
    /* A refusal is not a wrong answer. The slow path gives the right one, and
     * a person waiting a minute has an unlock; a person who cannot derive at
     * all has lost the vault. */
    for (const refusal of [null, undefined, [] as unknown as Uint8Array]) {
      setNativeArgon2id(() => refusal as Uint8Array | null);
      const sealed = seal(secret, passphrase, random, { t: 1, m: 8192, p: 1 });
      expect(sealed.ok).toBe(true);
      setNativeArgon2id(null);
      expect(unseal(sealed.sealed!, passphrase).secret).toEqual(secret);
    }
  });

  it('takes nothing but bytes and numbers across', () => {
    /* The seam is narrow on purpose. If the host ever needed to know about a
     * blob, a header or a limit, the judgement would have started to leak out
     * of seal.ts, which is the thing docs/native-primitives.md forbids. */
    setNativeArgon2id(function (this: unknown, ...args) {
      const [pass, salt, params, dkLen] = args;
      expect(args).toHaveLength(4);
      expect(pass).toBeInstanceOf(Uint8Array);
      expect(salt).toBeInstanceOf(Uint8Array);
      expect(Object.keys(params).sort()).toEqual(['m', 'p', 't']);
      expect(typeof dkLen).toBe('number');
      return workingNative(pass, salt, params, dkLen);
    });
    expect(seal(secret, passphrase, random, { t: 1, m: 8192, p: 1 }).ok).toBe(true);
  });
});
