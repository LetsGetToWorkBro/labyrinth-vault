/**
 * The oblivious door, driven end to end.
 *
 * The two halves of Oblivious HTTP are verified against RFC 9458's own
 * vectors in the wallet's suite; there is no point repeating that here. What
 * this file checks is the part no RFC covers: that the client in the wallet
 * and the gateway in this Worker, wired to the real router, actually carry a
 * request and an answer between them, and that the gateway refuses everything
 * it should without saying which refusal it made.
 *
 * The client is the real one from `wallet/src/net/oblivious.ts`, pointed at an
 * imaginary relay whose entire job is to hand the bytes to this Worker. That
 * is what a relay does, so the pretend one is a faithful stand-in, and using
 * the real client means a change to either side that broke the other would
 * fail here rather than in production.
 */

import { describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/index';
import { keyConfigsFor, parseKeys } from '../src/gateway';
import { obliviousFetch, REQUEST_MEDIA_TYPE, type Relay } from '../../wallet/src/net/oblivious';
import { encodeKeyList, sealRequest } from '../../wallet/src/net/ohttp/ohttp';
import { encodeRequest } from '../../wallet/src/net/ohttp/bhttp';

/** The gateway's key. Any 32 bytes will do; this one is from RFC 9458 A. */
const GATEWAY_SECRET = '3c168975674b2fa8e465970b79c8dcf09f1c741626480bd4c6162fc5b6a98e1a';

const env = (over: Partial<Env> = {}): Env => ({ OHTTP_KEYS: `1:${GATEWAY_SECRET}`, ...over });

const call = (url: string, init?: RequestInit): Promise<Response> =>
  worker.fetch(new Request(url, init), env());

/**
 * A relay that does nothing but forward, which is all a relay does.
 *
 * It deliberately drops every header except the content type, the way a real
 * one would, so that nothing about the client can ride along to the gateway
 * inside a header the test forgot about.
 */
interface Pretend extends Relay {
  seen: Uint8Array[];
  forward: typeof fetch;
}

function pretendRelay(gatewayEnv: Env = env()): Pretend {
  const seen: Uint8Array[] = [];
  const url = 'https://relay.example/forward';
  const keysUrl = 'https://relay.example/keys';
  const forward = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    if (request.url === keysUrl) {
      return worker.fetch(new Request('https://gateway.example/v1/ohttp-keys'), gatewayEnv);
    }
    const body = new Uint8Array(await request.arrayBuffer());
    seen.push(body);
    return worker.fetch(
      new Request('https://gateway.example/v1/gateway', {
        method: 'POST',
        headers: { 'Content-Type': request.headers.get('Content-Type') ?? '' },
        body,
      }),
      gatewayEnv,
    );
  };
  return { operator: 'somebody who is not us', url, keysUrl, seen, forward: forward as typeof fetch };
}

const through = (relay: Pretend): typeof fetch => obliviousFetch(relay, { doFetch: relay.forward });

/**
 * An encapsulated request built without the client, so a test can send the
 * gateway something no client of ours would.
 *
 * `obliviousFetch` composes the inner path out of a parsed URL, which means
 * every path it can produce is already well formed. Anything checking what
 * the gateway does with a malformed one has to write the plaintext itself,
 * which is also what an attacker holding the published key configuration
 * would do.
 */
function handSealed(over: Partial<Parameters<typeof encodeRequest>[0]>): Uint8Array {
  const config = keyConfigsFor(parseKeys(`1:${GATEWAY_SECRET}`))[0]!;
  return sealRequest(
    config,
    encodeRequest({
      method: 'GET',
      scheme: 'https',
      authority: 'gateway.example',
      path: '/v1/health',
      headers: [],
      body: new Uint8Array(),
      ...over,
    }),
  ).body;
}

