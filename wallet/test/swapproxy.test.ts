/**
 * The proxy transport, and the promise it is careful not to make.
 */

import { describe, expect, it } from 'vitest';
import { proxyTransport, SWAP_PROXY } from '../src/net/swapproxy';

const reply = (body: unknown, ok = true) =>
  (async () => ({ json: async () => (ok ? { ok: true, upstream: body } : body) }) as unknown as Response) as unknown as typeof fetch;

describe('the swap proxy transport', () => {
  it('hands back exactly what the exchange said', async () => {
    /* Unwrapped to the upstream body, so every parser in core/swap.ts works
     * unchanged whether the answer came through the proxy or not. */
    const upstream = { toAmount: 7.5, minAmount: 0.1, withdrawMin: 3.2 };
    const t = proxyTransport(SWAP_PROXY, reply(upstream));
    expect(await t.quote({ provider: 'exolix', from: 'btc', to: 'xmr', amount: 1 })).toEqual(upstream);
  });

  it('carries the intent, never a URL', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const doFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return { json: async () => ({ ok: true, upstream: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const t = proxyTransport('https://proxy.test', doFetch);
    await t.create({
      provider: 'godex',
      from: 'xmr',
      to: 'usdc-base',
      amount: 2,
      payoutAddress: '0x' + 'a'.repeat(40),
      refundAddress: '4' + 'A'.repeat(94),
    });
    expect(seen[0]!.url).toBe('https://proxy.test/v1/create');
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body).toMatchObject({ provider: 'godex', from: 'xmr', to: 'usdc-base', amount: 2 });
    /* No URL anywhere in what was sent: the proxy builds the upstream call
     * itself, which is what stops it being an open relay. */
    expect(JSON.stringify(body)).not.toMatch(/https?:\/\//);
  });

  it('refuses to be used as a plain URL transport', async () => {
    /* A caller that has not been moved over says so loudly rather than
     * silently talking to the exchange directly, which would undo the reason
     * the proxy exists. */
    const t = proxyTransport('https://proxy.test', reply({}));
    await expect(t.send({ method: 'GET', url: 'https://exolix.com/api/v2/rate' })).rejects.toThrow(/intent, not a URL/);
  });

  it('turns a refusal into a sentence rather than a silent empty answer', async () => {
    const t = proxyTransport('https://proxy.test', reply({ ok: false, problem: 'Unknown coin.' }, false));
    await expect(t.quote({ provider: 'exolix', from: 'doge', to: 'xmr', amount: 1 })).rejects.toThrow(/Unknown coin/);
  });

  it('escapes what it puts in the status query', async () => {
    const seen: string[] = [];
    const doFetch = (async (url: string) => {
      seen.push(url);
      return { json: async () => ({ ok: true, upstream: {} }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const t = proxyTransport('https://proxy.test', doFetch);
    await t.status('exolix', 'ord/../../etc&x=1');
    expect(seen[0]).toContain('id=ord%2F..%2F..%2Fetc%26x%3D1');
  });
});
