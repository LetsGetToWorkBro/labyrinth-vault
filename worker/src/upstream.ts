/**
 * Talking to the exchanges, and the two things this layer is careful about.
 *
 * **It is not an open proxy.** The wallet does not hand over a URL to fetch.
 * It names a provider, two coins, an amount and the addresses, and the
 * request is built here by the same functions the wallet itself uses, from
 * `wallet/src/core/swap.ts`. That module is pure, has no React Native in it,
 * and is the single place provider request shapes are written down; importing
 * it means the Worker and the app cannot drift into disagreeing about what an
 * Exolix rate call looks like. A proxy that forwarded arbitrary URLs would be
 * a free anonymizer for anybody who found it, and would be abused within a
 * day of being discovered.
 *
 * **It does not interpret the answer.** What comes back from the exchange is
 * handed on as it arrived. The Worker does not parse orders, does not check
 * payout addresses, and does not decide whether an order is acceptable, and
 * that is deliberate rather than lazy: `verifyOrder` runs in the wallet,
 * against the request the wallet built, because the wallet is the only party
 * that knows what it asked for. A Worker that verified on the app's behalf
 * would be a Worker that could lie about the result, and this one is
 * infrastructure the app should not have to trust.
 */

import {
  exolixCreate,
  exolixRate,
  exolixStatus,
  godexCreate,
  godexRate,
  godexStatus,
  parsePair,
  swapCoin,
  type HttpRequest,
  type ProviderId,
  type SwapPair,
  type SwapRequest,
} from '../../wallet/src/core/swap';

/** Every host this Worker will ever open a connection to. */
export const ALLOWED_HOSTS = ['exolix.com', 'api.godex.io'] as const;

export interface Intent {
  provider: ProviderId;
  from: string;
  to: string;
  amount: number;
  payoutAddress?: string;
  refundAddress?: string;
  /**
   * The quote handle the provider issued, carried through untouched.
   *
   * Godex honors a quoted rate only for an order that brings its `rate_uuid`
   * back. The wallet holds the quote and this Worker does not, so the handle
   * has to survive the hop or the order gets repriced at creation and the
   * wallet's own drift check refuses it. Opaque here, and never inspected:
   * this Worker does not read orders and does not start now.
   */
  rateUuid?: string;
}

export type Built = { ok: true; request: HttpRequest } | { ok: false; problem: string };

const PROVIDERS: readonly ProviderId[] = ['exolix', 'godex'];

/** A provider this build speaks to, or nothing. */
export function knownProvider(value: unknown): ProviderId | null {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value)
    ? (value as ProviderId)
    : null;
}

/**
 * The pair, checked against the catalog before anything is sent.
 *
 * `parsePair` refuses a coin this build does not list, which is what keeps a
 * caller from using this endpoint to reach a currency nobody has checked the
 * network naming for.
 */
function pairOf(intent: Intent): { ok: true; pair: SwapPair } | { ok: false; problem: string } {
  if (!swapCoin(intent.from) || !swapCoin(intent.to)) return { ok: false, problem: 'Unknown coin.' };
  const parsed = parsePair(intent.from, intent.to);
  if (!parsed.ok) return { ok: false, problem: parsed.problem };
  return { ok: true, pair: parsed.pair };
}

export function buildQuote(intent: Intent): Built {
  const pair = pairOf(intent);
  if (!pair.ok) return pair;
  if (!Number.isFinite(intent.amount) || intent.amount <= 0) {
    return { ok: false, problem: 'That is not an amount.' };
  }
  return {
    ok: true,
    request: intent.provider === 'exolix' ? exolixRate(pair.pair, intent.amount) : godexRate(pair.pair, intent.amount),
  };
}

export function buildCreate(intent: Intent): Built {
  const pair = pairOf(intent);
  if (!pair.ok) return pair;
  if (!Number.isFinite(intent.amount) || intent.amount <= 0) {
    return { ok: false, problem: 'That is not an amount.' };
  }
  const payoutAddress = String(intent.payoutAddress ?? '').trim();
  const refundAddress = String(intent.refundAddress ?? '').trim();
  if (!payoutAddress || !refundAddress) {
    return { ok: false, problem: 'An order needs a payout address and a refund address.' };
  }
  /* `payoutIsOurs` is the app's own bookkeeping about how it obtained the
   * address, and means nothing on this side of the wire; it is not sent. */
  const request: SwapRequest = {
    provider: intent.provider,
    pair: pair.pair,
    amount: intent.amount,
    payoutAddress,
    refundAddress,
    payoutIsOurs: false,
  };
  /* Only the handle travels, wrapped as the minimal quote the adapter reads.
   * A whole quote from the caller would be a set of numbers this Worker would
   * appear to have checked, and it checks nothing. */
  const quote = intent.rateUuid ? { provider: intent.provider, ok: true, rateUuid: intent.rateUuid } : undefined;
  return {
    ok: true,
    request: intent.provider === 'exolix' ? exolixCreate(request) : godexCreate(request, quote),
  };
}

export function buildStatus(provider: ProviderId, id: string): Built {
  const trimmed = String(id ?? '').trim();
  /* Bounded because it lands in a URL path. A provider's order id is a short
   * token; a kilobyte of anything is somebody trying something. */
  if (!trimmed || trimmed.length > 128) return { ok: false, problem: 'That is not an order id.' };
  return { ok: true, request: provider === 'exolix' ? exolixStatus(trimmed) : godexStatus(trimmed) };
}

export interface Keys {
  exolix?: string | undefined;
  godexPublic?: string | undefined;
  godexAffiliate?: string | undefined;
}

/**
 * Send it, with the affiliate credentials attached.
 *
 * The keys are the reason this Worker is not optional. Exolix's reference
 * asks for the key on every request to earn affiliate credit, and Godex wants
 * a partner token in a header and an affiliate id in the body. Both would be
 * extractable from a phone binary within minutes of shipping, so both live
 * here and neither ever reaches a device.
 *
 * The host allowlist is checked immediately before the fetch rather than only
 * where the URL was built, because this is the line that actually opens the
 * connection and it should be the line that refuses.
 */
export async function send(
  request: HttpRequest,
  provider: ProviderId,
  keys: Keys,
  fetcher: typeof fetch = fetch,
): Promise<{ status: number; body: unknown }> {
  const url = new URL(request.url);
  if (!(ALLOWED_HOSTS as readonly string[]).includes(url.hostname)) {
    throw new Error(`refusing to call ${url.hostname}`);
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  let body = request.body;

  if (provider === 'exolix' && keys.exolix) {
    headers['api-key'] = keys.exolix;
  }
  if (provider === 'godex') {
    if (keys.godexPublic) headers['public-key'] = keys.godexPublic;
    /* Godex takes the affiliate id in the query of the call that creates the
     * transaction. Only added where it means something, so a rate check does
     * not carry an identifier it has no use for. */
    if (keys.godexAffiliate && request.method === 'POST' && url.pathname.endsWith('/transaction')) {
      body = { ...(body ?? {}), affiliate_id: keys.godexAffiliate };
    }
  }

  const response = await fetcher(url.toString(), {
    method: request.method,
    headers,
    ...(request.method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  });

  /* Whatever it said, unread. A body that is not JSON is passed on as the
   * text it was rather than turned into an exception, because the exchange
   * saying something unexpected is information the app should see. */
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { problem: text.slice(0, 400) };
  }
  return { status: response.status, body: parsed };
}
