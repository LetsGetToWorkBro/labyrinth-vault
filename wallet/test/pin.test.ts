/*
 * The PIN, and the one property that decides whether it is worth anything.
 *
 * A PIN compared against a stored value protects nothing: the seed would still
 * be in the keychain in the clear, and reading it never calls the comparison.
 * A PIN that seals the seed is a different object, and the test that separates
 * them is not "a wrong PIN is refused" but "a wrong PIN leaves you holding
 * ciphertext". Both are below and only the second one matters.
 *
 * The rest is the arithmetic that has to hold because twenty bits will not:
 * the attempt limit, the escalation, and the fact that the count lives where
 * rolling it back needs the same access as reading the blob.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MAX_ATTEMPTS,
  MIN_PIN,
  NO_ATTEMPTS,
  checkPin,
  chooseParams,
  gate,
  openWithPin,
  right,
  sealWithPin,
  spent,
  wrong,
} from '../src/core/pin';
import { KDF_LIMITS } from '@vault/keys/seal';

/* Fixed, so every answer is reproducible, and varied rather than a repeated
 * byte for the reason `keyvault.test.ts` spells out at length. */
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);
const RANDOM = Uint8Array.from({ length: 40 }, (_, i) => (i * 13 + 5) & 0xff);
/* The cheapest parameters this build will accept. Real, not a stub: these
 * tests run the actual Argon2id, and at the floor it costs a fraction of a
 * second, which is the whole reason the floor is where it is. */
const FAST = { t: 1, m: KDF_LIMITS.minM, p: 1 };

describe('a PIN seals the seed rather than gating it', () => {
  it('turns the secret into bytes that are not the secret', () => {
    const sealed = sealWithPin(SECRET, '481902', RANDOM, FAST);
    expect(sealed.ok, sealed.ok ? '' : sealed.problem).toBe(true);
    if (!sealed.ok) throw new Error(sealed.problem);
    /* The property. Anybody reading the keychain gets this, and this does not
     * contain the seed. */
    expect(Buffer.from(sealed.blob).includes(Buffer.from(SECRET))).toBe(false);
  });

  it('gives the secret back for the right PIN', () => {
    const sealed = sealWithPin(SECRET, '481902', RANDOM, FAST);
    if (!sealed.ok) throw new Error(sealed.problem);
    const opened = openWithPin(sealed.blob, '481902');
    expect(opened.ok, opened.ok ? '' : opened.problem).toBe(true);
    if (!opened.ok) throw new Error(opened.problem);
    expect([...opened.secret]).toEqual([...SECRET]);
  });

  it('gives nothing at all back for a wrong one', () => {
    /* Not a refusal that a caller could ignore: the tag fails and there is no
     * plaintext anywhere to return. */
    const sealed = sealWithPin(SECRET, '481902', RANDOM, FAST);
    if (!sealed.ok) throw new Error(sealed.problem);
    const opened = openWithPin(sealed.blob, '481903');
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error('a wrong PIN opened the seal');
    expect(opened.problem).toMatch(/did not open/);
  });

  it('says the same thing whatever went wrong', () => {
    /* A message distinguishing "wrong PIN" from "damaged blob" tells somebody
     * guessing which of the two they are looking at. */
    const sealed = sealWithPin(SECRET, '481902', RANDOM, FAST);
    if (!sealed.ok) throw new Error(sealed.problem);
    const wrongPin = openWithPin(sealed.blob, '999111');
    const damaged = openWithPin(Uint8Array.from({ length: 80 }, () => 9), '481902');
    expect(wrongPin.ok).toBe(false);
    expect(damaged.ok).toBe(false);
    if (wrongPin.ok || damaged.ok) throw new Error('unreachable');
    expect(wrongPin.problem).toBe(damaged.problem);
  });

  it('seals differently every time, given fresh randomness', () => {
    /* The salt and nonce come from the caller precisely so this is checkable.
     * Two identical blobs would mean a repeated nonce under a repeated key. */
    const other = Uint8Array.from({ length: 40 }, (_, i) => (i * 29 + 3) & 0xff);
    const a = sealWithPin(SECRET, '481902', RANDOM, FAST);
    const b = sealWithPin(SECRET, '481902', other, FAST);
    if (!a.ok || !b.ok) throw new Error('sealing failed');
    expect([...a.blob]).not.toEqual([...b.blob]);
  });

  it('refuses to seal under a PIN it would not let somebody choose', () => {
    /* Otherwise the rules below are a suggestion the storage layer can skip. */
    expect(sealWithPin(SECRET, '111111', RANDOM, FAST).ok).toBe(false);
    expect(sealWithPin(SECRET, '123', RANDOM, FAST).ok).toBe(false);
  });
});

describe('which PINs are allowed', () => {
  it('wants at least six digits', () => {
    expect(checkPin('12345'.padEnd(MIN_PIN - 1, '7')).ok).toBe(false);
    expect(checkPin('481902').ok).toBe(true);
    expect(checkPin('4819026734').ok).toBe(true);
  });

  it('refuses letters, and says why rather than only that', () => {
    const result = checkPin('abcdef');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problem).toMatch(/Digits only/);
    expect(result.problem).toMatch(/word/);
  });

  it('refuses the shapes that make six digits into two', () => {
    for (const pin of ['000000', '111111', '123456', '654321', '789012']) {
      expect(checkPin(pin).ok, `accepted ${pin}`).toBe(false);
    }
  });

  it('allows an ordinary PIN that merely contains a run', () => {
    /* The rule is about the whole PIN being a run, not about any three digits
     * inside it. A check that refused every PIN containing "123" would send
     * people to shorter and stranger ones. */
    expect(checkPin('412375').ok).toBe(true);
  });

  it('gives a sentence for every refusal, never a code', () => {
    for (const pin of ['', '12', 'abcdef', '000000', '123456']) {
      const result = checkPin(pin);
      if (result.ok) continue;
      expect(result.problem.length, `terse refusal for ${pin}`).toBeGreaterThan(20);
      expect(result.problem).toMatch(/[.]$/);
    }
  });
});

