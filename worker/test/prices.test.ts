/**
 * One price, fetched once, served to everybody.
 *
 * The properties worth holding, in the order somebody would be hurt by their
 * absence: the upstream is the pinned host and nothing else; the wire carries
 * integer cents and never a float; a cached answer serves everyone inside the
 * window, so the upstream sees a timer rather than a user base; a broken or
 * absurd upstream answer is a refusal rather than a broken number under
 * everybody's balance at once; and a failed fetch with a live cache serves
 * the cache, because a minute-old price is the price everybody else is
 * seeing.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { PRICE_CACHE_MS, PRICE_HOST, currentPrices, forgetPrices } from '../src/prices';

const answer = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

const GOOD = { bitcoin: { usd: 117_880.126 }, monero: { usd: 265.8 } };

function fetcher(
  body: unknown = GOOD,
  status = 200,
): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return answer(body, status);
    }) as typeof fetch,
  };
}

beforeEach(() => forgetPrices());

describe('the price answer', () => {
  it('asks the pinned host and nothing else', async () => {
    const upstream = fetcher();
    await currentPrices(1_000_000, upstream.fetch);
    expect(upstream.calls).toHaveLength(1);
    expect(new URL(upstream.calls[0]!).hostname).toBe(PRICE_HOST);
  });

  it('serves integer cents, rounded once, never a float', async () => {
    const upstream = fetcher();
    const result = await currentPrices(1_000_000, upstream.fetch);
    expect(result).toEqual({ ok: true, prices: { BTC: 11_788_013, XMR: 26_580 } });
  });

  it('serves everybody from one fetch inside the window', async () => {
    const upstream = fetcher();
    await currentPrices(1_000_000, upstream.fetch);
    await currentPrices(1_000_000 + PRICE_CACHE_MS - 1, upstream.fetch);
    await currentPrices(1_000_000 + PRICE_CACHE_MS - 1, upstream.fetch);
    expect(upstream.calls).toHaveLength(1);
    await currentPrices(1_000_000 + PRICE_CACHE_MS, upstream.fetch);
    expect(upstream.calls).toHaveLength(2);
  });

  it('refuses a missing coin rather than serving half an answer', async () => {
    /* One real price and one absent one would let a total claim the missing
     * coin is worthless, which is the misstatement the wallet's own rendering
     * exists to refuse. */
    const upstream = fetcher({ bitcoin: { usd: 117_880 } });
    const result = await currentPrices(1_000_000, upstream.fetch);
    expect(result.ok).toBe(false);
  });

  it('refuses nonsense: zero, negative, infinite, absurd, or not a number', async () => {
    for (const usd of [0, -5, Number.POSITIVE_INFINITY, Number.NaN, 'a lot', 2_000_000_000]) {
      forgetPrices();
      const upstream = fetcher({ bitcoin: { usd }, monero: { usd: 265.8 } });
      const result = await currentPrices(1_000_000, upstream.fetch);
      expect(result.ok, `usd=${String(usd)} should refuse`).toBe(false);
    }
  });

  it('serves the cache when the upstream fails, and refuses when there is none', async () => {
    const good = fetcher();
    await currentPrices(1_000_000, good.fetch);
    const bad = fetcher({}, 500);
    const stale = await currentPrices(1_000_000 + PRICE_CACHE_MS + 1, bad.fetch);
    expect(stale).toEqual({ ok: true, prices: { BTC: 11_788_013, XMR: 26_580 } });

    forgetPrices();
    const cold = await currentPrices(1_000_000, bad.fetch);
    expect(cold.ok).toBe(false);
  });
});
