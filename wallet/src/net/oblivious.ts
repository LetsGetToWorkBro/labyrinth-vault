/**
 * The client half of Oblivious HTTP, shaped like `fetch` so it can be dropped
 * into the transports that already exist.
 *
 * `proxyTransport` and `routedTransport` both take their `fetch` as an
 * argument. That was not an accident and this is what it was for: handing
 * either of them the function below moves every swap call and every chain node
 * call onto the oblivious path without a line changing in either of them, and
 * without a second copy of the request-building logic that could disagree with
 * the first.
 *
 * ## What changes, and what does not
 *
 * Without this, the shape is: phone talks to our Worker, our Worker talks to
 * the exchange. The exchange sees us. We see the phone's address next to the
 * trade, and the only thing between those two facts is that we write neither
 * down. That is a promise.
 *
 * With this: the phone talks to a relay run by somebody else, encrypted to our
 * gateway's key. The relay sees the address and ciphertext. Our gateway sees
 * the trade and the relay. The exchange still sees us. Nobody holds both
 * halves, and the promise is no longer what the privacy rests on.
 *
 * ## The relay has to be somebody else
 *
 * This is the part that is easy to get wrong while appearing to do everything
 * right. The gateway runs on Cloudflare. A relay that also runs on Cloudflare
 * puts both halves of the secret inside one company, and the protocol goes
 * through every motion for no gain. The relay must be a different operator on
 * different infrastructure, and until one is agreed, `RELAYS` below is empty
 * and this code does not run. An empty list is the honest state; a list
 * containing our own address would be theatre.
 *
 * ## Where the key configuration comes from
 *
 * Through the relay, not from the gateway. Fetching it straight from the
 * gateway would hand the gateway the address that this whole arrangement
 * exists to keep from it, once per client, which is enough. Relay operators
 * publish a passthrough for exactly this reason, and `keysUrl` is where it
 * goes.
 */

import { deadline, DEFAULT_TIMEOUT_MS } from './http';
import { decodeResponse, encodeRequest, type BRequest } from './ohttp/bhttp';
import { decodeKeyList, sealRequest, openResponse, usable, type KeyConfig } from './ohttp/ohttp';

export const REQUEST_MEDIA_TYPE = 'message/ohttp-req';
export const RESPONSE_MEDIA_TYPE = 'message/ohttp-res';
export const KEYS_MEDIA_TYPE = 'application/ohttp-keys';

export interface Relay {
  /** Who runs it, for the screen. A person should be able to see the name. */
  operator: string;
  /** Where encapsulated requests are posted. */
  url: string;
  /** The relay's passthrough for the gateway's key configuration. */
  keysUrl: string;
}

/**
 * The relays this app will use.
 *
 * Empty, deliberately, and not as a placeholder to be filled with whatever is
 * convenient. An entry here is a statement that some named third party carries
 * this traffic and does not share an operator with the gateway. Adding our own
 * host, or another Cloudflare property, would satisfy the type and defeat the
 * protocol.
 */
export const RELAYS: Relay[] = [];

/** Which of the three arrangements is actually in force. */
export type Posture = 'oblivious' | 'relayed' | 'direct';

/**
 * The posture for anything that goes through Labyrinth.
 *
 * `direct` is not returned here because it is not this file's decision: a
 * person's own node, and a custom node the relay would refuse anyway, are
 * settled in `nodeproxy.ts` before anything reaches this path.
 */
export function posture(relays: Relay[] = RELAYS): Posture {
  return relays.length > 0 ? 'oblivious' : 'relayed';
}

/** One sentence for the screen, matching whichever of the three is true. */
export function postureLine(current: Posture): string {
  switch (current) {
    case 'oblivious':
      return 'Sent through a relay we do not run, encrypted to us. The relay knows your address and cannot read the request. We can read the request and never see your address.';
    case 'relayed':
      return 'Sent through Labyrinth, so the exchange sees us and not you. We can see the request while we forward it, and we keep no record of it.';
    case 'direct':
      return 'Sent straight from this device, so whoever answers sees your address.';
  }
}

/**
 * A key configuration, and when it was fetched.
 *
 * Cached because every client fetching fresh is both slow and worse: a
 * configuration served to one client alone is a configuration that identifies
 * that client's traffic. Everyone holding the same widely cached bytes is the
 * privacy-preserving state, so the cache here is a feature rather than an
 * optimization.
 */
