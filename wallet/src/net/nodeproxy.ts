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
 */

import type { NodeConfig } from '../core/nodes';
import type { Reply, Request, Transport } from './http';
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
  let host: string;
  try {
    host = new URL(node.url).hostname.toLowerCase();
  } catch {
    return { via: 'direct', because: 'not relayed' };
  }
  /* Theirs wins first, before the list is even consulted: a person can run
   * their own copy of something on this list, and it is still theirs. */
  if (node.mine) return { via: 'direct', because: 'yours' };
  if ((RELAYED_HOSTS as readonly string[]).includes(host)) return { via: 'proxy', host };
  return { via: 'direct', because: 'not relayed' };
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
): Transport {
  const route = routeFor(node);
  if (route.via === 'direct') return direct;

  return {
    base: direct.base,
    async send(request: Request): Promise<Reply> {
      /* Nothing throws across this boundary, same contract as the direct
       * transport: a screen should render "the node did not answer" rather
       * than a red box, and a relay that failed differently from a direct
       * connection would be a second set of failure paths to get right. */
      try {
        const query = new URLSearchParams({ host: route.host, path: request.path });
        const contentType = request.contentType ?? 'application/json';
        const response = await doFetch(`${base}/v1/node?${query.toString()}`, {
          method: request.method,
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
        return { ok: false, status: null, problem: (error as Error)?.message ?? 'The relay did not answer.' };
      }
    },
  };
}
