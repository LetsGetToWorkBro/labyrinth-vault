/**
 * What the proxy must do, and what it must never do.
 *
 * The second list is the one worth reading. This Worker's whole justification
 * is that an exchange never sees a user and that a record of the trade is not
 * kept here, and neither of those is the kind of promise that survives on
 * good intentions. The retention rules are enforced by walking this Worker's
 * own source, so a `console.log` added in a hurry fails the suite rather than
 * quietly becoming a log of who traded what.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { nodeTarget } from '../src/nodes';
import { bucketKey, checkLimit } from '../src/ratelimit';
import { ALLOWED_HOSTS, buildCreate, buildQuote, buildStatus, knownProvider, send } from '../src/upstream';

const sources = readdirSync('src')
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ name, text: readFileSync(`src/${name}`, 'utf8') }));

/** Comments are prose about the code, not the code. */
const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the Worker keeps nothing', () => {
  it('found its own source to check', () => {
    expect(sources.length).toBeGreaterThanOrEqual(3);
  });

  it('logs nothing, anywhere', () => {
    /* Not a style rule. Cloudflare retains what a Worker prints, so a single
     * console.log of a request body would turn "we store nothing" into a
     * false statement made in public. */
    for (const { name, text } of sources) {
      expect(codeOnly(text), `${name} writes to the console`).not.toMatch(/console\s*\./);
    }
  });

  it('has no database, queue, or analytics binding', () => {
    for (const { name, text } of sources) {
      const code = codeOnly(text);
      for (const forbidden of ['D1Database', 'prepare(', 'AnalyticsEngine', 'writeDataPoint', 'Queue']) {
        expect(code, `${name} reaches for ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('writes only to the rate limiter, and only counters', () => {
    /* One `put` in the whole Worker, in ratelimit.ts, and its value is a
     * number. Anything else writing to storage is a new place a trade could
     * come to rest. */
    const writers = sources.filter(({ text }) => /\.put\s*\(/.test(codeOnly(text)));
    expect(writers.map((w) => w.name)).toEqual(['ratelimit.ts']);
  });
});

describe('counting a caller without keeping them', () => {
  const SECRET = 'a secret that is not the address';

  it('never lets the address appear in the key', () => {
    const address = '203.0.113.42';
    return bucketKey(SECRET, address, 29_000_000).then((key) => {
      expect(key).not.toContain(address);
      expect(key).not.toContain('203');
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  it('gives the same caller the same bucket inside a window', async () => {
    const a = await bucketKey(SECRET, '203.0.113.42', 29_000_000);
    const b = await bucketKey(SECRET, '203.0.113.42', 29_000_000);
    expect(a).toBe(b);
  });

  it('gives the same caller a different bucket in the next window', async () => {
    /* The property that makes the counters unassemblable into a history:
     * one person's minutes do not link to each other. */
    const now = await bucketKey(SECRET, '203.0.113.42', 29_000_000);
    const next = await bucketKey(SECRET, '203.0.113.42', 29_000_001);
    expect(now).not.toBe(next);
  });

  it('separates two callers', async () => {
    const a = await bucketKey(SECRET, '203.0.113.42', 29_000_000);
    const b = await bucketKey(SECRET, '198.51.100.7', 29_000_000);
    expect(a).not.toBe(b);
  });

  it('is unguessable without the secret', async () => {
    /* A bare hash of an IPv4 address is reversible in seconds. The secret is
     * the whole reason the bucket is not the address wearing a costume. */
    const withSecret = await bucketKey(SECRET, '203.0.113.42', 29_000_000);
    const withOther = await bucketKey('a different secret', '203.0.113.42', 29_000_000);
    expect(withSecret).not.toBe(withOther);
  });

  it('counts, refuses past the limit, and stores nothing but a number', async () => {
    const written = new Map<string, string>();
    const store = {
      get: async (key: string) => written.get(key) ?? null,
      put: async (key: string, value: string) => void written.set(key, value),
    } as unknown as KVNamespace;

    const now = 1_740_000_000_000;
    for (let i = 0; i < 3; i++) {
      const result = await checkLimit(store, SECRET, '203.0.113.42', 3, now);
      expect(result.allowed, `request ${i + 1}`).toBe(true);
    }
    const refused = await checkLimit(store, SECRET, '203.0.113.42', 3, now);
    expect(refused.allowed).toBe(false);
    expect(refused.resetSeconds).toBeGreaterThan(0);

    /* The store, inspected: opaque keys, integer values, no address. */
    for (const [key, value] of written) {
      expect(key).toMatch(/^rl:[0-9a-f]{32}$/);
      expect(value).toMatch(/^\d+$/);
      expect(key).not.toContain('203.0.113');
    }
  });

  it('serves rather than fails when the counter is unavailable', async () => {
    const result = await checkLimit(undefined, SECRET, '203.0.113.42', 60, Date.now());
    expect(result.allowed).toBe(true);
  });
});

describe('it is not an open proxy', () => {
  it('speaks to exactly two hosts', () => {
    expect([...ALLOWED_HOSTS].sort()).toEqual(['api.godex.io', 'exolix.com']);
  });

  it('refuses a provider it does not know', () => {
    expect(knownProvider('exolix')).toBe('exolix');
    expect(knownProvider('godex')).toBe('godex');
    for (const bad of ['', 'changenow', 'EXOLIX', null, 42, {}]) {
      expect(knownProvider(bad as unknown), String(bad)).toBeNull();
    }
  });

  it('refuses a coin the catalog does not list', () => {
    const built = buildQuote({ provider: 'exolix', from: 'doge', to: 'xmr', amount: 1 });
    expect(built.ok).toBe(false);
  });

  it('refuses a swap that does not start from a coin the wallet holds', () => {
    /* The same rule the app enforces, enforced again here, because this
     * endpoint is reachable without the app. */
    const built = buildQuote({ provider: 'exolix', from: 'usdc-base', to: 'xmr', amount: 1 });
    expect(built.ok).toBe(false);
  });

  it('refuses an amount that is not one', () => {
    for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildQuote({ provider: 'exolix', from: 'btc', to: 'xmr', amount }).ok, String(amount)).toBe(false);
    }
  });

  it('refuses an order with no payout or refund address', () => {
    expect(buildCreate({ provider: 'exolix', from: 'btc', to: 'xmr', amount: 1 }).ok).toBe(false);
    expect(
      buildCreate({ provider: 'exolix', from: 'btc', to: 'xmr', amount: 1, payoutAddress: 'a' }).ok,
    ).toBe(false);
  });

  it('refuses an order id that is not one', () => {
    expect(buildStatus('exolix', '').ok).toBe(false);
    expect(buildStatus('exolix', 'x'.repeat(129)).ok).toBe(false);
    expect(buildStatus('exolix', 'ord_123').ok).toBe(true);
  });

  it('builds only allowlisted URLs', () => {
    const built = [
      buildQuote({ provider: 'exolix', from: 'btc', to: 'xmr', amount: 1 }),
      buildQuote({ provider: 'godex', from: 'btc', to: 'xmr', amount: 1 }),
      buildStatus('exolix', 'ord_1'),
      buildStatus('godex', 'ord_1'),
    ];
    for (const one of built) {
      expect(one.ok).toBe(true);
      if (one.ok) {
        expect([...ALLOWED_HOSTS]).toContain(new URL(one.request.url).hostname);
      }
    }
  });

  it('will not open a connection to anywhere else, even if asked', async () => {
    /* The last line of defence: the check sits immediately before the fetch,
     * so a URL that arrived some other way still cannot be dialled. */
    await expect(
      send({ method: 'GET', url: 'https://example.com/steal' }, 'exolix', {}, (async () => {
        throw new Error('should never be called');
      }) as unknown as typeof fetch),
    ).rejects.toThrow(/refusing to call example\.com/);
  });
});

describe('the keys stay here, and travel where each provider wants them', () => {
  const capture = () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return { status: 200, text: async () => JSON.stringify({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    return { seen, fetcher };
  };

  it('sends the Exolix key as api-key, on every call', async () => {
    const { seen, fetcher } = capture();
    const built = buildQuote({ provider: 'exolix', from: 'btc', to: 'xmr', amount: 1 });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    await send(built.request, 'exolix', { exolix: 'EXOLIX_SECRET' }, fetcher);
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers['api-key']).toBe('EXOLIX_SECRET');
  });

  it('sends the Godex token as public-key', async () => {
    const { seen, fetcher } = capture();
    const built = buildQuote({ provider: 'godex', from: 'btc', to: 'xmr', amount: 1 });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    await send(built.request, 'godex', { godexPublic: 'GODEX_TOKEN' }, fetcher);
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers['public-key']).toBe('GODEX_TOKEN');
  });

  it('adds the Godex affiliate id to the order, and to nothing else', async () => {
    const { seen, fetcher } = capture();
    const order = buildCreate({
      provider: 'godex',
      from: 'btc',
      to: 'xmr',
      amount: 1,
      payoutAddress: '4' + 'A'.repeat(94),
      refundAddress: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    });
    const quote = buildQuote({ provider: 'godex', from: 'btc', to: 'xmr', amount: 1 });
    expect(order.ok && quote.ok).toBe(true);
    if (!order.ok || !quote.ok) return;

    await send(order.request, 'godex', { godexAffiliate: 'AFF_1' }, fetcher);
    await send(quote.request, 'godex', { godexAffiliate: 'AFF_1' }, fetcher);

    expect(JSON.parse(String(seen[0]!.init.body))).toMatchObject({ affiliate_id: 'AFF_1' });
    /* A rate check carries no identifier, because it has no use for one. */
    expect(JSON.parse(String(seen[1]!.init.body))).not.toHaveProperty('affiliate_id');
  });

  it('sends no key at all when none is configured', async () => {
    const { seen, fetcher } = capture();
    const built = buildQuote({ provider: 'exolix', from: 'btc', to: 'xmr', amount: 1 });
    if (!built.ok) return;
    await send(built.request, 'exolix', {}, fetcher);
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers['api-key']).toBeUndefined();
    expect(headers['public-key']).toBeUndefined();
  });

  it('hands back what the exchange said, unread', async () => {
    /* The Worker does not parse orders and does not judge them. verifyOrder
     * runs in the wallet, against the request the wallet built, because the
     * wallet is the only party that knows what it asked for. */
    const upstream = { id: 'ord_9', depositAddress: 'bc1qsomething', coinTo: { network: 'ARBITRUM' } };
    const fetcher = (async () => ({ status: 200, text: async () => JSON.stringify(upstream) }) as unknown as Response) as unknown as typeof fetch;
    const built = buildStatus('exolix', 'ord_9');
    if (!built.ok) return;
    const answer = await send(built.request, 'exolix', {}, fetcher);
    expect(answer.body).toEqual(upstream);
  });

  it('passes on a reply that is not JSON rather than throwing', async () => {
    const fetcher = (async () => ({ status: 503, text: async () => '<html>down</html>' }) as unknown as Response) as unknown as typeof fetch;
    const built = buildStatus('godex', 'ord_9');
    if (!built.ok) return;
    const answer = await send(built.request, 'godex', {}, fetcher);
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ problem: expect.stringContaining('down') });
  });
});

describe('the chain node relay', () => {
  it('relays only to the nodes this app suggests', () => {
    for (const host of ['mempool.space', 'blockstream.info', 'xmr-node.cakewallet.com', 'node.monerodevs.org']) {
      expect(nodeTarget(host, '/blocks/tip/height').ok, host).toBe(true);
    }
  });

  it('refuses a host it was not given, however it is asked', () => {
    /* An open relay is a free anonymiser for whoever finds it. A node
     * somebody runs themselves is reached directly by the app and never
     * arrives here at all. */
    for (const host of ['evil.example', 'localhost', '127.0.0.1', '', 'mempool.space.evil.example']) {
      expect(nodeTarget(host, '/x').ok, host).toBe(false);
    }
  });

  it('will not be walked out of its own origin', () => {
    const escapes = [
      '/../../etc/passwd',
      '/..%2f..%2fadmin',
      '//evil.example/x',
      '/%2e%2e/%2e%2e/x',
      '\\evil',
      'no-leading-slash',
      'https://evil.example/x',
      '/x\\..\\y',
    ];
    for (const path of escapes) {
      const target = nodeTarget('mempool.space', path);
      if (target.ok) {
        /* If it was allowed at all, it must still be the same origin. */
        expect(new URL(target.url).origin, path).toBe('https://mempool.space');
      } else {
        expect(target.ok, path).toBe(false);
      }
    }
  });

  it('keeps the caller off the origin entirely', () => {
    const target = nodeTarget('mempool.space', '/address/bc1qexample/utxo');
    expect(target.ok).toBe(true);
    if (target.ok) {
      expect(target.url).toBe('https://mempool.space/api/address/bc1qexample/utxo');
    }
  });

  it('bounds the path', () => {
    expect(nodeTarget('mempool.space', '/' + 'a'.repeat(600)).ok).toBe(false);
  });
});
