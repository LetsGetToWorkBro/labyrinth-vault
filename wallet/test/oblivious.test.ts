/**
 * The oblivious client, and the one mistake it must not be allowed to make.
 *
 * The protocol itself is checked against RFC 9458 in `ohttp.test.ts`, and the
 * end-to-end path through the real gateway is checked in the Worker's suite.
 * What is left, and what this file is for, is the configuration: a relay that
 * turned out to be us would satisfy every type, pass every crypto test, and
 * deliver none of the privacy the protocol exists for.
 */

import { describe, expect, it } from 'vitest';
import { RELAYS, obliviousFetch, posture, postureLine, type Relay } from '../src/net/oblivious';
import { SWAP_PROXY } from '../src/net/swapproxy';

describe('who carries the traffic', () => {
  it('lists no relay until one is agreed, rather than pointing at ourselves', () => {
    /* Empty is the honest state. The app says which arrangement is really in
     * force, and an entry here would change that sentence into a claim. */
    expect(RELAYS).toEqual([]);
  });

  it('would never accept a relay on our own host', () => {
    /* The failure this guards is the subtle one: everything works, every
     * vector passes, and both halves of the secret sit inside one company.
     * A relay must be a different operator on different infrastructure. */
    /* Both may be unset at once: no relay agreed, no gateway deployed. The
     * guard still has to hold the moment either is filled in. */
    const ours = SWAP_PROXY.trim() ? new URL(SWAP_PROXY).hostname : null;
    if (!ours) {
      expect(RELAYS).toEqual([]);
      return;
    }
    for (const relay of RELAYS) {
      expect(new URL(relay.url).hostname).not.toBe(ours);
      expect(new URL(relay.keysUrl).hostname).not.toBe(ours);
    }
  });

  it('says which arrangement is in force rather than the better one', () => {
    expect(posture([])).toBe('relayed');
    expect(posture([{ operator: 'someone', url: 'https://r.example/f', keysUrl: 'https://r.example/k' }])).toBe(
      'oblivious',
    );
    expect(postureLine('oblivious')).toContain('cannot read');
    expect(postureLine('relayed')).toContain('we keep no record');
    expect(postureLine('direct')).toContain('sees your address');
  });
});

describe('what the client sends and asks for', () => {
  const relay: Relay = {
    operator: 'a stand-in',
    url: 'https://relay.example/forward',
    keysUrl: 'https://relay.example/keys',
  };

  const keyList = (): Uint8Array => {
    const config =
      '01002031e1f05a740102115220e9af918f738674aec95f54db6e04eb705aae8e79815500040001 0001'.replace(/\s/g, '');
    const bytes = Uint8Array.from(config.match(/../g)!.map((b) => parseInt(b, 16)));
    const out = new Uint8Array(2 + bytes.length);
    out[0] = bytes.length >> 8;
    out[1] = bytes.length & 0xff;
    out.set(bytes, 2);
    return out;
  };

  const stub = () => {
    const calls: { url: string; contentType: string | null }[] = [];
    const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input as RequestInfo, init);
      calls.push({ url: request.url, contentType: request.headers.get('Content-Type') });
      if (request.url === relay.keysUrl) {
        return new Response(keyList() as BodyInit, { headers: { 'Content-Type': 'application/ohttp-keys' } });
      }
      /* An answer that will not open, which is fine: what is under test here
       * is what left the device, not what came back. */
      return new Response(new Uint8Array(64) as BodyInit, { headers: { 'Content-Type': 'message/ohttp-res' } });
    }) as typeof fetch;
    return { calls, doFetch };
  };

  it('asks the relay for the gateway keys, never the gateway', async () => {
    /* Fetching the configuration straight from the gateway would hand it the
     * address the whole arrangement exists to keep from it, once per client,
     * which is enough. */
    const { calls, doFetch } = stub();
    await obliviousFetch(relay, { doFetch })('https://gateway.example/v1/health').catch(() => undefined);
    expect(calls[0]!.url).toBe(relay.keysUrl);
    expect(calls.every((call) => new URL(call.url).hostname === 'relay.example')).toBe(true);
  });

  it('posts to the relay as an encapsulated request', async () => {
    const { calls, doFetch } = stub();
    await obliviousFetch(relay, { doFetch })('https://gateway.example/v1/health').catch(() => undefined);
    const posted = calls.find((call) => call.url === relay.url);
    expect(posted?.contentType).toBe('message/ohttp-req');
  });

  it('reuses the key configuration instead of fetching one per request', async () => {
    /* Not only slower. A configuration fetched fresh for one client can be
     * served differently to that client, and a client alone in holding some
     * key is a client its traffic identifies. */
    const { calls, doFetch } = stub();
    const send = obliviousFetch(relay, { doFetch });
    for (let i = 0; i < 3; i++) await send('https://gateway.example/v1/health').catch(() => undefined);
    expect(calls.filter((call) => call.url === relay.keysUrl).length).toBe(1);
  });

  it('fetches again once the configuration is old enough', async () => {
    let clock = 0;
    const { calls, doFetch } = stub();
    const send = obliviousFetch(relay, { doFetch, now: () => clock, keyLifetimeMs: 1000 });
    await send('https://gateway.example/v1/health').catch(() => undefined);
    clock = 1001;
    await send('https://gateway.example/v1/health').catch(() => undefined);
    expect(calls.filter((call) => call.url === relay.keysUrl).length).toBe(2);
  });

  it('refuses to send at all if the relay cannot supply the keys', async () => {
    const doFetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
    await expect(obliviousFetch(relay, { doFetch })('https://gateway.example/v1/health')).rejects.toThrow(
      /could not supply/,
    );
  });
});
