/**
 * Touch, as a vocabulary of five things rather than a call site's whim.
 *
 * Haptics are the only channel in this application that reaches a person who
 * is not looking at the screen — which, during a QR handoff, is most of the
 * time: they are holding this phone up and watching the *other* one. So the
 * important events have their own feel, and it is consistent everywhere.
 *
 *   tap        — something was pressed. Light, and the only one used casually.
 *   confirmed  — an address copied, a frame captured. A short success.
 *   arrived    — a signature came back and matched. The good one, used once
 *                per payment, and never for anything smaller.
 *   refused    — a mismatch, a bad address, a broadcast that failed. The
 *                warning pattern, which is deliberately unpleasant.
 *   settled    — a confirmation landed on chain. Soft, two beats, in the
 *                background of somebody's day rather than in their face.
 *
 * Nothing fires a haptic on a screen transition, on a scroll, or on a value
 * that changed by itself. A device that buzzes when the price moves is a
 * device people turn haptics off on, and then the mismatch warning is silent
 * too.
 */

import * as Haptics from 'expo-haptics';

export function tap(weight: 'light' | 'medium' | 'heavy' = 'light'): void {
  const style =
    weight === 'heavy'
      ? Haptics.ImpactFeedbackStyle.Heavy
      : weight === 'medium'
        ? Haptics.ImpactFeedbackStyle.Medium
        : Haptics.ImpactFeedbackStyle.Light;
  void Haptics.impactAsync(style);
}

export function confirmed(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

export function refused(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
}

/**
 * The signature arriving.
 *
 * Two impacts, medium then heavy, forty milliseconds apart: a latch closing.
 * This is the moment the two halves of the system meet, and it is worth a
 * pattern nothing else in the application uses.
 */
export function arrived(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  setTimeout(() => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy), 40);
}

/** A confirmation landing. Two soft beats, easy to miss on purpose. */
export function settled(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
  setTimeout(() => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft), 120);
}
