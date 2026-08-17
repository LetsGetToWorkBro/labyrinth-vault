/**
 * The only file in this application that imports `expo-local-authentication`.
 *
 * Same split as `keychainStore.ts` against `persist.ts`, and `signgate.ts`
 * names it: the thinking lives in `core/signgate.ts` as `decide`, which takes
 * facts and returns a verdict, so every refusal runs under Node in the tests.
 * This asks the device for those facts and puts the prompt on the glass.
 *
 * A gate whose refusals can only be exercised on a device is a gate whose
 * refusals have never been read.
 */

import {
  authenticateAsync,
  getEnrolledLevelAsync,
  hasHardwareAsync,
  isEnrolledAsync,
  SecurityLevel,
} from 'expo-local-authentication';
import { decide, type Biometrics } from '../core/signgate';
import type { GateResult } from '../core/hotsign';
import type { Source } from '../core/keyvault';

/** What the device says about itself, gathered rather than assumed. */
export async function readBiometrics(): Promise<Biometrics> {
  const [hardware, enrolled, level] = await Promise.all([
    hasHardwareAsync(),
    isEnrolledAsync(),
    getEnrolledLevelAsync(),
  ]);
  return {
    hardware,
    enrolled,
    /* Anything above `NONE` means the device has a passcode, which is what the
     * keychain's `WHEN_UNLOCKED_THIS_DEVICE_ONLY` class is resting on. A
     * biometric enrolment implies one, because iOS will not let a face be
     * registered without a passcode behind it. */
    passcode: level !== SecurityLevel.NONE,
  };
}

/**
 * Ask, once, for this one signature.
 *
 * Per signature and never per session. `signgate.ts` argues that out at
 * length; the short version is that a session-long unlock is a phone that
 * signs anything for as long as somebody keeps it awake, which is the hole the
 * prompt was closing.
 *
 * There is deliberately no cached answer here, no timestamp, and nothing to
 * remember. The absence is the feature, and it is why this function takes no
 * options: an argument like `withinSeconds` is the whole thing coming undone.
 */
export function nativeGate(source: Source, what: string): () => Promise<GateResult> {
  return async () => {
    const device = await readBiometrics();
    const verdict = decide(source, device);
    if (!verdict.allow) return { ok: false, problem: verdict.reason };
    if (!verdict.prompt) return { ok: true };

    const result = await authenticateAsync({
      promptMessage: what,
      /* The device passcode stays available, because refusing it would lock
       * somebody out of their own money over a setting. `decide` has already
       * established that a passcode exists. */
      disableDeviceFallback: false,
      cancelLabel: 'Cancel',
    });

    if (result.success) return { ok: true };
    /* A sentence rather than the platform's error code. `user_cancel` on a
     * screen is a person being told their own decision back in a language
     * nobody speaks. */
    return {
      ok: false,
      problem:
        result.error === 'user_cancel' || result.error === 'system_cancel' || result.error === 'app_cancel'
          ? 'Nothing was signed. Your payment is still here, unsent.'
          : 'This device did not confirm it was you, so nothing has been signed. Try again.',
    };
  };
}
