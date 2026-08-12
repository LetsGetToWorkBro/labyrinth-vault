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
import { obliviousFetch, type Relay } from '../../wallet/src/net/oblivious';
import { encodeKeyList } from '../../wallet/src/net/ohttp/ohttp';

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
    let dialled: string | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      dialled = String(input);
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const answer = await through(relay)('https://somewhere-else.example/v1/health');
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({ ok: true });
      expect(dialled).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });
});
