/**
 * The whole machine proving itself, once, before it is allowed to hold money.
 *
 * This is the one function the app calls at launch, and the rule is simple:
 * if anything here fails, nothing else runs. Not a toast, not a "continue
 * anyway" button. A signing device whose hash is wrong, or whose derivation
 * stopped matching the published vectors, has exactly one honest behaviour,
 * which is to say so and stop.
 *
 * Why at launch rather than in CI: CI proved a build on somebody's laptop
 * months ago. This proves the binary actually running on this actual phone,
 * after the app store, the code signing, the JS engine and the passage of
 * time have all had their chance to change something. The checks are fast, a
 * few hundred milliseconds, and the reassurance is renewed every time rather
 * than asserted once.
 *
 * Every check that can be pinned to an outside implementation is. The vectors
 * come from NIST, from BIP84's own text, from the Monero project's published
 * address, from the BC-UR reference implementation, from libsodium and from
 * the Argon2 reference code. Agreement with strangers is the only kind of
 * self-test that means much; a machine agreeing with itself proves it is
 * consistent, not that it is right.
 */

import { bytewordsEncode } from './airgap/bytewords';
import { sha256 } from './airgap/sha256';
import { selfTest as bitcoinSelfTest } from './keys/bitcoin';
import { allChecksPass, selfTest as moneroSelfTest, toHex, type Check } from './keys/monero';
import { selfTest as moneroCryptoSelfTest } from './keys/monerocrypto';
import { passphraseToBytes, seal, unseal } from './keys/seal';
import { wipe } from './keys/wipe';

export type { Check };

/** Equal contents, without turning either side into a string to find out. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function check(name: string, proves: string, run: () => [boolean, string]): Check {
  try {
    const [ok, detail] = run();
    return { name, proves, ok, detail };
  } catch (error) {
    return { name, proves, ok: false, detail: (error as Error).message };
  }
}

/**
 * Everything, in one list, for one screen.
 *
 * Deliberately cheap enough to run at every launch. The KDF check uses the
 * smallest parameters this build accepts, so it exercises the real code path
 * in tens of milliseconds instead of the full second a real unseal costs.
 */
export function selfTest(): Check[] {
  const checks: Check[] = [];

  checks.push(
    check('SHA-256 against the NIST vector', 'The hash under BC-UR frames and approval digests is the real SHA-256.', () => {
      const got = toHex(sha256(new TextEncoder().encode('abc')));
      const want = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
      return [got === want, got];
    }),
  );

  checks.push(
    check('Bytewords against the reference implementation', 'The QR alphabet spoken to Sparrow and Electrum matches theirs, word for word.', () => {
      const got = bytewordsEncode(new Uint8Array([0]), 'minimal');
      return [got === 'aetdaowslg', got];
    }),
  );

  checks.push(
    check('BIP84 against the vector in the specification', 'Bitcoin keys derived here match the published answers, address for address.', () => {
      const result = bitcoinSelfTest();
      return [result.ok, result.ok ? 'matches' : result.problem ?? 'failed'];
    }),
  );

  checks.push(
    check('The sealed vault, there and back', 'Sealing a secret and opening it returns the same bytes, and a wrong passphrase returns nothing.', () => {
      const secret = new Uint8Array(32).fill(7);
      const random = new Uint8Array(40);
      for (let i = 0; i < random.length; i++) random[i] = (i * 37 + 11) & 0xff;
      const pass = passphraseToBytes('self test passphrase');
      const sealed = seal(secret, pass, random, { t: 1, m: 8192, p: 1 });
      if (!sealed.ok) return [false, sealed.problem ?? 'seal failed'];
      const opened = unseal(sealed.sealed!, pass);
      const wrong = unseal(sealed.sealed!, passphraseToBytes('not that passphrase'));
      wipe(pass);
      /* Compared as bytes. Hex-encoding them to compare would make two
       * unwipeable copies of a secret for no reason, and while this particular
       * one is a fixed test value, the habit is the thing being kept. */
      const ok = opened.ok && !!opened.secret && sameBytes(opened.secret, secret) && !wrong.ok;
      if (opened.secret) wipe(opened.secret);
      return [ok, ok ? 'round-trips, refuses the wrong passphrase' : 'failed'];
    }),
  );

  // The Monero checks carry their own names and reasons; they join as-is.
  checks.push(...moneroSelfTest());

  /* The spending primitives, against the Monero project's own vectors. They
   * are not on any path that signs today — nothing here signs a Monero
   * transaction — but they are the floor that one will stand on, and a
   * primitive that starts failing should be caught at the launch that breaks
   * it rather than at the commit that finally depends on it. */
  checks.push(...moneroCryptoSelfTest());

  return checks;
}

/** True only when every check passed, and there was at least one. */
export { allChecksPass };
