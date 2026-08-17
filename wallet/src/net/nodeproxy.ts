/**
 * Whether a node request goes through the proxy, and the one case where it
 * must not.
 *
 * Asking a public Esplora server about your addresses tells that server your
 * whole Bitcoin wallet: every address, at once, from one IP. Broadcasting
 * from the phone puts the address that first announced a transaction next to
 * the transaction, on either chain. Both are worse than the swap leak, which
 * only ever exposed a single trade, so both get the same answer: route it
 * through the proxy and let the node see Cloudflare.
 *
 * ## The exception, which is the important part
 *
 * **A node somebody runs themselves is never proxied.** When a person points
 * this wallet at their own machine, the traffic already goes somewhere they
 * trust over a network they control. Putting Labyrinth in that path would
 * take a private arrangement and hand it to a stranger, which is not a
 * privacy feature, it is the opposite one wearing the same word. `mine` on
 * the node config is the person's own statement about whose machine it is,
 * and it wins here over every other consideration.
 *
 * ## And the other exception
 *
 * A custom node that is not one of the published suggestions is not proxied
 * either, because the proxy will not relay to arbitrary hosts. An open relay
 * is a free anonymizer for whoever finds it. Somebody who typed in a node
 * that is neither theirs nor on the list has made an arrangement with that
 * operator, and the honest thing is to connect to it directly and say so
 * rather than quietly reroute it.
 *
 * So there are exactly three cases, and the app can state which one is in
 * force at any time:
 *
 *   - a suggested public node, not marked as mine: **proxied**
 *   - a node marked as mine: **direct**, deliberately
 *   - anything else: **direct**, because the proxy would refuse it anyway
 *
 * ## None of it is switched on yet
 *
 * `routedTransport` below has no production caller. The watchers build their
 * transports with `live()` directly, so every address query and every
 * broadcast in the shipped app goes straight to the node the person chose.
 * That is what `privacyNote` tells them, so nobody is being misled today, and
 * saying it here is about the day after: going live is one string,
 * `SWAP_PROXY`, and filling it in switches on swaps and prices and leaves
 * chain traffic exactly where it is. Wiring this in is a deliberate second
 * act, not a side effect of a deploy, and `routeFor` will have to start
 * consulting `swapConfigured()` when it happens, because a relay that is not
 * deployed cannot be the answer for a node that is.
 */

import { hostOf, type NodeConfig } from '../core/nodes';
import { deadline, DEFAULT_TIMEOUT_MS, type Reply, type Request, type Transport } from './http';
import { SWAP_PROXY } from './swapproxy';

/**
 * The public nodes the proxy will relay to, by host.
 *
 * Held in step with `SUGGESTIONS` in `core/nodes.ts` and with `PUBLIC_NODES`
 * in the Worker; `test/nodeproxy.test.ts` fails if the app's suggestions and
 * this list drift apart, because the failure mode of drift is silent: a new
 * suggestion would simply stop being proxied and nobody would notice.
 */
export const RELAYED_HOSTS = [
  'mempool.space',
  'blockstream.info',
  'xmr-node.cakewallet.com',
  'node.monerodevs.org',
] as const;

export type Route =
  | { via: 'proxy'; host: string }
  | { via: 'direct'; because: 'yours' | 'not relayed' };

/** Which of the three cases this node is in. */
export function routeFor(node: NodeConfig): Route {
  /* `hostOf` rather than `new URL()`, because React Native's URL and the
   * WHATWG one disagree about backslashes and this decides whether traffic
   * is relayed. `nodes.ts` carries the argument and the measurement. */
  const host = hostOf(node.url);
  if (host === null) {
    return { via: 'direct', because: 'not relayed' };
  }
  /* Theirs wins first, before the list is even consulted: a person can run
   * their own copy of something on this list, and it is still theirs. */
  if (node.mine) return { via: 'direct', because: 'yours' };
  if ((RELAYED_HOSTS as readonly string[]).includes(host)) return { via: 'proxy', host };
  return { via: 'direct', because: 'not relayed' };
}

/**
 * Whether this wallet's owner has arranged to talk to nobody but their own
 * machines.
 *
 * True when at least one node is configured and every configured node is
 * marked `mine`. It matters because of what it must switch off: the price
 * lookup. Prices come from Labyrinth's relay so that no price service ever
 * sees a phone, and for traffic already routed through the relay that costs
 * nothing new. The person running only their own nodes is different. They
 * took the Nodes screen's own advice, and their traffic touches nobody but
 * machines they control; a price request would have this app contacting
 * Labyrinth on a timer, disclosing "this address runs a wallet, right now"
 * to the exact party they had arranged not to talk to. So it is skipped,
 * their balances show in coin, and the Nodes screen says so: a convenience
 * they did not ask for is not worth the arrangement they did.
 */
export function ownNodesOnly(nodes: { btc: NodeConfig | null; xmr: NodeConfig | null }): boolean {
  const set = [nodes.btc, nodes.xmr].filter((node): node is NodeConfig => node !== null);
  return set.length > 0 && set.every((node) => node.mine);
}

/** One sentence for the screen, so the person can see which case they are in. */
export function routeLine(node: NodeConfig): string {
  const route = routeFor(node);
  if (route.via === 'proxy') {
    return 'Reached through the Labyrinth relay, so this node sees the relay and not your address.';
  }
  return route.because === 'yours'
    ? 'Reached directly, because it is your own machine and nothing should sit between you and it.'
    : 'Reached directly. The relay only stands in front of the nodes this app suggests, and this is not one of them.';
}

/**
 * A transport that sends what it should through the relay and the rest
 * straight on, without the caller having to know which.
 *
 * The decision is made per node rather than per call so that a broadcast and
 * a balance check to the same node cannot end up taking different paths,
 * which would be a quiet way for one of them to leak while the other did not.
 */
export function routedTransport(
  node: NodeConfig,
  direct: Transport,
  base: string = SWAP_PROXY,
  doFetch: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Transport {
  const route = routeFor(node);
  if (route.via === 'direct') return direct;

  return {
    base: direct.base,
    async send(request: Request): Promise<Reply> {
      /* Nothing throws across this boundary, and nothing waits forever: the
       * same two contracts the direct transport holds, because a caller that
       * had to know which transport it was handed would defeat the point of
       * there being two. A relay that hangs is in fact worse than a node that
       * hangs, since the person did not choose it and has nothing to point
       * at: the screen would name the node they picked while the wait belongs
       * to a machine they never heard of. */
      const clock = deadline(timeoutMs);
      try {
        const query = new URLSearchParams({ host: route.host, path: request.path });
        const contentType = request.contentType ?? 'application/json';
        const response = await doFetch(`${base}/v1/node?${query.toString()}`, {
          method: request.method,
          signal: clock.signal,
          headers: { 'Content-Type': contentType, Accept: 'application/json' },
          ...(request.method === 'POST'
            ? {
                /* A raw transaction goes as the text it is. Serializing it as
                 * JSON would hand the node a quoted string and a broadcast
                 * that fails for a reason nobody would look for. */
                body: contentType === 'text/plain' ? String(request.body ?? '') : JSON.stringify(request.body ?? {}),
              }
            : {}),
        });
        const text = await response.text();
        if (!response.ok) {
          return { ok: false, status: response.status, problem: `The relay answered ${response.status}.` };
        }
        return { ok: true, status: response.status, text };
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') {
          return { ok: false, status: null, problem: 'The relay did not answer in time.' };
        }
        return { ok: false, status: null, problem: (error as Error)?.message ?? 'The relay did not answer.' };
      } finally {
        clock.done();
      }
    },
  };
}
