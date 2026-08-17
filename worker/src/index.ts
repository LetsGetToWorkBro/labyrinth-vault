/**
 * The relay.
 *
 * A handful of routes, one job: stand between a wallet and whoever it has to
 * talk to, so that an exchange or a chain node sees Cloudflare instead of
 * somebody's phone, and so the affiliate keys stay off the device. Everything
 * else about this file is restraint.
 *
 * ## What it keeps
 *
 * Nothing. There is no logging in this Worker, no database, no queue, no
 * analytics binding, and the single KV namespace holds integers under keys
 * that are HMACs of an address nobody can recover (see ratelimit.ts). That is
 * a structural claim rather than a policy one, and the retention suite in
 * `test/worker.test.ts` walks this source on every run to keep it true: a
 * `console.log` added here in six months fails the build, which is the only
 * kind of promise about logs that survives contact with a deadline.
 *
 * ## Two ways in
 *
 * Everything below can be reached directly, in which case this Worker sees a
 * caller's address next to their trade and the only thing between those two
 * facts is that it writes neither down. That is a promise, and it holds
 * exactly as long as everybody who ever deploys this Worker keeps it.
 *
 * The same routes can be reached through `/v1/gateway`, encrypted, forwarded
 * by a relay run by somebody who is not us. Then the relay holds the address
 * and cannot read the request, this Worker reads the request and sees the
 * relay where the caller would have been, and nobody holds both halves. The
 * promise stops being load-bearing. `gateway.ts` has the mechanics and the
 * one thing it costs.
 *
 * ## What it does not decide
 *
 * Whether an order is any good. The reply from the exchange is handed back as
 * it arrived, and `verifyOrder` runs in the wallet against the request the
 * wallet built. This Worker is infrastructure, and the app is written so that
 * infrastructure does not have to be trusted.
 */

import {
  REQUEST_MEDIA_TYPE,
  keyListResponse,
  openEncapsulated,
  parseKeys,
  sealAnswer,
} from './gateway';
import { nodeTarget } from './nodes';
import { currentPrices, PRICE_CACHE_MS } from './prices';
import { checkLimit } from './ratelimit';
import { buildCreate, buildQuote, buildStatus, knownProvider, send, type Intent, type Keys } from './upstream';

export interface Env {
  SWAP_LIMIT?: KVNamespace;
  SWAP_RATE_LIMIT_PER_MINUTE?: string;
  OHTTP_RATE_LIMIT_PER_MINUTE?: string;
  OHTTP_CREATE_LIMIT_PER_MINUTE?: string;
  EXOLIX_API_KEY?: string;
  GODEX_PUBLIC_KEY?: string;
  GODEX_AFFILIATE_ID?: string;
  RATE_LIMIT_SECRET?: string;
  OHTTP_KEYS?: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      /* Nothing here is cacheable by anybody: a quote is a moment's answer and
       * an order belongs to one person. */
      'Cache-Control': 'no-store',
      /* This Worker is called by a native app, so there is no browser origin
       * to please, and no reason to advertise one. */
      'X-Content-Type-Options': 'nosniff',
    },
  });

const problem = (sentence: string, status: number): Response => json({ ok: false, problem: sentence }, status);

/** The caller, for counting only. Never stored: see ratelimit.ts. */
const callerAddress = (request: Request): string =>
  request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

const keysFrom = (env: Env): Keys => ({
  exolix: env.EXOLIX_API_KEY,
  godexPublic: env.GODEX_PUBLIC_KEY,
  godexAffiliate: env.GODEX_AFFILIATE_ID,
});

/**
 * The intent, from a body that has already been measured.
 *
 * It takes text rather than the request on purpose. `request.json()` reads and
 * parses in one step, which is how this route came to have no ceiling at all
 * while the two routes either side of it did: there was no point in the code
 * where the bytes existed and a size could be asked about. Taking the string
 * makes it impossible to reach the parser without having gone past the
 * measurement in `serve`.
 */
function readIntent(text: string): Record<string, unknown> | null {
  try {
    const body: unknown = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const numberOf = (value: unknown): number =>
  typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));