describe('the attempt limit, because twenty bits will not hold', () => {
  it('lets the first few through without a wait', () => {
    /* A person mistyping is not an attacker, and punishing the first mistake
     * teaches them the app is broken. */
    let attempts = NO_ATTEMPTS;
    for (let i = 0; i < 3; i++) {
      const decision = gate(attempts);
      expect(decision.allow).toBe(true);
      if (decision.allow) expect(decision.wait).toBe(0);
      attempts = wrong(attempts);
    }
  });

  it('escalates after that, and caps the wait', () => {
    let attempts = NO_ATTEMPTS;
    const waits: number[] = [];
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const decision = gate(attempts);
      if (decision.allow) waits.push(decision.wait);
      attempts = wrong(attempts);
    }
    /* Rising, and never past half a minute: longer is theater, because an
     * attacker scripting this is not watching a countdown. */
    for (let i = 1; i < waits.length; i++) expect(waits[i]!).toBeGreaterThanOrEqual(waits[i - 1]!);
    expect(Math.max(...waits)).toBeLessThanOrEqual(30_000);
  });

  it('stops answering after the limit, and says the words are the way back', () => {
    let attempts = NO_ATTEMPTS;
    for (let i = 0; i < MAX_ATTEMPTS; i++) attempts = wrong(attempts);
    const decision = gate(attempts);
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error('unreachable');
    expect(decision.reason).toMatch(/words on paper/);
    expect(spent(attempts)).toBe(true);
  });

  it('forgets rather than locks, so waiting is not a strategy', () => {
    /* A lockout that can be waited out is one an attacker waits out, and there
     * is nothing on this device to wait for. `spent` is what tells the storage
     * layer to destroy the record. */
    let attempts = NO_ATTEMPTS;
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) attempts = wrong(attempts);
    expect(spent(attempts)).toBe(false);
    expect(spent(wrong(attempts))).toBe(true);
  });

  it('resets to nothing on a right PIN, not down by one', () => {
    let attempts = NO_ATTEMPTS;
    for (let i = 0; i < 5; i++) attempts = wrong(attempts);
    expect(right().used).toBe(0);
    expect(gate(right()).allow).toBe(true);
  });

  it('counts down out loud, so somebody knows where they are', () => {
    const decision = gate({ used: 7 });
    expect(decision.allow).toBe(true);
    if (!decision.allow) throw new Error('unreachable');
    expect(decision.left).toBe(MAX_ATTEMPTS - 7);
  });
});

describe('choosing parameters the device can run', () => {
  it('comes down from 64 MiB until an attempt fits the budget', () => {
    /* The wallet's Argon2id is the engine's, and JavaScriptCore in a
     * third-party app gets no JIT. Picking a number a phone cannot run
     * produces an unlock nobody waits for and a PIN set short to compensate. */
    const slow = (params: { m: number }) => params.m / 8; // 64 MiB -> 8192ms
    expect(chooseParams(1_000, slow).m).toBe(8192);
  });

  it('keeps 64 MiB on a device fast enough for it', () => {
    expect(chooseParams(1_000, () => 200).m).toBe(65_536);
  });

  it('never goes below the floor, however slow the device', () => {
    /* Below the floor a million PINs is an afternoon. A device too slow even
     * for that gets the floor and the sentence that goes with it, rather than
     * a parameter that flatters the hardware. */
    const glacial = () => 999_999;
    expect(chooseParams(10, glacial).m).toBe(KDF_LIMITS.minM);
    expect(chooseParams(10, glacial).m).toBeGreaterThanOrEqual(KDF_LIMITS.minM);
  });

  it('produces parameters the sealer actually accepts', () => {
    /* A calibration that returned something `seal` refuses would be a PIN
     * nobody can set, discovered on a device. */
    const params = chooseParams(1_000, (p) => p.m / 8);
    const sealed = sealWithPin(SECRET, '481902', RANDOM, params);
    expect(sealed.ok, sealed.ok ? '' : sealed.problem).toBe(true);
  });
});

describe('what the module says about itself', () => {
  const source = readFileSync('src/core/pin.ts', 'utf8');

  it('admits it is weaker than what it replaced, and why specifically', () => {
    /* The claim has to be in the file somebody reads before trusting it. A
     * general "this is a tradeoff" is not the same as naming the hardware
     * property that is being given up. */
    expect(source).toMatch(/weaker than the biometric prompt it replaces/);
    expect(source).toMatch(/Secure Enclave/);
    expect(source).toMatch(/Anything worth more than a phone still belongs on the vault/);
  });

  it('reaches for the real sealer rather than rolling one', () => {
    expect(source).toMatch(/from '@vault\/keys\/seal'/);
    expect(source, 'a hand-rolled comparison is back').not.toMatch(/===\s*storedPin/);
  });
});
