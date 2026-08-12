/**
 * The price of a coin, fetched once and served to everybody.
 *
 * The wallet deliberately has no price feed of its own: a phone asking a
 * price service "what is bitcoin worth" tells that service an IP address is
 * running a wallet, at that moment, every refresh. That is the same shape of
 * leak the swap had, and it gets the same answer. This Worker asks instead,
 * and every client receives the identical cached answer, so the upstream sees
 * one server asking on a timer and never a person.
 *
 * The cache is the privacy feature, not an optimization, the same argument as
 * the OHTTP key configuration: an answer served fresh per client is an answer
 * that could be served differently per client, and identical widely-cached
 * bytes are what make one caller indistinguishable from the rest. Sixty
 * seconds is fresh enough for a number the app renders as a convenience under
 * the real amounts, and long enough that the upstream sees a handful of
 * requests a minute from the whole user base.
 *
 * One upstream, pinned by hostname the way `upstream.ts` pins the exchanges.
 * CoinGecko's simple-price endpoint is keyless and answers both coins in one
 * request; a missing or unparseable answer is a refusal, never a stale number
 * dressed as a fresh one, because the app renders coin amounts when no price
 * is known and that fallback is the honest one.
 *
 * Values cross the wire as integer cents per whole coin, which is the unit
 * the wallet's `fiatCents` arithmetic takes. The float leaves this file and
 * nothing downstream ever does float math on money.
 */

/** The one host this module will ever ask. */
export const PRICE_HOST = 'api.coingecko.com';

const PRICE_URL =
  `https://${PRICE_HOST}/api/v3/simple/price?ids=bitcoin,monero&vs_currencies=usd`;

/** How long one answer serves everybody, in milliseconds. */
export const PRICE_CACHE_MS = 60_000;

export interface Prices {
  /** Integer cents per whole coin. */
  BTC: number;
  XMR: number;
}

export type PriceResult = { ok: true; prices: Prices } | { ok: false; problem: string };

/** A finite positive dollar figure as integer cents, or null. The ceiling is
 *  a sanity bound, not a forecast: a parse that produces more than a hundred
 *  million dollars a coin is a broken upstream, and serving it would put a
 *  broken number under everybody's balance at once. */
function cents(usd: unknown): number | null {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
  const value = Math.round(usd * 100);
  return value > 0 && value <= 100_000_000_00 ? value : null;
}

interface Cached {
  at: number;
  prices: Prices;
}

let cached: Cached | null = null;

/** For tests, which need one isolate to forget between cases. */
export function forgetPrices(): void {
  cached = null;
}

/**
 * The current prices, from the cache or the upstream.
 *
 * A failed fetch with a live cache serves the cache: a number sixty seconds
 * old is still the number everybody else is seeing. A failed fetch with no
 * cache is a refusal, and the app shows coin amounts, which is what it does
 * whenever no price is known.
 */
export async function currentPrices(
  now: number = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<PriceResult> {
  if (cached && now - cached.at < PRICE_CACHE_MS) return { ok: true, prices: cached.prices };

  let body: unknown;
  try {
    const answer = await fetcher(PRICE_URL, {
      headers: { Accept: 'application/json' },
    });
    if (!answer.ok) throw new Error(`the price source answered ${answer.status}`);
    body = await answer.json();
  } catch (error) {
    if (cached) return { ok: true, prices: cached.prices };
    return { ok: false, problem: `No price is available (${(error as Error)?.message ?? 'no answer'}).` };
  }

  const raw = (body ?? {}) as Record<string, Record<string, unknown>>;
  const btc = cents(raw['bitcoin']?.['usd']);
  const xmr = cents(raw['monero']?.['usd']);
  if (btc === null || xmr === null) {
    /* Both or neither. A total computed from one real price and one absent
     * one would claim the missing coin is worthless, which is the exact
     * misstatement the wallet's own rendering refuses. */
    if (cached) return { ok: true, prices: cached.prices };
    return { ok: false, problem: 'The price source answered in a shape this Worker does not read.' };
  }

  cached = { at: now, prices: { BTC: btc, XMR: xmr } };
  return { ok: true, prices: cached.prices };
}