interface Cached {
  config: KeyConfig;
  at: number;
}

const HOUR = 3_600_000;

export interface ObliviousOptions {
  doFetch?: typeof fetch;
  now?: () => number;
  /** How long a fetched key configuration is reused. */
  keyLifetimeMs?: number;
  /** How long either leg waits, per `http.ts`'s rule for this layer. */
  timeoutMs?: number;
}

/**
 * A `fetch` that goes the oblivious way.
 *
 * The request is turned into binary HTTP, sealed to the gateway, posted to the
 * relay, and the answer is unsealed back into a `Response`. Callers cannot
 * tell the difference, which is the point: `routedTransport` hands this to the
 * same code that would otherwise have called the network directly.
 *
 * Failures are thrown rather than smoothed over. Both transports that use this
 * already catch and turn a thrown error into "the relay did not answer", and a
 * fetch that manufactured a failure `Response` instead would be
 * indistinguishable from one the gateway actually sent.
 */
export function obliviousFetch(relay: Relay, options: ObliviousOptions = {}): typeof fetch {
  const doFetch = options.doFetch ?? fetch;
  const now = options.now ?? Date.now;
  const lifetime = options.keyLifetimeMs ?? 24 * HOUR;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let cached: Cached | null = null;

  /* Both legs carry a deadline. There are two of them, and a relay is a party
   * this design already declines to trust for confidentiality, so trusting it
   * to answer at all would be an odd place to start. Each leg also follows the
   * caller's own signal: this function is handed to `proxyTransport` and
   * `routedTransport` as their `fetch`, and without that the relay leg would
   * keep running for its full timeout after the transport above had already
   * given up and told the person the proxy did not answer. */
  const keyConfig = async (upstream: AbortSignal): Promise<KeyConfig> => {
    if (cached && now() - cached.at < lifetime) return cached.config;
    const clock = deadline(timeoutMs, upstream);
    let bytes: Uint8Array;
    try {
      const response = await doFetch(relay.keysUrl, {
        method: 'GET',
        signal: clock.signal,
        headers: { Accept: KEYS_MEDIA_TYPE },
      });
      if (!response.ok) throw new Error(`The relay could not supply the gateway keys (${response.status}).`);
      /* Read under the same deadline that fetched it. A timer cleared as soon
       * as the headers arrive covers nothing: a server that answers 200 and
       * then trickles the body forever is exactly the shape of hang a deadline
       * is for, and it is the shape that survives a naive one. */
      bytes = new Uint8Array(await response.arrayBuffer());
    } finally {
      clock.done();
    }
    const config = decodeKeyList(bytes).find(usable);
    if (!config) throw new Error('The gateway offers no cipher suite this app can use.');
    cached = { config, at: now() };
    return config;
  };

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());

    const inner: BRequest = {
      method: request.method,
      scheme: url.protocol.replace(':', ''),
      authority: url.host,
      path: `${url.pathname}${url.search}`,
      /* Only the fields the far end needs. Every header carried across is a
       * detail about this client that the gateway can see, and a set of
       * headers unusual enough to be distinctive would identify the traffic
       * as surely as an address would. */
      headers: [...request.headers]
        .filter(([name]) => ['content-type', 'accept'].includes(name.toLowerCase()))
        .map(([name, value]) => [name, value] as [string, string]),
      body,
    };

    const sealed = sealRequest(await keyConfig(request.signal), encodeRequest(inner));
    const clock = deadline(timeoutMs, request.signal);
    let answered: Uint8Array;
    try {
      const answer = await doFetch(relay.url, {
        method: 'POST',
        signal: clock.signal,
        headers: { 'Content-Type': REQUEST_MEDIA_TYPE, Accept: RESPONSE_MEDIA_TYPE },
        body: sealed.body as BodyInit,
      });
      if (!answer.ok) throw new Error(`The relay answered ${answer.status}.`);
      answered = new Uint8Array(await answer.arrayBuffer());
    } finally {
      clock.done();
    }

    const opened = decodeResponse(openResponse(sealed.context, sealed.enc, answered));
    /* A status with no body of its own must not be given one, or the Response
     * constructor throws and a perfectly good answer becomes a crash. */
    const bodyless = opened.status === 204 || opened.status === 205 || opened.status === 304;
    return new Response(bodyless ? null : (opened.body as BodyInit), {
      status: opened.status,
      headers: opened.headers,
    });
  };
}
