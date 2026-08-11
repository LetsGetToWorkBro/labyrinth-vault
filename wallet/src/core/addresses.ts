/**
 * Checking a destination, and being clear about what checking buys.
 *
 * Both address checkers live in the vault: `checkBtcAddress` in
 * `src/keys/bitcoin.ts` and `parseAddress` in `src/keys/monero.ts`. This file
 * imports them rather than writing its own, and that is deliberate to the
 * point of being a rule.
 *
 * Two implementations of "is this an address" drift. One gets a fix for a
 * bech32m edge case and the other does not, and then the wallet accepts a
 * string the vault will refuse — which is discovered at the worst possible
 * moment, with a hundred QR frames already animated and a person holding two
 * phones. Worse in the other direction: the wallet rejects something the vault
 * would have accepted, and a user concludes their address is broken.
 *
 * So there is one implementation of the address rules in this repository, and
 * both halves import it. Same for the wire (`core/wire.ts`). What the wallet
 * adds on top is the part that is only the online half's business: is this
 * address one of ours, does it belong to the chain the user is spending, and
 * what should the field say when it does not.
 *
 * ## What a valid checksum proves
 *
 * That the string was not corrupted between one place and another. Nothing
 * else. Clipboard malware substitutes an address that checksums perfectly, and
 * every wallet that has ever lost money this way was, at the moment it lost
 * it, showing a valid address. The defense is a person reading the destination
 * on the vault's screen — a second device, with its own copy of the bytes,
 * that the malware on this one does not control.
 *
 * Which is why this file goes out of its way to make an address *readable*:
 * grouped, in a monospaced face, at a size that can be checked against another
 * screen without leaning in. A validator is a convenience. The legibility is
 * the security.
 */

import { checkBtcAddress } from '@vault/keys/bitcoin';
import { parseAddress as parseMoneroAddress } from '@vault/keys/monero';
import type { Asset } from './model';

export interface AddressVerdict {
  ok: boolean;
  /** The address, trimmed. Present even when not ok, so the field can show
   *  what it is complaining about. */
  address: string;
  /** One sentence, sentence case, no exclamation marks. */
  problem: string | null;
  /** Something true and worth saying that is not a refusal. */
  note: string | null;
  /** What kind of thing it turned out to be, when we can tell. */
  kind: string | null;
}

const NO = (address: string, problem: string): AddressVerdict => ({
  ok: false,
  address,
  problem,
  note: null,
  kind: null,
});

/**
 * Check a typed or pasted destination for one asset.
 *
 * Deliberately refuses an address of the *other* asset with its own message
 * rather than a generic one. Pasting a Bitcoin address into a Monero send is a
 * thing people do at eleven at night, and "That is a Bitcoin address" is the
 * sentence that fixes it in a second.
 */
export function checkAddress(text: string, asset: Asset): AddressVerdict {
  const address = String(text ?? '').trim();
  if (address === '') return NO(address, 'Enter or scan a destination.');

  const looksMonero = /^[45][0-9A-Za-z]{90,}$/.test(address);
  const looksBitcoin = /^(bc1|tb1|bcrt1|[13])/i.test(address);

  if (asset === 'BTC') {
    if (looksMonero) return NO(address, 'That is a Monero address. This payment is in Bitcoin.');
    const verdict = checkBtcAddress(address);
    if (verdict.state !== 'ok') return NO(address, 'That is not a Bitcoin address.');
    return {
      ok: true,
      address,
      problem: null,
      note: address.toLowerCase().startsWith('bc1') ? null : 'Older address format. It works, and it costs more to spend from.',
      kind: verdict.note,
    };
  }

  if (looksBitcoin && !looksMonero) return NO(address, 'That is a Bitcoin address. This payment is in Monero.');
  const parsed = parseMoneroAddress(address);
  if (!parsed.valid) return NO(address, parsed.problem ?? 'That is not a Monero address.');
  if (parsed.network !== 'mainnet') {
    return NO(address, `That is a ${parsed.network} address, and this wallet watches mainnet.`);
  }
  return {
    ok: true,
    address,
    problem: null,
    note:
      parsed.kind === 'integrated'
        ? 'Integrated address. The payment ID travels with it.'
        : parsed.kind === 'subaddress'
          ? 'Subaddress.'
          : null,
    kind: parsed.kind,
  };
}

/**
 * Is this one of our own receiving addresses?
 *
 * Not an error — paying yourself is legitimate, and consolidating change is a
 * reason people do it on purpose. It is worth *saying*, because the other
 * reason it happens is that somebody pasted the wrong thing out of their own
 * clipboard history, and a wallet that stays silent about it is being polite
 * at their expense.
 */
export function isOwnAddress(address: string, own: readonly string[]): boolean {
  const needle = address.trim();
  return own.some((mine) => mine === needle);
}

/**
 * What the QR scanner just read, interpreted.
 *
 * Payment URIs are a real format people really share, and a wallet that makes
 * you strip `bitcoin:` off by hand is a wallet that has decided its own purity
 * matters more than the person using it. Amount and label ride along when they
 * are there; anything else in the query string is ignored rather than guessed
 * at.
 */
export interface ScannedPayment {
  address: string;
  /** Decimal string exactly as it appeared, parsed later by `parseAmount`. */
  amount: string | null;
  label: string | null;
}

export function readPaymentUri(scanned: string): ScannedPayment {
  const text = String(scanned ?? '').trim();
  const match = /^(bitcoin|monero):([^?]+)(\?(.*))?$/i.exec(text);
  if (!match) return { address: text, amount: null, label: null };

  const address = decodeURIComponent(match[2] ?? '');
  const query = match[4] ?? '';
  let amount: string | null = null;
  let label: string | null = null;

  for (const pair of query.split('&')) {
    const equals = pair.indexOf('=');
    if (equals === -1) continue;
    const key = pair.slice(0, equals).toLowerCase();
    const value = decodeURIComponent(pair.slice(equals + 1).replace(/\+/g, ' '));
    if (key === 'amount' && /^\d*\.?\d*$/.test(value)) amount = value;
    if ((key === 'label' || key === 'message') && label === null && value !== '') label = value;
  }

  return { address, amount, label };
}