const intOr = (text: string | undefined, fallback: number): number => {
  const value = Number.parseInt(text ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
};

/**
 * The largest body this Worker will read, on either door.
 *
 * There is a ceiling already: Cloudflare refuses an oversized request before
 * this code runs. That ceiling is real and it is also somewhere else, which
 * is the problem. Every parser on the vault side carries its own limit in its
 * own source, and a guarantee that lives in a platform's current
 * configuration is one nobody can check by reading this file, and one that
 * does not survive being deployed anywhere else.
 *
 * A megabyte is chosen against the largest thing a person can legitimately
 * send. That is a raw transaction going out through `/v1/node`: Bitcoin
 * standardness caps a transaction at 100,000 bytes, which is 200,000
 * characters of hex, and Monero's are smaller. Every other payload here is a
 * few hundred bytes of intent. So this is roughly five times the worst honest
 * case and a hundredth of the platform's, which is the shape a limit should
 * have: invisible to anybody real, and firmly in the way of everybody else.
 */
const MAX_BODY_BYTES = 1_048_576;

/**
 * Whether the caller has already told us the body is too big.
 *
 * Cheap and worth doing first, because it refuses before a byte is read.
 * A chunked request declares no length and slips past this, which is why the
 * check below reads the body and then measures it. That second check is the
 * one that matters: what it stands in front of is the decryption, and
 * decrypting a megabyte of nonsense is the expense worth refusing, not
 * holding it in memory.
 */
const declaredTooBig = (request: Request): boolean =>
  Number.parseInt(request.headers.get('Content-Length') ?? '', 10) > MAX_BODY_BYTES;

/**
 * The routes themselves, with no rate limiting and no knowledge of how the
 * request arrived.
 *
 * Separated out so that `/v1/gateway` can serve exactly the same routes as
 * the open door does. If the oblivious path had its own copy of the routing,
 * the two would drift, and the way that drift would show up is a feature that
 * quietly works only for the people not using the private path.
 */
async function serve(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  try {
    /* Every body this Worker reads is measured, and it is measured here,
     * before any route is chosen. That ordering is the whole point. The
     * ceiling used to be written into each route that carried a body, and two
     * separate audits found a third route that had not been told: first
     * `/v1/node`, then `/v1/quote` and `/v1/create`, each patched in turn.
     * A rule enforced by a list of the places that remembered it is a rule
     * that fails on the next place added. Here the body is read once, above
     * the routing, and a route that wants one takes the string. */
    let body: string | null = null;
    if (request.method === 'POST') {
      if (declaredTooBig(request)) return problem('That is too large to relay.', 413);
      body = await request.text();
      if (body.length > MAX_BODY_BYTES) return problem('That is too large to relay.', 413);
    }

    /* Also answered outside, before the counting, so that "is it deployed"
     * costs a caller nothing. Here as well so that it can be asked through
     * the oblivious door like everything else. */
    if (url.pathname === '/v1/health') return json({ ok: true });

    /* Prices, one cached answer for everybody. Publicly cacheable on purpose
     * and in contrast to everything else here: a price is the same number for
     * every caller, and identical widely-cached bytes are what keep one
     * caller from being told apart from the rest. The edge absorbs the
     * traffic and the upstream sees this Worker on a timer, never a person.
     * See prices.ts for the whole argument. */
    if (url.pathname === '/v1/price') {
      if (request.method !== 'GET') return problem('That method is not served here.', 405);
      const answer = await currentPrices();
      if (!answer.ok) return problem(answer.problem, 502);
      return new Response(JSON.stringify({ ok: true, prices: answer.prices }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${Math.floor(PRICE_CACHE_MS / 1000)}`,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    /* The chain node relay. A public node learns every address it is
     * asked about and, on a broadcast, which address announced a
     * transaction first; this puts Cloudflare in front of both. A node
     * somebody runs themselves never arrives here, because the wallet
     * sends that traffic straight there rather than through a stranger. */
    if (url.pathname === '/v1/node') {
      const target = nodeTarget(url.searchParams.get('host') ?? '', url.searchParams.get('path') ?? '');
      if (!target.ok) return problem(target.problem, 400);
      if (request.method !== 'GET' && request.method !== 'POST') {
        return problem('That method is not relayed.', 405);
      }
      /* The content type is carried across rather than assumed. Esplora
       * takes a broadcast as text/plain: a raw transaction retyped as JSON
       * arrives at the node as a quoted string and fails for a reason
       * nobody would think to look for. */
      const contentType = request.headers.get('Content-Type') ?? 'application/json';
      /* Already measured above, so a public node never receives something
       * this Worker would not have accepted for itself. */
      const upstream = await fetch(target.url, {
        method: request.method,
        headers: { Accept: 'application/json', 'Content-Type': contentType },
        ...(body === null ? {} : { body }),
      });
      /* Handed back as it arrived, body and status. This Worker does not
       * read chain data any more than it reads an exchange's answer: the
       * wallet scans, verifies and decides, on the device. */
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    if (url.pathname === '/v1/status' && request.method === 'GET') {
      const provider = knownProvider(url.searchParams.get('provider'));
      if (!provider) return problem('Unknown exchange.', 400);
      const built = buildStatus(provider, url.searchParams.get('id') ?? '');
      if (!built.ok) return problem(built.problem, 400);
      const answer = await send(built.request, provider, keysFrom(env));
      return json({ ok: true, upstream: answer.body }, answer.status >= 500 ? 502 : 200);
    }

    if ((url.pathname === '/v1/quote' || url.pathname === '/v1/create') && request.method === 'POST') {
      const intended = readIntent(body ?? '');
      if (!intended) return problem('That request was not readable.', 400);
      const provider = knownProvider(intended['provider']);
      if (!provider) return problem('Unknown exchange.', 400);

      const intent: Intent = {
        provider,
        from: String(intended['from'] ?? ''),
        to: String(intended['to'] ?? ''),
        amount: numberOf(intended['amount']),
        ...(typeof intended['payoutAddress'] === 'string' ? { payoutAddress: intended['payoutAddress'] } : {}),
        ...(typeof intended['refundAddress'] === 'string' ? { refundAddress: intended['refundAddress'] } : {}),
        /* Bounded and passed through unread. It is a uuid from the provider,
         * not something this Worker interprets. */
        ...(typeof intended['rateUuid'] === 'string' && intended['rateUuid'].length <= 64
          ? { rateUuid: intended['rateUuid'] }
          : {}),
      };

      const built = url.pathname === '/v1/quote' ? buildQuote(intent) : buildCreate(intent);
      if (!built.ok) return problem(built.problem, 400);

      const answer = await send(built.request, provider, keysFrom(env));
      return json({ ok: true, upstream: answer.body }, answer.status >= 500 ? 502 : 200);
    }

    return problem('No such route.', 404);
  } catch (error) {
    /* The message, not the stack, and not the request. An upstream that
     * refuses or times out is a sentence the app can show; anything more
     * would be this Worker keeping a record of a trade in an error path,
     * which is the same retention the rest of the file refuses. */
    return problem(`The exchange could not be reached (${(error as Error)?.message ?? 'no answer'}).`, 502);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    /* A health check that answers without touching anything. Useful for
     * knowing the Worker is deployed; deliberately says nothing about
     * configuration, because "which keys are set" is not a stranger's
     * business. */
    if (url.pathname === '/v1/health') return json({ ok: true });

    /* The gateway's public keys, in RFC 9458's own format. Unmetered and
     * cacheable on purpose: it is the same bytes for everybody, it is the
     * first thing a client needs, and rate limiting the one request that has
     * to happen before anything can be private would be an odd place to
     * start counting. */
    if (url.pathname === '/v1/ohttp-keys') {
      if (request.method !== 'GET') return problem('That method is not served here.', 405);
      const keys = parseKeys(env.OHTTP_KEYS);
      if (keys.length === 0) return problem('This gateway is not configured for Oblivious HTTP.', 404);
      return keyListResponse(keys);
    }

    /* The oblivious door. What arrives here came from a relay, so the address
     * this Worker can see belongs to the relay and not to a person, which is
     * the entire point and also why the counting below is different. */
    if (url.pathname === '/v1/gateway') {
      if (request.method !== 'POST') return problem('That method is not served here.', 405);
      const keys = parseKeys(env.OHTTP_KEYS);
      if (keys.length === 0) return problem('This gateway is not configured for Oblivious HTTP.', 404);

      /* Counted against the relay, generously. A relay carries everybody, so
       * a limit sized for one person would take the whole relay down at the
       * first busy minute; a limit that is nevertheless finite is what keeps
       * a broken or hostile relay from turning this into an open amplifier.
       * Per-person limiting is genuinely gone here, and that is the price of
       * not being told who is calling. */
      const counted = await checkLimit(
        env.SWAP_LIMIT,
        env.RATE_LIMIT_SECRET,
        `relay:${callerAddress(request)}`,
        intOr(env.OHTTP_RATE_LIMIT_PER_MINUTE, 6000),
        Date.now(),
      );
      if (!counted.allowed) {
        return new Response(null, { status: 429, headers: { 'Retry-After': String(counted.resetSeconds) } });
      }

      if ((request.headers.get('Content-Type') ?? '').split(';')[0]?.trim() !== REQUEST_MEDIA_TYPE) {
        return new Response(null, { status: 415 });
      }

      if (declaredTooBig(request)) return new Response(null, { status: 413 });
      const encapsulated = new Uint8Array(await request.arrayBuffer());
      /* Before the key lookup and before any decryption. The relay handed
       * these bytes over and already knows how many there were, so refusing
       * by size in the clear tells it nothing it did not measure itself. */
      if (encapsulated.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });

      let opened;
      try {
        opened = openEncapsulated(keys, encapsulated, url.origin);
      } catch {
        /* One shape for every failure, and no body. Which key is current,
         * whether a given key id exists, and whether a ciphertext was merely
         * damaged are all things a prober would like to learn, and none of
         * them are worth telling apart out loud. */
        return new Response(null, { status: 400 });
      }

      /* An encapsulated request may not be another encapsulated request. The
       * loop would be pointless rather than dangerous, but a route that can
       * be pointed at itself is a route somebody will eventually point at
       * itself a few thousand times. */
      const inner = new URL(opened.request.url);
      if (inner.pathname === '/v1/gateway' || inner.pathname === '/v1/ohttp-keys') {
        return sealAnswer(opened, problem('That route is not reachable from inside.', 404));
      }

      /* Which route this is can be counted without knowing whose it is, and
       * that is worth using. Creating an order is the only route that writes
       * something durable at a stranger, under our affiliate key, so it gets
       * a ceiling of its own well under the relay's. Quotes and node reads
       * are cheap and idempotent and stay under the general limit.
       *
       * This does trade one failure for another: a single abuser can now eat
       * the relay's whole order budget and get honest people a 429. That is
       * the better failure. A 429 is a minute old and recoverable; an
       * affiliate key flagged for abuse at the exchange breaks swaps for
       * everybody until a human negotiates a new one. */
      if (inner.pathname === '/v1/create') {
        const orders = await checkLimit(
          env.SWAP_LIMIT,
          env.RATE_LIMIT_SECRET,
          `relay-create:${callerAddress(request)}`,
          intOr(env.OHTTP_CREATE_LIMIT_PER_MINUTE, 120),
          Date.now(),
        );
        /* Sealed, like any other answer. Refusing in the clear would tell the
         * relay that this particular request was an order, which is exactly
         * the kind of thing it is not supposed to be able to learn. */
        if (!orders.allowed) {
          return sealAnswer(
            opened,
            problem('Too many orders are being created right now. Try again in a moment.', 429),
          );
        }
      }

      return sealAnswer(opened, await serve(opened.request, env));
    }

    const counted = await checkLimit(
      env.SWAP_LIMIT,
      env.RATE_LIMIT_SECRET,
      callerAddress(request),
      intOr(env.SWAP_RATE_LIMIT_PER_MINUTE, 60),
      Date.now(),
    );
    if (!counted.allowed) {
      return new Response(
        JSON.stringify({ ok: false, problem: `Too many requests. Try again in ${counted.resetSeconds}s.` }),
        {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': String(counted.resetSeconds) },
        },
      );
    }

    return serve(request, env);
  },
};
