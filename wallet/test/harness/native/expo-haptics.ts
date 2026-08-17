/**
 * Touch, recorded.
 *
 * `design/haptics.ts` documents a vocabulary of five feels and says which
 * events are worth one: a signature arriving gets a pattern nothing else uses,
 * and nothing fires on a scroll or on a price that moved by itself. That is a
 * rule about behavior, and until this harness existed the only thing checking
 * it was somebody holding a phone.
 *
 * So the calls are kept in order. The enum values are the real ones, read out
 * of the installed package rather than guessed, because a test asserting the
 * mismatch warning uses the error pattern is asserting on these strings.
 */

export enum ImpactFeedbackStyle {
  Light = 'light',
  Medium = 'medium',
  Heavy = 'heavy',
  Soft = 'soft',
  Rigid = 'rigid',
}

export enum NotificationFeedbackType {
  Success = 'success',
  Warning = 'warning',
  Error = 'error',
}

/** Every haptic this process has fired, oldest first. */
export const felt: string[] = [];

export function reset(): void {
  felt.length = 0;
}

export async function impactAsync(style: ImpactFeedbackStyle = ImpactFeedbackStyle.Medium): Promise<void> {
  felt.push(`impact:${style}`);
}

export async function notificationAsync(
  type: NotificationFeedbackType = NotificationFeedbackType.Success,
): Promise<void> {
  felt.push(`notification:${type}`);
}

export async function selectionAsync(): Promise<void> {
  felt.push('selection');
}
