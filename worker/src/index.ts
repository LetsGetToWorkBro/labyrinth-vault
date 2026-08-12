/**
 * The swap proxy.
 *
 * Three routes, one job: stand between a wallet and an exchange so that the
 * exchange sees Cloudflare instead of somebody's phone, and so the affiliate
 * keys stay off the device. Everything else about this file is restraint.
 *
 * ## What it keeps
 *
 * Nothing. There is no logging in this Worker, no database, no queue, no
 * analytics binding, and the single KV namespace holds integers under keys
 * that are HMACs of an address nobody can recover (see ratelimit.ts). That is
 * a structural claim rather than a policy one, and `test/no-retention.test.ts`
 * walks this source on every run to keep it true: a `console.log` added here
 * in six months fails the build, which is the only kind of promise about logs
 * that survives contact with a deadline.
 *
 * ## What it cannot promise
 *
 * It sees the request while it is forwarding it. It has to: the affiliate key
 * has to be attached to a real trade, and a proxy cannot forward what it
 * cannot read. So "we store nothing" is true and provable, and "we could not
 * see it if we wanted to" is not, and this file does not pretend otherwise.
 * The design that would make the second true is Oblivious HTTP, where a relay
 * run by somebody else holds the address and this gateway holds only the
 * trade; README.md carries the plan and the reason it is not built yet.
 *
 * ## What it does not decide
 *
 * Whether an order is any good. The reply from the exchange is handed back as
 * it arrived, and `verifyOrder` runs in the wallet against the request the
 * wallet built. This Worker is infrastructure, and the app is written so that
 * infrastructure does not have to be trusted.
 */

import { checkLimit } from './ratelimit';
import { buildCreate, buildQuote, buildStatus, knownProvider, send, type Intent, type Keys } from './upstream';

export interface Env {
  SWAP_LIMIT?: KVNamespace;
  SWAP_RATE_LIMIT_PER_MINUTE?: string;
  EXOLIX_API_KEY?: string;
  GODEX_PUBLIC_KEY?: string;
  GODEX_AFFILIATE_ID?: string;
  RATE_LIMIT_SECRET?: string;
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

async function readIntent(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const numberOf = (value: unknown): number =>
  typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    /* A health check that answers without touching anything. Useful for
     * knowing the Worker is deployed; deliberately says nothing about
     * configuration, because "which keys are set" is not a stranger's
     * business. */
    if (url.pathname === '/v1/health') return json({ ok: true });

    const limit = Number.parseInt(env.SWAP_RATE_LIMIT_PER_MINUTE ?? '60', 10);
    const counted = await checkLimit(
      env.SWAP_LIMIT,
      env.RATE_LIMIT_SECRET,
      callerAddress(request),
      Number.isFinite(limit) ? limit : 60,
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

    try {
      if (url.pathname === '/v1/status' && request.method === 'GET') {
        const provider = knownProvider(url.searchParams.get('provider'));
        if (!provider) return problem('Unknown exchange.', 400);
        const built = buildStatus(provider, url.searchParams.get('id') ?? '');
        if (!built.ok) return problem(built.problem, 400);
        const answer = await send(built.request, provider, keysFrom(env));
        return json({ ok: true, upstream: answer.body }, answer.status >= 500 ? 502 : 200);
      }

      if ((url.pathname === '/v1/quote' || url.pathname === '/v1/create') && request.method === 'POST') {
        const body = await readIntent(request);
        if (!body) return problem('That request was not readable.', 400);
        const provider = knownProvider(body['provider']);
        if (!provider) return problem('Unknown exchange.', 400);

        const intent: Intent = {
          provider,
          from: String(body['from'] ?? ''),
          to: String(body['to'] ?? ''),
          amount: numberOf(body['amount']),
          ...(typeof body['payoutAddress'] === 'string' ? { payoutAddress: body['payoutAddress'] } : {}),
          ...(typeof body['refundAddress'] === 'string' ? { refundAddress: body['refundAddress'] } : {}),
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
  },
};
