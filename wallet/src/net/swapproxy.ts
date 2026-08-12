/**
 * The swap transport that goes through Labyrinth's proxy.
 *
 * Every other transport in this app talks to a node the person chose. This
 * one talks to a server this project runs, which is a different kind of thing
 * and worth being plain about.
 *
 * **Why it exists.** Talking to an exchange from a phone hands that exchange
 * the person's IP address next to two addresses they own. Nothing on the swap
 * screen fixes that, and the privacy note says so. Routing through the proxy
 * moves what the exchange learns: it sees Cloudflare, and the trade, and not
 * the person. It is also the only way the affiliate keys can be used at all,
 * since a key compiled into a phone app is a published key.
 *
 * **What it costs.** The proxy sees the request while it forwards it. It has
 * to, because it is attaching a key to a real trade. What it does not do is
 * keep any of it: no logging, no database, and a rate limiter that counts an
 * opaque HMAC rather than an address, all of which is enforced by a test that
 * walks the Worker's own source. That is a provable claim about storage and
 * not a claim about what is visible in flight, and the difference is written
 * down here rather than smoothed over.
 *
 * **What it is not trusted with.** Anything. The proxy hands back what the
 * exchange said, unread, and `verifyOrder` runs here, on this device, against
 * the request this device built. A proxy that verified orders on the app's
 * behalf could lie about the answer; this one is never asked.
 */

import type { HttpRequest, SwapTransport } from '../core/swap';

/** Where the proxy lives. One host, named once. */
export const SWAP_PROXY = 'https://swap.labyrinth.vision';

/**
 * What the wallet asks the proxy for.
 *
 * Deliberately an intent rather than a URL. The proxy builds the upstream
 * request itself, from the same catalog and the same adapter functions this
 * app uses, which is what keeps it from being an open relay anybody could
 * point at anything.
 */
export interface SwapIntent {
  provider: string;
  from: string;
  to: string;
  amount: number;
  payoutAddress?: string;
  refundAddress?: string;
}

interface ProxyReply {
  ok?: boolean;
  problem?: string;
  upstream?: unknown;
}

/**
 * Ask the proxy, and hand back exactly what the exchange said.
 *
 * The reply is unwrapped to the upstream body so that every parser in
 * `core/swap.ts` works unchanged, whether the answer arrived through here or
 * straight from the exchange. A transport that reshaped replies would be a
 * second place the wire format is written down, and the second one is always
 * the one that goes stale.
 */
export function proxyTransport(
  base: string = SWAP_PROXY,
  doFetch: typeof fetch = fetch,
): SwapTransport & { quote(intent: SwapIntent): Promise<unknown>; create(intent: SwapIntent): Promise<unknown>; status(provider: string, id: string): Promise<unknown> } {
  const call = async (path: string, init: RequestInit): Promise<unknown> => {
    const response = await doFetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
    let body: ProxyReply;
    try {
      body = (await response.json()) as ProxyReply;
    } catch {
      throw new Error('The proxy answered with something unreadable.');
    }
    if (!body.ok) throw new Error(body.problem ?? 'The proxy refused.');
    return body.upstream;
  };

  return {
    /* `send` is here so this satisfies SwapTransport, but the proxy takes an
     * intent rather than a URL by design. Anything that reaches this path is
     * a caller that has not been moved over yet, and it says so rather than
     * quietly falling back to talking to the exchange directly, which would
     * undo the entire point of routing through here. */
    async send(request: HttpRequest): Promise<unknown> {
      throw new Error(
        `The swap proxy takes an intent, not a URL (${request.method} ${new URL(request.url).hostname}). ` +
          'Use quote, create or status.',
      );
    },
    quote: (intent: SwapIntent) => call('/v1/quote', { method: 'POST', body: JSON.stringify(intent) }),
    create: (intent: SwapIntent) => call('/v1/create', { method: 'POST', body: JSON.stringify(intent) }),
    status: (provider: string, id: string) =>
      call(`/v1/status?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(id)}`, { method: 'GET' }),
  };
}
