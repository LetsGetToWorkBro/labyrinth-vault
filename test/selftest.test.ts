/**
 * The launch gate itself.
 *
 * The app's rule is that nothing runs unless every check passes, which makes
 * the checks a single point of failure in both directions: a broken check
 * bricks a healthy app, and a vacuous one waves through a broken build. So
 * the suite tests the gate the same way the gate tests the crypto — including
 * that it actually fails when something underneath is wrong.
 */

import { describe, expect, it } from 'vitest';
import { allChecksPass, selfTest } from '../src/selftest';

describe('the launch self-test', () => {
  const checks = selfTest();

  it('passes, on a healthy build, with every check green', () => {
    for (const check of checks) {
      expect(check.ok, `${check.name}: ${check.detail}`).toBe(true);
    }
    expect(allChecksPass(checks)).toBe(true);
  });

  it('covers every module that can lose money', () => {
    const names = checks.map((check) => check.name.toLowerCase()).join(' | ');
    expect(names).toMatch(/sha-256/);
    expect(names).toMatch(/bytewords/);
    expect(names).toMatch(/bip84/);
    expect(names).toMatch(/sealed vault/);
    expect(names).toMatch(/keccak/);
    expect(names).toMatch(/base point/);
    expect(names).toMatch(/phrase/);
  });

  it('says what each check proves, because the screen shows a person', () => {
    for (const check of checks) {
      expect(check.proves.length, check.name).toBeGreaterThan(10);
    }
  });

  it('is fast enough to run at every launch without a spinner apology', () => {
    const before = Date.now();
    selfTest();
    expect(Date.now() - before).toBeLessThan(2000);
  });

  it('would actually gate: one failed check fails the whole list', () => {
    expect(allChecksPass([...checks, { name: 'x', proves: 'y', ok: false, detail: '' }])).toBe(false);
    expect(allChecksPass([])).toBe(false);
  });
});
