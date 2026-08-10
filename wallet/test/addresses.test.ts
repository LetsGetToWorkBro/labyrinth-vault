/**
 * Destinations, and the difference between valid and correct.
 *
 * These tests are about the field a person pastes into and the camera that
 * fills it for them. What they cannot test — and what the interface therefore
 * has to keep saying out loud — is that a passing checksum proves only that
 * the string arrived intact. Clipboard malware substitutes an address that
 * validates perfectly, and every one of the cases below would wave it through.
 * The vault's screen is what catches that; this is spelling.
 */

import { describe, expect, it } from 'vitest';
import { checkAddress, isOwnAddress, readPaymentUri } from '../src/core/addresses';
import { DEMO_XMR_ADDRESS } from '../src/core/demo';

const BTC = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const LEGACY = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';

describe('a Bitcoin destination', () => {
  it('accepts the addresses this wallet derives for itself', () => {
    const verdict = checkAddress(BTC, 'BTC');
    expect(verdict.ok).toBe(true);
    expect(verdict.kind).toMatch(/bech32|address/i);
  });

  it('accepts an older format and says what it will cost', () => {
    const verdict = checkAddress(LEGACY, 'BTC');
    expect(verdict.ok).toBe(true);
    expect(verdict.note).toMatch(/costs more/);
  });

  it('refuses one wrong character, because that is what a checksum is for', () => {
    expect(checkAddress(BTC.slice(0, -1) + 'x', 'BTC').ok).toBe(false);
  });

  it('says plainly when the address is for the other chain', () => {
    const verdict = checkAddress(DEMO_XMR_ADDRESS, 'BTC');
    expect(verdict.ok).toBe(false);
    expect(verdict.problem).toBe('That is a Monero address. This payment is in Bitcoin.');
  });

  it('asks for something rather than complaining about nothing', () => {
    expect(checkAddress('   ', 'BTC').problem).toMatch(/Enter or scan/);
  });
});

describe('a Monero destination', () => {
  it('accepts a real one', () => {
    expect(checkAddress(DEMO_XMR_ADDRESS, 'XMR').ok).toBe(true);
  });

  it('refuses a mangled one', () => {
    expect(checkAddress(DEMO_XMR_ADDRESS.slice(0, -2) + 'zz', 'XMR').ok).toBe(false);
  });

  it('says plainly when the address is for the other chain', () => {
    const verdict = checkAddress(BTC, 'XMR');
    expect(verdict.ok).toBe(false);
    expect(verdict.problem).toBe('That is a Bitcoin address. This payment is in Monero.');
  });
});

describe('what the camera and the clipboard hand over', () => {
  it('reads a payment URI, amount and all', () => {
    expect(readPaymentUri(`bitcoin:${BTC}?amount=0.482731&label=Rent`)).toEqual({
      address: BTC,
      amount: '0.482731',
      label: 'Rent',
    });
  });

  it('reads a bare address unchanged', () => {
    expect(readPaymentUri(BTC)).toEqual({ address: BTC, amount: null, label: null });
  });

  it('ignores an amount that is not a number rather than guessing at one', () => {
    expect(readPaymentUri(`bitcoin:${BTC}?amount=lots`).amount).toBeNull();
  });

  it('ignores query parameters it does not understand', () => {
    const read = readPaymentUri(`monero:${DEMO_XMR_ADDRESS}?tx_payment_id=abc&amount=1.5`);
    expect(read.address).toBe(DEMO_XMR_ADDRESS);
    expect(read.amount).toBe('1.5');
  });

  it('hands back whatever a stray QR contained, for the checker to refuse', () => {
    /* The scanner passes everything through here and then through
     * `checkAddress`. A wifi code must come out the far side as a refusal with
     * a sentence, never as a destination. */
    const read = readPaymentUri('WIFI:S=Cafe;T=WPA;P=hunter2;;');
    expect(checkAddress(read.address, 'BTC').ok).toBe(false);
  });
});

describe('paying yourself', () => {
  it('is recognised, because it is usually a mistake and sometimes not', () => {
    expect(isOwnAddress(BTC, [BTC, LEGACY])).toBe(true);
    expect(isOwnAddress(LEGACY, [BTC])).toBe(false);
  });
});
