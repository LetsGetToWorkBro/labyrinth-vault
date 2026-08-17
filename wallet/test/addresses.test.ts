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
import { addressChecksum, base58Encode, fromHex, parseAddress } from '@vault/keys/monero';
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

  /**
   * One spelling, because two of them read as two payments.
   *
   * BIP173 declares an uppercase bech32 address valid and recommends it inside
   * QR codes, so `BC1Q...` arrives here from real senders. Every re-encoding
   * of it is lowercase, including the vault's review screen and
   * `getOutputAddress` on the transaction that comes back, so a wallet that
   * carried the pasted spelling forward showed one string while the vault
   * showed another. The person doing the read-across is then comparing two
   * different-looking strings, and `verifySigned` refused the correct
   * signature outright.
   */
  it('hands back one spelling of an address, whatever case it arrived in', () => {
    const upper = BTC.toUpperCase();
    /* Not a degenerate fixture: this address has letters in it, so uppercasing
     * it genuinely changes the string. */
    expect(upper).not.toBe(BTC);

    const verdict = checkAddress(upper, 'BTC');
    expect(verdict.ok).toBe(true);
    expect(verdict.address).toBe(BTC);
    expect(checkAddress(BTC, 'BTC').address).toBe(BTC);
  });

  it('leaves a case-sensitive legacy address exactly as it is', () => {
    /* Base58 is case-sensitive, so canonicalizing must not touch it. An
     * address checker that lowercased everything would break the older format
     * while fixing the newer one. */
    expect(checkAddress(LEGACY, 'BTC').address).toBe(LEGACY);
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
      problem: null,
    });
  });

  it('reads a bare address unchanged', () => {
    expect(readPaymentUri(BTC)).toEqual({ address: BTC, amount: null, label: null, problem: null });
  });

  it('ignores an amount that is not a number rather than guessing at one', () => {
    expect(readPaymentUri(`bitcoin:${BTC}?amount=lots`).amount).toBeNull();
  });

  /**
   * The two schemes spell their parameters differently, and one of them was
   * being read with the other's dictionary.
   *
   * `bitcoin:` is BIP21 and says `amount`. `monero:` says `tx_amount`. Looking
   * for BIP21's names inside a Monero URI finds nothing, so a Monero QR
   * carrying an amount landed as an address with an empty amount field and the
   * person retyped a number that was already on the screen they scanned.
   */
  it('reads a Monero URI with Monero parameter names', () => {
    const read = readPaymentUri(`monero:${DEMO_XMR_ADDRESS}?tx_amount=1.5&recipient_name=Ana`);
    expect(read.address).toBe(DEMO_XMR_ADDRESS);
    expect(read.amount).toBe('1.5');
    expect(read.label).toBe('Ana');
    expect(read.problem).toBeNull();
  });

  it('does not read BIP21 parameter names out of a Monero URI', () => {
    /* Guessing at the other scheme's names is how a `label` meant for one
     * chain becomes an amount on the other. Unrecognized keys are ignored, as
     * they always were. */
    expect(readPaymentUri(`monero:${DEMO_XMR_ADDRESS}?amount=1.5`).amount).toBeNull();
  });

  /**
   * A payment ID this wallet cannot attach is a destination it must not pay.
   *
   * The URI was previously accepted as a bare address: the transaction goes
   * out, arrives, and is never credited, because the exchange on the other end
   * matches deposits by the payment ID that was dropped. Nothing on any screen
   * would have said so. There is no partial answer here, so the address is
   * withheld along with the sentence that explains it.
   */
  it('refuses a Monero URI carrying a payment ID it cannot attach', () => {
    const read = readPaymentUri(`monero:${DEMO_XMR_ADDRESS}?tx_payment_id=1a2b3c4d5e6f7a8b&tx_amount=2`);
    expect(read.problem).toMatch(/payment ID/);
    expect(read.problem, 'a refusal has to say what to do next').toMatch(/integrated address/);
    expect(read.address, 'the unattachable payment was handed on as payable').toBe('');
    /* And the refusal survives the checker the screens run it through, so no
     * path reaches a recipient field with it. */
    expect(checkAddress(read.address, 'XMR').ok).toBe(false);
  });

  it('accepts an integrated address, which carries its payment ID inside it', () => {
    /* The distinction the refusal above rests on, exercised rather than
     * asserted. The demo address is a *standard* one, so testing this against
     * it would be a fixture that cannot reach the branch it names. This builds
     * the real thing: the same two public keys under mainnet's integrated
     * prefix, with the payment ID inside the address where this wallet needs
     * no way to attach it. */
    const parsed = parseAddress(DEMO_XMR_ADDRESS);
    expect(parsed.kind).toBe('standard');

    const body = new Uint8Array(1 + 32 + 32 + 8);
    body[0] = 19; // mainnet, integrated
    body.set(fromHex(parsed.spendPublic!), 1);
    body.set(fromHex(parsed.viewPublic!), 33);
    body.set(fromHex('0011223344556677'), 65);
    const integrated = base58Encode(new Uint8Array([...body, ...addressChecksum(body)]));
    expect(parseAddress(integrated).kind, 'the fixture is not integrated').toBe('integrated');

    const verdict = checkAddress(integrated, 'XMR');
    expect(verdict.ok, verdict.problem ?? '').toBe(true);
    expect(verdict.note).toMatch(/payment ID travels with it/);
    expect(readPaymentUri(`monero:${integrated}`).problem).toBeNull();
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
  it('is recognized, because it is usually a mistake and sometimes not', () => {
    expect(isOwnAddress(BTC, [BTC, LEGACY])).toBe(true);
    expect(isOwnAddress(LEGACY, [BTC])).toBe(false);
  });
});
