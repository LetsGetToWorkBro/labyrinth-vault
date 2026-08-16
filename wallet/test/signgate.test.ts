/*
 * What has to be true before this wallet signs with its own keys.
 *
 * The interesting assertions here are all about things that must never become
 * true: a vault account signing on this device, and a hot signature going
 * through without a prompt. Both are one branch away at all times, and both
 * are the kind of branch somebody adds for a good reason on a Tuesday.
 */

import { describe, expect, it } from 'vitest';
import { decide, everSignsUnprompted, type Biometrics } from '../src/core/signgate';

const ideal: Biometrics = { hardware: true, enrolled: true, passcode: true };
const noFaceId: Biometrics = { hardware: false, enrolled: false, passcode: true };
const notEnrolled: Biometrics = { hardware: true, enrolled: false, passcode: true };
const noPasscode: Biometrics = { hardware: true, enrolled: true, passcode: false };

/** Every combination, so no state is merely untested. */
const every: Biometrics[] = [0, 1].flatMap((h) =>
  [0, 1].flatMap((e) =>
    [0, 1].map((p) => ({ hardware: !!h, enrolled: !!e, passcode: !!p })),
  ),
);

describe('a vault account is never signable here', () => {
  it('is refused in every device state there is', () => {
    for (const device of every) {
      const verdict = decide('vault', device);
      expect(verdict.allow, `allowed on ${JSON.stringify(device)}`).toBe(false);
    }
  });

  it('says the vault signs for it, rather than reporting a device problem', () => {
    /* A person whose phone has no passcode and whose account is a vault
     * account must be told the second thing, not the first. Otherwise they set
     * a passcode, try again, and get refused for a reason nobody mentioned. */
    const verdict = decide('vault', noPasscode);
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) {
      expect(verdict.reason).toMatch(/vault signs for it/);
      expect(verdict.reason).not.toMatch(/passcode/);
    }
  });
});

describe('a hot account, on a device in each state', () => {
  it('signs after a prompt when everything is set up', () => {
    expect(decide('hot', ideal)).toEqual({ allow: true, prompt: true, reason: null });
  });

  it('still prompts with no Face ID hardware, because the passcode is the fallback', () => {
    /* Refusing here would lock somebody out of their own money over a setting.
     * The system offers the device passcode in the same prompt. */
    expect(decide('hot', noFaceId).allow).toBe(true);
    expect(decide('hot', notEnrolled).allow).toBe(true);
  });

  it('refuses outright with no device passcode', () => {
    /* The keychain item is WHEN_UNLOCKED_THIS_DEVICE_ONLY, which on a phone
     * with no passcode is a lock with no key in front of it. */
    const verdict = decide('hot', noPasscode);
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) expect(verdict.reason).toMatch(/no passcode/);
  });
});

describe('the prompt is per signature and cannot be skipped', () => {
  it('never allows a hot signature without one, in any device state', () => {
    for (const device of every) {
      expect(everSignsUnprompted(device), `unprompted on ${JSON.stringify(device)}`).toBe(false);
    }
  });

  it('allows nothing at all when the device has no passcode', () => {
    for (const source of ['hot', 'vault'] as const) {
      expect(decide(source, noPasscode).allow).toBe(false);
    }
  });

  it('gives a reason with every refusal, and none with an allow', () => {
    /* A refusal without a sentence is a dead end somebody photographs and
     * sends to us. An allow carrying one is a sentence nothing will show. */
    for (const source of ['hot', 'vault'] as const) {
      for (const device of every) {
        const verdict = decide(source, device);
        if (verdict.allow) expect(verdict.reason).toBeNull();
        else expect(verdict.reason.length).toBeGreaterThan(20);
      }
    }
  });
});
