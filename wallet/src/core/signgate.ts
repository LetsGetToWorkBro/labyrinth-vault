/**
 * What has to be true before this wallet signs anything with its own keys.
 *
 * ## The gap this closes
 *
 * `keyvault.ts` puts the seed in the platform keychain under
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, which is the right store and leaves exactly
 * one hole: a phone taken while unlocked. Nothing about keychain storage
 * defends against that, because the device is in the state the keychain is
 * waiting for.
 *
 * Two ways to close it, and the obvious one is the wrong one. A passphrase
 * over Argon2id is what the vault does and it works, but the vault is opened
 * rarely and deliberately while a wallet is opened ten times a day. Friction
 * that size does not produce careful people; it produces four-character
 * passphrases, which look like protection in a screenshot and are not. It also
 * means shipping the vendored Argon2id C into a React Native build that
 * `expo prebuild --clean` regenerates.
 *
 * A biometric check per signature closes the same hole, costs under a second,
 * and its fallback is the device passcode that the keychain is already
 * trusting. So that is the trade this file makes.
 *
 * ## The rule
 *
 * Per **signature**, not per session. A session-long unlock is a phone that
 * signs anything for as long as somebody keeps it awake, which is the hole
 * again with more steps. The prompt is cheap; the thing it authorizes is not.
 *
 * ## Why a policy split
 *
 * `decide` is the whole of the thinking and it takes facts rather than asking
 * for them, so every branch runs under Node in the tests. `nativeGate` is the
 * only place `expo-local-authentication` is imported, the same split
 * `persist.ts` has against `keychainStore.ts`. A gate whose refusals can only
 * be exercised on a device is a gate whose refusals have never been read.
 */

import type { Source } from './keyvault';
import { canSignHere } from './keyvault';

/** What the device says about itself. Facts, gathered by the caller. */
export interface Biometrics {
  /** Hardware exists. False on a device with no Face ID or Touch ID. */
  hardware: boolean;
  /** A face or a finger is actually enrolled. */
  enrolled: boolean;
  /** A passcode is set, which is what the fallback rests on. */
  passcode: boolean;
}

export type Verdict =
  /** Prompt, then sign if the prompt succeeds. */
  | { allow: true; prompt: true; reason: null }
  /** Sign without a prompt. Only ever for a vault account, which signs
   *  elsewhere anyway, so in practice this never authorizes a hot signature. */
  | { allow: true; prompt: false; reason: null }
  | { allow: false; prompt: false; reason: string };

/**
 * Whether a signature may proceed, and whether to ask first.
 *
 * Order matters and it is not arbitrary. The vault check comes first because
 * it is absolute: no device state, no enrolment, nothing at all makes a
 * vault-paired account signable here, and putting that check anywhere but
 * first invites a later branch that reaches an allow before it.
 */
export function decide(source: Source, device: Biometrics): Verdict {
  if (!canSignHere(source)) {
    return {
      allow: false,
      prompt: false,
      reason:
        'This account was paired from a vault, so its keys are not on this device. ' +
        'Your vault signs for it.',
    };
  }

  if (!device.passcode) {
    /* The keychain item is `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, which on a device
     * with no passcode is a lock with no key in front of it. Refusing here is
     * the same refusal the vault makes at setup, for the same reason. */
    return {
      allow: false,
      prompt: false,
      reason:
        'This phone has no passcode, so nothing protects the keys stored on it. ' +
        'Set one in Settings, then try again.',
    };
  }

  if (!device.hardware || !device.enrolled) {
    /* Face ID absent or not set up. The device passcode is still the fallback
     * the system offers, and `expo-local-authentication` will present it, so a
     * prompt is still the right answer rather than a refusal. Refusing here
     * would lock somebody out of their own money over a setting. */
    return { allow: true, prompt: true, reason: null };
  }

  return { allow: true, prompt: true, reason: null };
}

/**
 * Whether a hot signature can ever proceed without a prompt.
 *
 * Its own function so a test can assert the answer is no, whatever `decide`
 * grows into. The convenience this forbids is "they authorized one a moment
 * ago, skip it", which turns a per-signature gate into a session and puts the
 * hole back.
 */
export function everSignsUnprompted(device: Biometrics): boolean {
  const verdict = decide('hot', device);
  return verdict.allow && !verdict.prompt;
}