describe('the gateway key configuration', () => {
  it('publishes the configured key in the format clients read', async () => {
    const response = await call('https://gateway.example/v1/ohttp-keys');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/ohttp-keys');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes]).toEqual([...encodeKeyList(keyConfigsFor(parseKeys(`1:${GATEWAY_SECRET}`)))]);
  });

  it('is cacheable, which is the privacy-preserving answer here', async () => {
    /* A configuration served fresh to each client can be served differently
     * to one of them, and a client alone in holding some key is a client its
     * traffic identifies. Everybody sharing widely cached bytes is the point. */
    const response = await call('https://gateway.example/v1/ohttp-keys');
    expect(response.headers.get('Cache-Control')).toMatch(/public/);
  });

  it('says the gateway is not configured rather than inventing a key', async () => {
    const response = await worker.fetch(new Request('https://gateway.example/v1/ohttp-keys'), {});
    expect(response.status).toBe(404);
  });

  it('refuses a key list it cannot parse rather than advertising the next one down', () => {
    /* Skipping a malformed entry would advertise a key clients are not using
     * and start refusing every request encrypted to the one they hold, which
     * is an outage that looks like a client bug. */
    expect(() => parseKeys('1:nonsense')).toThrow(/32 bytes of hex/);
    expect(() => parseKeys(`999:${GATEWAY_SECRET}`)).toThrow(/0 to 255/);
    expect(parseKeys(undefined)).toEqual([]);
    expect(parseKeys('  ')).toEqual([]);
  });

  it('accepts more than one key so a key can be retired after clients stop using it', () => {
    const keys = parseKeys(`2:${GATEWAY_SECRET},1:${'11'.repeat(32)}`);
    expect(keys.map((key) => key.keyId)).toEqual([2, 1]);
    /* The advertised one is the first. The other is still accepted below. */
    expect(keyConfigsFor(keys)[0]!.keyId).toBe(2);
  });
});

