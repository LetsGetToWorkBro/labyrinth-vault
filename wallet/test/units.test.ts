/**
 * Money, formatted, and never rounded on the way in.
 *
 * The parsing tests are the ones with teeth. Every wallet that has ever lost a
 * satoshi to a float lost it in a function shaped like `parseAmount`, and the
 * cases below are the ones that catch it: an amount that has no exact binary
 * form, an amount with more decimal places than the chain has, and the largest
 * amount anybody will ever type.
 */

import { describe, expect, it } from 'vitest';
import {
  elide,
  fiatCents,
  formatAmount,
  formatFiat,
  group,
  hasPrice,
  inGroups,
  parseAmount,
  relativeTime,
  sessionTime,
  splitAmount,
  THIN_SPACE,
} from '../src/core/units';

describe('typing an amount', () => {
  it('is exact for the numbers a float gets wrong', () => {
    expect(parseAmount('0.1', 'BTC').atoms).toBe(10_000_000n);
    expect(parseAmount('0.07', 'BTC').atoms).toBe(7_000_000n);
    expect(parseAmount('2.675', 'BTC').atoms).toBe(267_500_000n);
    expect(parseAmount('0.1', 'XMR').atoms).toBe(100_000_000_000n);
  });

  it('takes what people actually type', () => {
    expect(parseAmount(' 0.5 ', 'BTC').atoms).toBe(50_000_000n);
    expect(parseAmount('.5', 'BTC').atoms).toBe(50_000_000n);
    expect(parseAmount('1,250.5', 'XMR').atoms).toBe(1_250_500_000_000_000n);
    expect(parseAmount('21000000', 'BTC').atoms).toBe(2_100_000_000_000_000n);
  });

  it('refuses more precision than the chain has, rather than rounding it away', () => {
    expect(parseAmount('0.123456789', 'BTC')).toMatchObject({ ok: false });
    expect(parseAmount('0.123456789', 'BTC').problem).toMatch(/8 decimal places/);
    expect(parseAmount('0.1234567890123', 'XMR').ok).toBe(false);
    expect(parseAmount('0.123456789012', 'XMR').ok).toBe(true);
  });

  it('refuses everything that is not a number', () => {
    for (const text of ['', '.', 'abc', '0.1.2', '1e8', '-1', '0x10', '0']) {
      expect(parseAmount(text, 'BTC').ok, text).toBe(false);
    }
  });

  it('round-trips through formatting without drift', () => {
    for (const text of ['0.00000001', '0.482731', '1', '19.99999999', '0.1']) {
      const parsed = parseAmount(text, 'BTC');
      expect(parsed.ok).toBe(true);
      expect(parseAmount(formatAmount(parsed.atoms!, 'BTC'), 'BTC').atoms).toBe(parsed.atoms);
    }
  });
});

describe('showing an amount', () => {
  it('drops trailing zeros and never a digit that matters', () => {
    expect(splitAmount(48_273_100n, 'BTC')).toMatchObject({ whole: '0', fraction: '482731' });
    expect(splitAmount(100_000_000n, 'BTC')).toMatchObject({ whole: '1', fraction: '' });
    expect(splitAmount(1n, 'BTC')).toMatchObject({ whole: '0', fraction: '00000001' });
    expect(splitAmount(14_381_000_000_000n, 'XMR')).toMatchObject({ whole: '14', fraction: '381' });
  });

  it('never rounds, at any width', () => {
    // 0.48273199 must not become 0.482732, at any significance.
    const parts = splitAmount(48_273_199n, 'BTC');
    expect(parts.fraction).toBe('48273199');
    expect(parts.fraction.slice(0, parts.significant)).toBe('482731');
  });

  it('groups the integer side of a large readout', () => {
    expect(group('1234567')).toBe(`1${THIN_SPACE}234${THIN_SPACE}567`);
    expect(group('999')).toBe('999');
  });
});

describe('fiat', () => {
  it('computes value from an integer price, in cents', () => {
    // 0.482731 BTC at $117,880.00 is $56,904.33028, and the cent it is short
    // of $56,904.34 is not one to round up: the readout is not an estimate.
    expect(fiatCents(48_273_100n, 'BTC', 11_788_000)).toBe(5_690_433);
    expect(formatFiat(5_690_433)).toBe('$56,904.33');
  });

  it('always shows cents, so it never reads as an estimate', () => {
    expect(formatFiat(100)).toBe('$1.00');
    expect(formatFiat(0)).toBe('$0.00');
    expect(formatFiat(-2500)).toBe('-$25.00');
    expect(formatFiat(4500, { sign: true })).toBe('+$45.00');
  });

  it('adds up the way the home screen claims it does', () => {
    const btc = fiatCents(48_273_100n, 'BTC', 11_788_000);
    const xmr = fiatCents(14_381_000_000_000n, 'XMR', 26_580);
    expect(formatFiat(btc)).toBe('$56,904.33');
    expect(formatFiat(xmr)).toBe('$3,822.47');
    expect(formatFiat(btc + xmr)).toBe('$60,726.80');
  });

  it('knows the difference between a price and the absence of one', () => {
    /* Zero is what `centsPerUnit` holds in every live-node session, because
     * this wallet has no price feed. It means unknown, and every fiat line in
     * the app asks this before rendering, because "$0.00" under a real
     * balance is a claim that the money is worthless. The pathological values
     * count as absent too: a NaN that slipped through would otherwise render
     * as "$NaN". */
    expect(hasPrice(11_788_000)).toBe(true);
    expect(hasPrice(1)).toBe(true);
    expect(hasPrice(0)).toBe(false);
    expect(hasPrice(-1)).toBe(false);
    expect(hasPrice(Number.NaN)).toBe(false);
    expect(hasPrice(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('time, as a person reads it', () => {
  const now = new Date('2026-03-14T13:42:00Z').getTime();

  it('is coarse near the present and precise far from it', () => {
    expect(relativeTime(now - 10_000, now)).toBe('Just now');
    expect(relativeTime(now - 3 * 60_000, now)).toBe('3m ago');
    expect(relativeTime(now - 5 * 3_600_000, now)).toBe('5h ago');
    expect(relativeTime(now - 26 * 3_600_000, now)).toBe('Yesterday');
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe('4d ago');
    expect(relativeTime(now - 40 * 86_400_000, now)).toMatch(/^\d+ [A-Z][a-z]{2}$/);
  });

  it('never shows a negative age for a clock that is slightly ahead', () => {
    expect(relativeTime(now + 5_000, now)).toBe('Just now');
  });

  it('names the vault session the way the vault screen shows it', () => {
    expect(sessionTime(now, now)).toMatch(/^Today \d{1,2}:\d{2} (AM|PM)$/);
  });
});

describe('addresses, made readable', () => {
  it('elides in the middle, never only at the end', () => {
    const address = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
    expect(elide(address)).toBe('bc1qcr…306fyu');
    /* Both ends survive. An address elided only at the tail can be matched by
     * an attacker who grinds a prefix, and the person comparing two screens
     * would see what they expected to see. */
    expect(elide(address).startsWith(address.slice(0, 6))).toBe(true);
    expect(elide(address).endsWith(address.slice(-6))).toBe(true);
  });

  it('leaves short strings alone rather than eliding four characters into three', () => {
    expect(elide('bc1q')).toBe('bc1q');
  });

  it('groups in fours, which is how two screens get compared', () => {
    expect(inGroups('bc1qcr8te4kr6')).toEqual(['bc1q', 'cr8t', 'e4kr', '6']);
  });
});
