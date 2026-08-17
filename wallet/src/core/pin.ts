/**
 * A PIN that actually seals the seed, and the reasons it has to.
 *
 * ## What replaced what
 *
 * This wallet used a biometric prompt per signature. The prompt is gone at the
 * owner's decision, and the thing that replaces it cannot be a comparison. That
 * distinction is the whole file, so it is worth being blunt about:
 *
 * A PIN that is **checked** against a stored value protects nothing. The seed
 * would still be sitting in the keychain in the clear, and anybody who can read
 * the keychain skips the check entirely by never calling the function that
 * performs it. That is a lock drawn on a door rather than fitted to it, and
 * `keyvault.ts` already refuses that class of thing under the name "a weak seal
 * on a seed, which is worse than an honest absence of one".
 *
 * A PIN that **seals** the seed is a different object. The seed is ciphertext,
 * the PIN is the only thing that turns it back into a key, and reading the
 * keychain gets you a blob. That is what this does, through `seal.ts`, which is
 * the same XChaCha20-Poly1305 over Argon2id the vault seals itself with.
 *
 * ## What a PIN is worth, stated plainly
 *
 * Six digits is about twenty bits. That is not a secret; it is a delay, and the
 * delay is only as long as one derivation times a million. So two things carry
 * this rather than one:
 *
 *   - **The KDF cost**, chosen per device by `chooseParams` so that one attempt
 *     is expensive on the hardware doing the attempting.
 *   - **The attempt limit**, because twenty bits will fall to a patient offline
 *     attacker whatever the KDF costs, and the only real answer to that is that
 *     the blob is in the keychain and getting it out needs an unlocked phone.
 *
 * **This is weaker than the biometric prompt it replaces**, and the honest
 * reason is specific rather than general: `expo-secure-store` can put a keychain
 * item behind Secure Enclave access control, where the hardware refuses to
 * release it without authentication and rate-limits the attempts itself. No
 * amount of application code reproduces that. What this design does instead is
 * make the stored bytes useless on their own, which is a real property and a
 * different one.
 *
 * Anything worth more than a phone still belongs on the vault. That sentence
 * survives every change to this half.
 */

import { seal, unseal, passphraseToBytes, KDF_LIMITS, type KdfParams } from '@vault/keys/seal';

/** The shortest PIN this wallet will accept. */
export const MIN_PIN = 6;

/**
 * How many attempts before the wallet stops answering.
 *
 * Ten, and then the sealed record is forgotten rather than merely locked. That
 * is the part worth arguing: a lockout that can be waited out is a lockout an
 * attacker waits out, and there is nothing on this device to wait for. The
 * words on paper are what restores the wallet, which is why the backup screens
 * had to exist before this one could.
 */
export const MAX_ATTEMPTS = 10;

export type PinCheck = { ok: true } | { ok: false; problem: string };

/**
 * Whether a PIN is allowed to be chosen, with the reason when it is not.
 *
 * Digits only, and that is deliberate rather than lazy: a field that accepts
 * letters invites a four-letter word, which is worse than four digits because
 * it feels stronger. If somebody wants a real secret they should be typing a
 * passphrase into the vault, and this file says so on screen rather than
 * pretending a PIN is one.
 */
export function checkPin(pin: string): PinCheck {
  if (!/^[0-9]*$/.test(pin)) {
    return { ok: false, problem: 'Digits only. A PIN that takes letters invites a short word, which is easier to guess than it looks.' };
  }
  if (pin.length < MIN_PIN) {
    return { ok: false, problem: `At least ${MIN_PIN} digits. Shorter is quick to guess for anybody holding your phone.` };
  }

  /* The three shapes that make a six-digit PIN into a two-digit one. Refused
   * with a reason rather than scored out of five: a strength meter teaches
   * people to satisfy the meter. */
  if (/^(.)\1*$/.test(pin)) {
    return { ok: false, problem: 'Every digit the same is one of ten possible PINs. Pick something else.' };
  }
  if (isRun(pin, 1) || isRun(pin, -1)) {
    return { ok: false, problem: 'Digits in a row are among the first anybody tries. Pick something else.' };
  }
  return { ok: true };
}

function isRun(pin: string, step: number): boolean {
  for (let i = 1; i < pin.length; i++) {
    if ((pin.charCodeAt(i) - pin.charCodeAt(i - 1) + 10) % 10 !== (step + 10) % 10) return false;
  }
  return pin.length > 1;
}

// ------------------------------------------------------------------ attempts

/**
 * What is known about the wrong PINs typed so far.
 *
 * Stored beside the sealed record rather than in memory, because an attempt
 * counter that resets when the app is killed is an attempt counter that counts
 * to one. This is the state an attacker most wants to roll back, and putting it
 * in the keychain is what makes rolling it back need the same access as reading
 * the blob itself.
 */
export interface Attempts {
  used: number;
}

export const NO_ATTEMPTS: Attempts = { used: 0 };