describe('a request that goes the whole way', () => {
  it('carries a quote from the wallet to the exchange and back, seeing no addresses', async () => {
    const relay = pretendRelay();
    let sawUpstream: string | null = null;
    const upstream = async (input: RequestInfo | URL): Promise<Response> => {
      sawUpstream = String(input);
      return new Response(JSON.stringify({ rate: '0.0234' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const original = globalThis.fetch;
    globalThis.fetch = upstream as typeof fetch;
    try {
      const answer = await through(relay)('https://gateway.example/v1/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'exolix', from: 'btc', to: 'xmr', amount: 1 }),
      });
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({ ok: true, upstream: { rate: '0.0234' } });
      expect(sawUpstream).toContain('exolix.com');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('shows the relay nothing but ciphertext', async () => {
    const relay = pretendRelay();
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{}', { headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    try {
      await through(relay)('https://gateway.example/v1/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'exolix', from: 'btc', to: 'xmr', amount: 1, payoutAddress: 'bc1qtest' }),
      });
    } finally {
      globalThis.fetch = original;
    }
    /* What the relay held, searched for anything a person could be found by.
     * This is the claim the whole design is for, so it is checked against the
     * bytes rather than argued from the diagram. */
    const carried = new TextDecoder().decode(relay.seen[0]!);
    for (const secret of ['exolix', 'btc', 'xmr', 'bc1qtest', 'provider', 'quote']) {
      expect(carried, `the relay could read ${secret}`).not.toContain(secret);
    }
  });

  it('carries a chain node call the same way', async () => {
    const relay = pretendRelay();
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('402000', { status: 200, headers: { 'Content-Type': 'text/plain' } })) as typeof fetch;
    try {
      const answer = await through(relay)(
        'https://gateway.example/v1/node?host=mempool.space&path=/api/blocks/tip/height',
      );
      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe('402000');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('hides the inner status behind a plain 200 on the outside', async () => {
    /* Whether a request 404ed is part of what the relay is not meant to
     * learn. A gateway that answered 404 in the clear would be describing
     * the traffic it exists to hide. */
    const relay = pretendRelay();
    const answer = await through(relay)('https://gateway.example/v1/nowhere');
    expect(answer.status).toBe(404);
    const outer = await worker.fetch(
      new Request('https://gateway.example/v1/gateway', {
        method: 'POST',
        headers: { 'Content-Type': 'message/ohttp-req' },
        body: relay.seen[0]!,
      }),
      env(),
    );
    expect(outer.status).toBe(200);
    expect(outer.headers.get('Content-Type')).toBe('message/ohttp-res');
  });
});
describe('counting what can be counted without knowing whose it is', () => {
  /* Per-person limiting is genuinely gone on this path: every caller wears
   * the relay's address. The route, though, is visible to the gateway without
   * the caller being visible, and creating an order is the one route that
   * writes something durable at a stranger under our affiliate key. */
  const counters = (): KVNamespace => {
    const held = new Map<string, string>();
    return {
      get: async (key: string) => held.get(key) ?? null,
      put: async (key: string, value: string) => void held.set(key, value),
    } as unknown as KVNamespace;
  };

  const limited = (over: Partial<Env> = {}): Env =>
    env({ SWAP_LIMIT: counters(), RATE_LIMIT_SECRET: 'a secret that is not the address', ...over });

  const orderBody = JSON.stringify({
    provider: 'exolix',
    from: 'btc',
    to: 'xmr',
    amount: 1,
    payoutAddress: 'a',
    refundAddress: 'b',
  });

  const post = (send: typeof fetch, path: string, body: string): Promise<Response> =>
    send(`https://gateway.example${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

  const withUpstream = async <T>(run: () => Promise<T>): Promise<T> => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{}', { headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  it('holds orders to a ceiling well under the relay own general limit', async () => {
    const relay = pretendRelay(limited({ OHTTP_CREATE_LIMIT_PER_MINUTE: '2' }));
    const send = through(relay);
    await withUpstream(async () => {
      expect((await post(send, '/v1/create', orderBody)).status).toBe(200);
      expect((await post(send, '/v1/create', orderBody)).status).toBe(200);
      expect((await post(send, '/v1/create', orderBody)).status).toBe(429);
    });
  });

  it('refuses inside the envelope, so the relay cannot tell an order from a quote', async () => {
    /* A 429 in the clear would tell the relay that this particular request
     * was an order, which is exactly what it is not supposed to learn. */
    const gatewayEnv = limited({ OHTTP_CREATE_LIMIT_PER_MINUTE: '1' });
    const relay = pretendRelay(gatewayEnv);
    const send = through(relay);
    await withUpstream(async () => {
      await post(send, '/v1/create', orderBody);
      expect((await post(send, '/v1/create', orderBody)).status).toBe(429);
    });

    const outer = await worker.fetch(
      new Request('https://gateway.example/v1/gateway', {
        method: 'POST',
        headers: { 'Content-Type': 'message/ohttp-req' },
        body: relay.seen[1]!,
      }),
      gatewayEnv,
    );
    expect(outer.status).toBe(200);
    expect(outer.headers.get('Content-Type')).toBe('message/ohttp-res');
  });

  it('leaves quotes under the general limit rather than the order one', async () => {
    /* Cheap and idempotent. Giving them the order ceiling would turn a
     * person comparing two exchanges into an abuser. */
    const relay = pretendRelay(limited({ OHTTP_CREATE_LIMIT_PER_MINUTE: '1' }));
    const send = through(relay);
    await withUpstream(async () => {
      const quote = JSON.stringify({ provider: 'exolix', from: 'btc', to: 'xmr', amount: 1 });
      for (let i = 0; i < 4; i++) {
        expect((await post(send, '/v1/quote', quote)).status, `quote ${i + 1}`).toBe(200);
      }
    });
  });
});

describe('what the gateway refuses', () => {
  const post = (body: BodyInit, contentType = 'message/ohttp-req'): Promise<Response> =>
    call('https://gateway.example/v1/gateway', { method: 'POST', headers: { 'Content-Type': contentType }, body });

  it('refuses everything unreadable the same way, with no body', async () => {
    /* One shape for every failure. Telling "no such key id" apart from "that
     * did not decrypt" would answer questions about which keys exist for
     * anybody willing to ask. */
    const shapes = [
      new Uint8Array(0),
      new Uint8Array([9, 0, 0x20, 0, 1, 0, 1, ...new Uint8Array(40)]),
      new Uint8Array([1, 0, 0x20, 0, 1, 0, 1, ...new Uint8Array(40)]),
      new Uint8Array([1, 0, 0x20, 0, 1, 0, 1]),
    ];
    for (const shape of shapes) {
      const response = await post(shape);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('');
    }
  });

  it('refuses a body that is not claimed to be an encapsulated request', async () => {
    expect((await post(new Uint8Array([1]), 'application/json')).status).toBe(415);
  });

  it('refuses methods other than POST', async () => {
    expect((await call('https://gateway.example/v1/gateway')).status).toBe(405);
  });

  it('says nothing at all when no gateway key is configured', async () => {
    const response = await worker.fetch(
      new Request('https://gateway.example/v1/gateway', {
        method: 'POST',
        headers: { 'Content-Type': 'message/ohttp-req' },
        body: new Uint8Array([1, 2, 3]),
      }),
      {},
    );
    expect(response.status).toBe(404);
  });

  it('will not serve the gateway or the key list from inside itself', async () => {
    /* A route that can be pointed at itself is a route somebody eventually
     * points at itself a few thousand times. */
    const relay = pretendRelay();
    for (const path of ['/v1/gateway', '/v1/ohttp-keys']) {
      const answer = await through(relay)(`https://gateway.example${path}`, { method: 'POST' });
      expect(answer.status, path).toBe(404);
    }
  });

  it('does not trust the authority inside the encapsulated request', async () => {
    /* The plaintext was written by whoever sent it, and the relay in front is
     * not a party this design trusts either. Only the path is used, against
     * this Worker's own origin. */
    const relay = pretendRelay();
    let dialed: string | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      dialed = String(input);
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const answer = await through(relay)('https://somewhere-else.example/v1/health');
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({ ok: true });
      expect(dialed).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('refuses a plaintext whose path is not a path', async () => {
    /* The test above cannot reach this branch and it is worth saying why. It
     * drives the real client, and the real client always writes
     * `pathname + search`, so no authority it could be handed ever survives
     * into the field the gateway reads. Everything hostile therefore has to
     * be built by hand here, because the attacker is not a client of ours.
     *
     * The shape being refused is the one `new URL(path, origin)` gets wrong:
     * an absolute or protocol-relative first argument makes the parser throw
     * the base away, so the origin the gateway believes it pinned is the one
     * the sender chose. */
    for (const path of [
      'https://evil.example/v1/quote',
      '//evil.example/v1/quote',
      '/\\evil.example/v1/quote',
      'v1/quote',
    ]) {
      const answer = await call('https://gateway.example/v1/gateway', {
        method: 'POST',
        headers: { 'Content-Type': REQUEST_MEDIA_TYPE },
        body: handSealed({ path }),
      });
      /* Flat, bodyless, and the same shape as every other gateway refusal:
       * telling a prober which of its tricks was recognized is telling it
       * which one to try next. */
      expect(answer.status, path).toBe(400);
      expect(await answer.text(), path).toBe('');
    }
  });

  it('still carries an ordinary hand-built path, so the refusal is not refusing everything', async () => {
    /* Without this the test above passes just as well against a gateway that
     * threw on every encapsulated request, which would be a guard reporting
     * on its own fixture rather than on the check. */
    const answer = await call('https://gateway.example/v1/gateway', {
      method: 'POST',
      headers: { 'Content-Type': REQUEST_MEDIA_TYPE },
      body: handSealed({ path: '/v1/health' }),
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('Content-Type')).toBe('message/ohttp-res');
  });
});

describe('the ceiling is in the code, not in the platform', () => {
  /* Cloudflare refuses an oversized request before this Worker runs, so there
   * was never a hole here. What there was is a limit nobody could check by
   * reading the source, and one that would not survive being deployed
   * somewhere with a different platform ceiling. Every parser on the vault
   * side carries its own; this is the Worker keeping the same standard. */

  const MB = 1_048_576;

  it('refuses an encapsulated request over a megabyte, before decrypting it', async () => {
    /* Deliberately valid-looking: the right key id and a real header, so the
     * only reason to refuse is the size. If the check sat after the
     * decryption it would have done the expensive thing first. */
    const oversized = new Uint8Array(MB + 1);
    oversized.set([1, 0, 0x20, 0, 1, 0, 1], 0);
    const response = await call('https://gateway.example/v1/gateway', {
      method: 'POST',
      headers: { 'Content-Type': 'message/ohttp-req' },
      body: oversized,
    });
    expect(response.status).toBe(413);
    expect(await response.text()).toBe('');
  });

  it('refuses on a declared length without reading the body at all', async () => {
    /* The cheap check. A caller that announces the size gets refused before a
     * byte is read; a chunked one is caught by the measurement afterwards. */
    const response = await call('https://gateway.example/v1/gateway', {
      method: 'POST',
      headers: { 'Content-Type': 'message/ohttp-req', 'Content-Length': String(MB + 1) },
      body: new Uint8Array([1, 0, 0x20, 0, 1, 0, 1]),
    });
    expect(response.status).toBe(413);
  });

  it('still carries an ordinary request, so the limit is invisible to anybody real', async () => {
    const relay = pretendRelay();
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{}', { headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    try {
      const answer = await through(relay)('https://gateway.example/v1/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'exolix', from: 'btc', to: 'xmr', amount: 1 }),
      });
      expect(answer.status).toBe(200);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('refuses to relay an oversized broadcast to a public node', async () => {
    /* The other door, which the audit did not name and which read a body the
     * same unbounded way. A node should never receive something this Worker
     * would not have accepted for itself. */
    const original = globalThis.fetch;
    let dialed = false;
    globalThis.fetch = (async () => {
      dialed = true;
      return new Response('ok');
    }) as typeof fetch;
    try {
      const response = await call(
        'https://gateway.example/v1/node?host=mempool.space&path=/api/tx',
        { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'a'.repeat(MB + 1) },
      );
      expect(response.status).toBe(413);
      expect(dialed, 'the node was dialed anyway').toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('relays a broadcast of the size a real transaction actually is', async () => {
    /* Bitcoin standardness caps a transaction at 100,000 bytes, so 200,000
     * characters of hex is the worst honest case. It must pass. */
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('txid', { status: 200 })) as typeof fetch;
    try {
      const response = await call(
        'https://gateway.example/v1/node?host=mempool.space&path=/api/tx',
        { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'ab'.repeat(100_000) },
      );
      expect(response.status).toBe(200);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('refuses an oversized intent on the two swap routes as well', async () => {
    /* The third route found by this method. `/v1/gateway` was capped after
     * one audit and `/v1/node` after another, each named on its own, and the
     * pattern of naming them one at a time is what left these two open: they
     * read and parsed in a single `request.json()`, so there was never a
     * moment where the bytes existed and a size could be asked about. */
    const original = globalThis.fetch;
    let dialed = false;
    globalThis.fetch = (async () => {
      dialed = true;
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      for (const route of ['/v1/quote', '/v1/create']) {
        /* Valid in every respect but its size, so the only thing that can
         * refuse it is the ceiling. A padded field rather than padded
         * whitespace, because a parser that stripped whitespace would make
         * this pass for the wrong reason. */
        const oversized = JSON.stringify({
          provider: 'exolix',
          from: 'btc',
          to: 'xmr',
          amount: 1,
          payoutAddress: 'a'.repeat(MB + 1),
        });
        const response = await call(`https://gateway.example${route}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: oversized,
        });
        expect(response.status, route).toBe(413);
        expect(dialed, `${route} dialed the exchange anyway`).toBe(false);
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reads a body in exactly one place, so a new route cannot forget the ceiling', async () => {
    /* The behavioral tests above cover the routes that exist today. This one
     * covers the route somebody adds next. `serve` reads the body once, above
     * the routing, and hands the string down; a route that reached for
     * `request.json()` or a second `request.text()` would have gone around
     * the measurement, and that is the only way this can go wrong again. */
    const { readFileSync } = await import('node:fs');
    const code = readFileSync('src/index.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code, 'a route parses a body without measuring it first').not.toMatch(/request\.json\s*\(/);
    expect(code.match(/request\.text\s*\(/g) ?? []).toHaveLength(1);
  });
});
