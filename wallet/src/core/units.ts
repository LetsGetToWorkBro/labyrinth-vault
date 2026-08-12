/**
 * Numbers, and the fact that they are somebody's money.
 *
 * Every amount in this application is an integer count of the smallest unit —
 * satoshi, piconero, cents — and it stays that way from the moment it is typed
 * to the moment it is put on the wire. Nothing here goes through a float.
 *
 * That is not fastidiousness. `0.1` has no exact binary form, and a wallet
 * that parses "0.1 BTC" into a double and multiplies by 1e8 gets 10000000.000
 * 000002 on a good day and a number ending in 9999998 on a bad one. Sometimes
 * that rounds back. Sometimes it is one satoshi short of a UTXO and the coin
 * selection changes, and the person on the confirmation screen is looking at a
 * transaction that is not the one they asked for. The vault would catch that
 * — it renders what it is about to sign — but "the other device will notice"
 * is not a reason to be careless here.
 *
 * So: string arithmetic on the way in, integer arithmetic in the middle, and
 * formatting only at the display edge.
 *
 * The display functions return the integer and fractional parts separately.
 * That is a design decision leaking into a utility file, and it earns its
 * place: the balance on the home screen is rendered as an instrument readout,
 * with the significant figures bright and the tail of the fraction dimmed, and
 * doing that with a formatted string means slicing text back apart in a view.
 */

import { ATOMS_PER_UNIT, DECIMALS, type Asset, type Atoms } from './model';

// ------------------------------------------------------------------ parsing

export interface ParseResult {
  ok: boolean;
  atoms?: Atoms;
  /** Written for a person, in the voice used everywhere else. */
  problem?: string;
}

/**
 * Turn typed text into an integer count of atoms.
 *
 * Accepts what people actually type: leading and trailing spaces, a leading
 * dot, thousands separators. Refuses everything else rather than guessing,
 * because the guess that goes wrong here is expensive.
 */
export function parseAmount(text: string, asset: Asset): ParseResult {
  const cleaned = text.trim().replace(/,/g, '').replace(/\s/g, '');
  if (cleaned === '' || cleaned === '.') return { ok: false, problem: 'Enter an amount' };
  if (!/^\d*\.?\d*$/.test(cleaned)) return { ok: false, problem: 'Numbers only' };

  const dot = cleaned.indexOf('.');
  const whole = dot === -1 ? cleaned : cleaned.slice(0, dot);
  const fractionRaw = dot === -1 ? '' : cleaned.slice(dot + 1);
  const places = DECIMALS[asset];

  if (fractionRaw.length > places) {
    return { ok: false, problem: `${asset} goes to ${places} decimal places` };
  }

  const fraction = fractionRaw.padEnd(places, '0');
  const atoms = BigInt(whole === '' ? '0' : whole) * ATOMS_PER_UNIT[asset] + BigInt(fraction === '' ? '0' : fraction);
  if (atoms === 0n) return { ok: false, problem: 'Enter an amount' };
  return { ok: true, atoms };
}

// --------------------------------------------------------------- formatting

export interface Parts {
  /** Grouped with thin spaces at the display layer, not here. */
  whole: string;
  /** Without the dot. Empty when the amount is a whole number. */
  fraction: string;
  /** How many leading fraction digits are worth reading at a glance. Used to
   *  dim the tail; purely presentational, never rounded with. */
  significant: number;
}

/**
 * Split an amount into the pieces a readout wants.
 *
 * Trailing zeros are dropped, because `0.48273100` is eight characters of
 * nothing and this design gives typography room rather than filling it. What
 * is never dropped is a digit that is not zero: no rounding happens here, at
 * any width. A wallet that shows `0.4827` when the balance is `0.482731`
 * has told a small lie that becomes a large one the moment somebody types the
 * number they saw into a send field.
 */
export function splitAmount(atoms: Atoms, asset: Asset): Parts {
  const negative = atoms < 0n;
  const magnitude = negative ? -atoms : atoms;
  const per = ATOMS_PER_UNIT[asset];
  const whole = magnitude / per;
  const fraction = (magnitude % per).toString().padStart(DECIMALS[asset], '0').replace(/0+$/, '');
  return {
    whole: (negative ? '-' : '') + whole.toString(),
    fraction,
    significant: Math.min(fraction.length, asset === 'BTC' ? 6 : 4),
  };
}

