/**
 * Reading a price from Labyrinth's relay, and only from there.
 *
 * The wallet asks no price service directly, ever. A phone that asks "what is
 * bitcoin worth" tells whoever answers that an IP address is running a wallet,
 * at that moment, on every refresh; that is the leak the relay exists to
 * close. The relay asks the price source itself, on a timer, and serves one
 * cached answer to every client, so the source sees a server and the relay
 * learns nothing it did not already know from being the relay.
 *
 * The wire is integer cents per whole coin, the unit `fiatCents` takes, and
 * this client validates rather than trusts: the relay is ours, and it is still
 * a network answer. Anything malformed, non-integer, non-positive or absurd is
 * a refusal, and a refusal means the app keeps rendering coin amounts, which
 * is what it does whenever no price is known. No screen changes shape on a
 * bad answer; it simply keeps telling the truth it can prove.
 */

import type { Asset } from '../core/model';
import { parseJson, type Transport } from './http';

export type PriceResult =
  | { ok: true; centsPerUnit: Record<Asset, number> }
  | { ok: false; problem: string };

/** A price this client will believe: a positive integer number of cents, and
 *  fewer of them than ten billion dollars a coin, which is not a market, it
 *  is a broken relay. */
function believable(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 100_000_000_00
  );
}

/** Ask the relay for the one cached answer it serves everybody. */
export async function fetchPrices(transport: Transport): Promise<PriceResult> {
  const reply = await transport.send({ method: 'GET', path: '/v1/price' });
  const parsed = parseJson<{ ok?: boolean; prices?: Record<string, unknown> }>(reply);
  if (!parsed.ok) return { ok: false, problem: parsed.problem };
  if (parsed.value.ok !== true || !parsed.value.prices) {
    return { ok: false, problem: 'The relay has no price right now.' };
  }
  const btc = parsed.value.prices['BTC'];
  const xmr = parsed.value.prices['XMR'];
  if (!believable(btc) || !believable(xmr)) {
    return { ok: false, problem: 'The relay answered with a price this wallet does not believe.' };
  }
  return { ok: true, centsPerUnit: { BTC: btc, XMR: xmr } };
}
