/**
 * Which node traffic goes through the relay, and the case where it must not.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SUGGESTIONS } from '../src/core/nodes';
import type { NodeConfig } from '../src/core/nodes';
import { RELAYED_HOSTS, routeFor, routeLine, routedTransport } from '../src/net/nodeproxy';
import type { Reply, Transport } from '../src/net/http';

const node = (url: string, mine = false): NodeConfig => ({ kind: 'esplora', url, label: 'n', mine });

const nowhere: Transport = {
  base: 'https://direct.example',
  async send(): Promise<Reply> {
    return { ok: true, status: 200, text: 'direct' };
  },
};

describe('the three cases', () => {
  it('relays a suggested public node', () => {
    for (const suggestion of SUGGESTIONS) {
      const route = routeFor(node(suggestion.url));
      expect(route.via, suggestion.url).toBe('proxy');
    }
  });

  it('never relays a node somebody says is theirs', () => {
    /* The rule that matters most. Their own machine, on their own network,
     * already reached over a path they trust; putting us in the middle takes
     * a private arrangement and hands it to a stranger. Theirs wins even for
     * a host that is on the relay list, because a person can run their own
     * copy of one. */
    for (const url of ['http://192.168.1.20:3002', 'https://mempool.space/api', 'http://localhost:18081']) {
      const route = routeFor(node(url, true));
      expect(route.via, url).toBe('direct');
      expect(route.via === 'direct' && route.because).toBe('yours');
    }
  });

  it('does not relay a node that is neither theirs nor suggested', () => {
    /* Not because it would be wrong to, but because the relay refuses to be
     * an open one, so pretending here would only fail later. */
    const route = routeFor(node('https://someone-elses-esplora.example/api'));
    expect(route.via).toBe('direct');
    expect(route.via === 'direct' && route.because).toBe('not relayed');
  });

  it('treats an unreadable URL as direct rather than throwing', () => {
    expect(routeFor(node('not a url')).via).toBe('direct');
  });

  it('says which case is in force, in a sentence', () => {
    expect(routeLine(node('https://mempool.space/api'))).toMatch(/relay/i);
    expect(routeLine(node('https://mempool.space/api', true))).toMatch(/your own machine/i);
    expect(routeLine(node('https://other.example'))).toMatch(/not one of them/i);
  });
});

describe('the host lists do not drift apart', () => {
  it('relays exactly the hosts this app suggests', () => {
    /* Three lists have to agree: the app's suggestions, this module, and
     * PUBLIC_NODES in the Worker. Drift is silent, a new suggestion would
     * simply stop being relayed and nobody would notice, so it is a test. */
    const suggested = [...new Set(SUGGESTIONS.map((s) => new URL(s.url).hostname))].sort();
    expect([...RELAYED_HOSTS].sort()).toEqual(suggested);
  });

  it('matches the Worker table', () => {
    const worker = readFileSync('../worker/src/nodes.ts', 'utf8');
    for (const host of RELAYED_HOSTS) {
      expect(worker, `the Worker does not relay ${host}`).toContain(`'${host}'`);
    }
  });
});

describe('the routed transport', () => {
  const captured = () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const doFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"height":1}' } as unknown as Response;
    }) as unknown as typeof fetch;
    return { seen, doFetch };
  };

  it('hands a direct transport straight back when nothing should be relayed', () => {
    const direct = routedTransport(node('https://mine.example', true), nowhere);
    expect(direct).toBe(nowhere);
  });

  it('sends the path to the relay, never a whole URL', async () => {
    const { seen, doFetch } = captured();
    const t = routedTransport(node('https://mempool.space/api'), nowhere, 'https://relay.test', doFetch);
    await t.send({ method: 'GET', path: '/address/bc1qexample/utxo' });
    expect(seen[0]!.url).toBe('https://relay.test/v1/node?host=mempool.space&path=%2Faddress%2Fbc1qexample%2Futxo');
  });

  it('sends a raw broadcast as the text it is', async () => {
    /* Esplora takes a raw transaction as text/plain. Retyped as JSON it
     * arrives quoted and the broadcast fails for a reason nobody looks for. */
    const { seen, doFetch } = captured();
    const t = routedTransport(node('https://mempool.space/api'), nowhere, 'https://relay.test', doFetch);
    await t.send({ method: 'POST', path: '/tx', body: '0200000001ab', contentType: 'text/plain' });
    expect((seen[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('text/plain');
    expect(seen[0]!.init.body).toBe('0200000001ab');
  });

  it('keeps the transport contract: nothing throws across it', async () => {
    const doFetch = (async () => {
      throw new Error('the relay is down');
    }) as unknown as typeof fetch;
    const t = routedTransport(node('https://mempool.space/api'), nowhere, 'https://relay.test', doFetch);
    const reply = await t.send({ method: 'GET', path: '/blocks/tip/height' });
    expect(reply.ok).toBe(false);
    expect(reply.ok === false && reply.problem).toMatch(/relay is down/);
  });
});