/** The whole thing as one string, for places that are not the big readout. */
export function formatAmount(atoms: Atoms, asset: Asset): string {
  const { whole, fraction } = splitAmount(atoms, asset);
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/**
 * U+2009, a thin space, and it is deliberate.
 *
 * A comma between the thousands of a *crypto* amount is a false friend: half
 * the world reads `1,250` as one thousand two hundred and fifty and half reads
 * it as one and a quarter. A thin space is unambiguous under both conventions,
 * which is the same reason SI writes numbers that way. Fiat keeps its comma,
 * because a dollar figure is being read as a dollar figure.
 */
export const THIN_SPACE = ' ';

/** Thin-space grouping for the integer part of a large readout. */
export function group(whole: string): string {
  const negative = whole.startsWith('-');
  const digits = negative ? whole.slice(1) : whole;
  const out = digits.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
  return negative ? `-${out}` : out;
}

// --------------------------------------------------------------------- fiat

/**
 * Value in whole cents, from an integer price in cents per whole unit.
 *
 * Rounds half up at the last step and nowhere else. The result is a
 * presentation number: it is shown to people, and it is never the basis of an
 * amount that gets spent.
 */
export function fiatCents(atoms: Atoms, asset: Asset, centsPerUnit: number): number {
  const per = ATOMS_PER_UNIT[asset];
  const scaled = atoms * BigInt(Math.round(centsPerUnit));
  const whole = scaled / per;
  const remainder = scaled % per;
  const rounded = remainder * 2n >= per ? whole + 1n : whole;
  return Number(rounded);
}

/**
 * Whether a price is known at all.
 *
 * This wallet has no price source. That is a decision, not a gap: a price feed
 * is one more server that learns when the app is open, and the fixture is the
 * only place a price comes from today. So `centsPerUnit` is zero everywhere a
 * real node is answering, and zero means *unknown*, never "worth nothing".
 * Every screen that renders fiat asks this first, because "$0.00" under a real
 * balance is a claim about what somebody's money is worth, and a false one.
 */
export function hasPrice(centsPerUnit: number): boolean {
  return Number.isFinite(centsPerUnit) && centsPerUnit > 0;
}

/** `$48,291.82`. Cents are always shown; a readout that drops them looks like
 *  an estimate, and this one is not. */
export function formatFiat(cents: number, opts: { sign?: boolean } = {}): string {
  const negative = cents < 0;
  const magnitude = Math.abs(Math.round(cents));
  const dollars = Math.floor(magnitude / 100).toString();
  const rest = (magnitude % 100).toString().padStart(2, '0');
  const grouped = dollars.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = negative ? '-' : opts.sign ? '+' : '';
  return `${sign}$${grouped}.${rest}`;
}

// ----------------------------------------------------------------- fee rate

/** Satoshi per virtual byte, or the Monero equivalent, as a readable string. */
export function formatFeeRate(rate: number, asset: Asset): string {
  return asset === 'BTC' ? `${rate.toFixed(rate < 10 ? 1 : 0)} sat/vB` : `${rate.toFixed(2)}×`;
}

// --------------------------------------------------------------------- time

/**
 * "3m ago", "Yesterday", "14 Mar".
 *
 * `now` is an argument rather than a call to the clock, so that the tests
 * assert on something that does not change between one run and the next, and
 * so that a screen frozen mid-animation can render a stable string.
 */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 45) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  const date = new Date(at);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()];
  return `${date.getDate()} ${month}`;
}

/** `Today 1:42 PM`, for the vault's last session line. */
export function sessionTime(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  let hours = date.getHours();
  const meridiem = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 === 0 ? 12 : hours % 12;
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const clock = `${hours}:${minutes} ${meridiem}`;
  if (sameDay) return `Today ${clock}`;
  const yesterday = (now - at) / 86_400_000 < 2;
  return yesterday ? `Yesterday ${clock}` : `${relativeTime(at, now)} ${clock}`;
}

// ------------------------------------------------------------------ hex, ids

/** `8f91…d82a`. Middle-elided, never one-sided: an address truncated only at
 *  the end is exactly what an attacker who can grind a prefix wants. */
export function elide(text: string, head = 6, tail = 6): string {
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** Addresses are read in groups of four, by people, out loud, against another
 *  screen. That is the only way the destination check works, so the wallet
 *  formats for it wherever an address is shown in full. */
export function inGroups(text: string, size = 4): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