export type Gate =
  /** Try it. `wait` is milliseconds to hold off first, zero for most tries. */
  | { allow: true; wait: number; left: number }
  /** Do not try. The record is gone and the words on paper are the way back. */
  | { allow: false; reason: string };

/**
 * Whether another attempt may be made, and how long to wait first.
 *
 * The delay is doubling from the fourth wrong PIN, which is late on purpose:
 * the first few wrong entries are a person mistyping, and punishing that
 * teaches them the app is broken. It is the fifth onward that looks like
 * somebody working through a list.
 */
export function gate(attempts: Attempts): Gate {
  if (attempts.used >= MAX_ATTEMPTS) {
    return {
      allow: false,
      reason:
        `${MAX_ATTEMPTS} wrong PINs, so the keys on this phone have been forgotten. ` +
        'Your words on paper still restore this wallet, here or in any other software that reads them.',
    };
  }
  const over = Math.max(0, attempts.used - 3);
  /* Capped at half a minute. Longer is theater: an attacker scripting this is
   * not watching a countdown, and a person who mistyped six times is. */
  const wait = over === 0 ? 0 : Math.min(30_000, 250 * 2 ** over);
  return { allow: true, wait, left: MAX_ATTEMPTS - attempts.used };
}

/** After a wrong PIN. */
export function wrong(attempts: Attempts): Attempts {
  return { used: attempts.used + 1 };
}

/** After a right one. The count goes back to nothing, not down by one. */
export function right(): Attempts {
  return NO_ATTEMPTS;
}

/** Whether the record should now be destroyed rather than kept locked. */
export function spent(attempts: Attempts): boolean {
  return attempts.used >= MAX_ATTEMPTS;
}

// ----------------------------------------------------------------- the seal

/**
 * Pick KDF parameters this device can actually run.
 *
 * `seal.ts` has `calibrateKdf`, which searches *upward* from 64 MiB for a
 * device fast enough to want more. This searches downward, because the problem
 * here is the opposite one: the wallet is React Native, its Argon2id is the
 * engine's rather than a native module, and JavaScriptCore inside a third-party
 * app gets no JIT. The vault solved that with a compiled port; this half has
 * not, and picking a number a phone cannot run would produce an unlock nobody
 * waits for and a PIN they set to something short to compensate.
 *
 * The floor is `KDF_LIMITS.minM`, and it is a floor rather than a suggestion:
 * below it the derivation is cheap enough that a million PINs is an afternoon.
 * A device too slow even for that gets the floor anyway and the honest sentence
 * that goes with it, rather than a parameter that flatters the hardware.
 *
 * Measured rather than assumed, on the device, once, at the moment the PIN is
 * chosen. The answer goes into the blob header, so it is permanent for that
 * blob and a faster phone later does not silently weaken an existing one.
 */
export function chooseParams(
  targetMs: number,
  measure: (params: KdfParams) => number,
): KdfParams {
  let m = 65_536;
  for (;;) {
    const params: KdfParams = { t: 3, m, p: 1 };
    if (measure(params) <= targetMs) return params;
    if (m <= KDF_LIMITS.minM) return { t: 3, m: KDF_LIMITS.minM, p: 1 };
    m = Math.max(KDF_LIMITS.minM, Math.floor(m / 2));
  }
}

export type Sealed = { ok: true; blob: Uint8Array } | { ok: false; problem: string };
export type Opened = { ok: true; secret: Uint8Array } | { ok: false; problem: string };

/**
 * Seal bytes under a PIN.
 *
 * The randomness is a parameter for the reason it is one everywhere else in
 * this project: a function that reaches for a CSPRNG cannot be run against a
 * known answer. `seal` wants exactly forty bytes, salt and nonce together.
 */
export function sealWithPin(
  secret: Uint8Array,
  pin: string,
  random: Uint8Array,
  params: KdfParams,
): Sealed {
  const check = checkPin(pin);
  if (!check.ok) return { ok: false, problem: check.problem };

  const bytes = passphraseToBytes(pin);
  try {
    const result = seal(secret, bytes, random, params);
    if (!result.ok || !result.sealed) {
      return { ok: false, problem: result.problem ?? 'The keys could not be sealed.' };
    }
    return { ok: true, blob: result.sealed };
  } finally {
    bytes.fill(0);
  }
}

/**
 * Open a sealed blob with a PIN.
 *
 * A wrong PIN fails the Poly1305 tag rather than a comparison, which is worth
 * saying because it is the difference the whole file is about: there is no
 * branch here that an attacker could skip to get the secret anyway.
 */
export function openWithPin(blob: Uint8Array, pin: string): Opened {
  const bytes = passphraseToBytes(pin);
  try {
    const result = unseal(blob, bytes);
    if (!result.ok || !result.secret) {
      /* Deliberately the same sentence whatever went wrong. A message that
       * distinguished "wrong PIN" from "damaged blob" would tell somebody
       * guessing which of the two they are looking at. */
      return { ok: false, problem: 'That PIN did not open the keys on this phone.' };
    }
    return { ok: true, secret: result.secret };
  } finally {
    bytes.fill(0);
  }
}
