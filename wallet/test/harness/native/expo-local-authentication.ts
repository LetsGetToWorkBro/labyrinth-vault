/**
 * The biometric gate, scriptable.
 *
 * This is the module the airgap's second rule leans on. `signgate.ts` decides
 * whether a key on this phone may be used at all, and `biometrics.ts` is the
 * only file allowed to import this one, which `hotsign.test.ts` enforces. What
 * no test could reach before was the *ordering*: whether a screen asks the
 * gate before it opens the keys, and what it does when a person cancels.
 *
 * So every answer here is settable, including refusal, because refusal is the
 * path that matters. The default is a phone with Face ID enrolled and a person
 * who approves, since that is the state most screens are exercised in.
 *
 * `SecurityLevel`'s numbers are the real ones, read from the installed
 * package. `biometrics.ts` compares against `SecurityLevel.NONE` to decide
 * whether a passcode exists at all, so a stand-in that renumbered them would
 * invert that answer.
 */

export enum SecurityLevel {
  NONE = 0,
  SECRET = 1,
  BIOMETRIC_WEAK = 2,
  BIOMETRIC_STRONG = 3,
}

interface Device {
  hardware: boolean;
  enrolled: boolean;
  level: SecurityLevel;
  /** What the sheet returns. `false` is a cancel, which is the branch a screen
   *  most often gets wrong: it is a refusal, not an error, and not a pass. */
  approves: boolean;
}

const DEFAULT: Device = {
  hardware: true,
  enrolled: true,
  level: SecurityLevel.BIOMETRIC_STRONG,
  approves: true,
};

let device: Device = { ...DEFAULT };

/** Every prompt this process raised, with the reason the caller gave for it.
 *  The reason is user-facing copy, so it is worth asserting on. */
export const prompts: string[] = [];

export function reset(): void {
  device = { ...DEFAULT };
  prompts.length = 0;
}

/** The phone a test wants: no hardware, nothing enrolled, or somebody who
 *  taps cancel. */
export function set(state: Partial<Device>): void {
  device = { ...device, ...state };
}

export async function hasHardwareAsync(): Promise<boolean> {
  return device.hardware;
}

export async function isEnrolledAsync(): Promise<boolean> {
  return device.enrolled;
}

export async function getEnrolledLevelAsync(): Promise<SecurityLevel> {
  return device.level;
}

export async function authenticateAsync(options?: {
  promptMessage?: string;
}): Promise<{ success: boolean; error?: string; warning?: string }> {
  prompts.push(options?.promptMessage ?? '');
  return device.approves ? { success: true } : { success: false, error: 'user_cancel' };
}
