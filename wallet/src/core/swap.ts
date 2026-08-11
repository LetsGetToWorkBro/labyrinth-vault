/**
 * Swapping, and the one attack in this product that the vault cannot catch.
 *
 * ## Why a swap is different
 *
 * Everything else this app does ends at the vault's confirmation screen. The
 * wallet proposes, a person on a second device reads the destination and the
 * amount in full, and approves or does not. That screen is the security
 * boundary and it covers every ordinary payment.
 *
 * A swap has a second address in it that never appears in any transaction, and
 * therefore never appears on that screen.
 *
 * A swap is three addresses:
 *
 *   1. the **deposit** address, which belongs to the exchange. You send your
 *      coins there. This one the vault does see: it is the recipient of an
 *      ordinary send, rendered in full, approved by a person. Nothing new.
 *   2. the **payout** address, which is where the other coin comes back to.
 *      You hand it to the exchange over the network. It is in no transaction
 *      this device signs.
 *   3. the **refund** address, which is where your coins go if the trade
 *      fails. Same: handed over the network, in no transaction.
 *
 * So picture a compromised build of this app, or a hostile network between it
 * and the exchange. It quotes honestly, it shows you the deposit address, the
 * vault renders it, you read it, you approve it, everything matches, the money
 * moves exactly where the screen said it would. And the payout address that
 * went to the exchange was the attacker's. The swap completes. Your coins
 * arrive in somebody else's wallet, and every screen you were shown along the
 * way was telling the truth.
 *
 * The vault cannot help with that. It is not in the transaction.
 *
 * ## What this module does about it
 *
 * Two things, and they are the reason this file is more than a wrapper around
 * an exchange API.
 *
 * **The payout address is derived, never accepted.** When the far side of a
 * swap is a coin this wallet watches, the payout address comes from
 * `ownAddress` on the account descriptor the vault handed over. It is not
 * typed, not remembered from last time, not read out of the order. A person
 * can check it on the receive screen and on the vault, because both derive it
 * from the same account key.
 *
 * **The order is checked against the request.** `verifyOrder` compares what
 * the exchange sent back against what was asked for: the same payout address,
 * the same coins, the same amount within tolerance. A provider that echoes a
 * different payout address than the one it was given has either made a mistake
 * or been interfered with, and either way the answer is the same. There is no
 * `SwapState` a mismatch can reach that has a deposit address in it, so the
 * screen has nothing to display and no button to press. That is the same shape
 * as `verifySigned` in build.ts, for the same reason.
 *
 * ## What this module does not do
 *
 * It does not fetch. Every function here builds a request or parses a reply,
 * exactly like the rest of `core/`, and the transport is somebody else's
 * problem: `SwapTransport` is an argument. Today the only implementation is
 * the fixture in `demo.ts`, because this app has no network client at all yet
 * and pretending otherwise on the swap screen would be a lie in the one place
 * a lie costs the most.
 *
 * It also does not solve the privacy problem it creates, and that is stated on
 * the screen rather than buried here. Talking to an exchange from a phone
 * shows that exchange your IP address next to two addresses you own. A swap is
 * the least private thing this wallet can do. `PRIVACY_NOTE` is the sentence
 * the screen shows, and it is not optional decoration.
 *
 * The provider adapters are ported from the sibling project, where the same
 * request shapes and reply parsing have been in production against these APIs.
 * Only the keyless providers came across: this app has no server to keep an
 * API key on, and a key compiled into a phone app is a published key.
 */

import type { Asset } from './model';

// ---------------------------------------------------------------------------
// Coins

/** Which chain an address belongs to, which is all that is needed to check one. */
export type AddressFamily = 'xmr' | 'btc' | 'evm' | 'sol' | 'tron';

export interface SwapCoin {
  /** Unique per coin *and* network: USDT on Tron is not USDT on Ethereum. */
  id: string;
  /** The currency as the providers name it, shared across a coin's networks. */
  ticker: string;
  label: string;
  /** Network as Exolix names it. */
  network: string;
  /** Network as Godex names it. Godex happens to use the same codes Exolix
   *  does, and it is written out separately anyway: two providers agreeing
   *  today is not a promise, and the coin that breaks the coincidence would
   *  send somebody's USDT down the wrong chain. */
  gxNetwork: string;
  family: AddressFamily;
  /** Set when this wallet watches the coin, so a payout can be derived rather
   *  than typed. This is the field the whole module is arranged around. */
  ours: Asset | null;
}

export const SWAP_COINS: SwapCoin[] = [
  { id: 'btc', ticker: 'btc', label: 'Bitcoin', network: 'BTC', gxNetwork: 'BTC', family: 'btc', ours: 'BTC' },
  { id: 'xmr', ticker: 'xmr', label: 'Monero', network: 'XMR', gxNetwork: 'XMR', family: 'xmr', ours: 'XMR' },
  { id: 'usdttrc', ticker: 'usdt', label: 'USDT on Tron', network: 'TRX', gxNetwork: 'TRX', family: 'tron', ours: null },
  { id: 'usdteth', ticker: 'usdt', label: 'USDT on Ethereum', network: 'ETH', gxNetwork: 'ETH', family: 'evm', ours: null },
  { id: 'eth', ticker: 'eth', label: 'Ethereum', network: 'ETH', gxNetwork: 'ETH', family: 'evm', ours: null },
  { id: 'usdc', ticker: 'usdc', label: 'USDC on Ethereum', network: 'ETH', gxNetwork: 'ETH', family: 'evm', ours: null },
  { id: 'usdcsol', ticker: 'usdc', label: 'USDC on Solana', network: 'SOL', gxNetwork: 'SOL', family: 'sol', ours: null },
];

export function swapCoin(id: string): SwapCoin | null {
  return SWAP_COINS.find((c) => c.id === String(id ?? '')) ?? null;
}

/** The coins this wallet holds, which is what a swap can start from. */
export const OUR_COINS: SwapCoin[] = SWAP_COINS.filter((c) => c.ours !== null);

export type ProviderId = 'exolix' | 'godex';

export const PROVIDERS: { id: ProviderId; label: string; host: string }[] = [
  { id: 'exolix', label: 'Exolix', host: 'exolix.com' },
  { id: 'godex', label: 'Godex', host: 'godex.io' },
];

/**
 * The sentence the swap screen shows before anything else, every time.
 *
 * Not a first-run dialog that somebody dismisses once. A swap is the only
 * thing in this wallet that talks to a stranger about coins you own, and the
 * cost is the same on the hundredth swap as on the first.
 */
export const PRIVACY_NOTE =
  'A swap tells an exchange your IP address, the coin you are sending, and two ' +
  'addresses you own. That is the least private thing this wallet can do, and ' +
  'no amount of care on this screen changes it.';

// ---------------------------------------------------------------------------
// Pairs and amounts

export interface SwapPair {
  from: SwapCoin;
  to: SwapCoin;
}

export type PairResult = { ok: true; pair: SwapPair } | { ok: false; problem: string };

/**
 * The two coins of a swap, once both are real and the wallet holds the one
 * being sent.
 *
 * The "from must be ours" rule is not a limitation of the providers, which
 * will trade anything for anything. It is what this app is: a swap starts by
 * spending a coin the vault can sign for. A trade between two coins this
 * wallet does not hold has nothing to do with this device, and offering it
 * would mean building a screen whose only job is to be somebody else's
 * exchange front end.
 */
export function parsePair(fromId: unknown, toId: unknown): PairResult {
  const from = swapCoin(String(fromId ?? ''));
  const to = swapCoin(String(toId ?? ''));
  if (!from || !to) return { ok: false, problem: 'Unknown coin.' };
  if (from.id === to.id) return { ok: false, problem: 'Those are the same coin.' };
  if (from.ours === null) {
    return { ok: false, problem: 'A swap starts from a coin this wallet holds.' };
  }
  return { ok: true, pair: { from, to } };
}

/** A plain positive number. Real minimums and maximums belong to the provider. */
export function parseAmount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) return null;
  return n;
}

const ADDRESS_SHAPES: Record<AddressFamily, RegExp[]> = {
  // Standard and subaddress (95 characters, leading 4 or 8), integrated (106).
  xmr: [/^[48][1-9A-HJ-NP-Za-km-z]{94}$/, /^4[1-9A-HJ-NP-Za-km-z]{105}$/],
  btc: [/^bc1[a-z0-9]{8,87}$/, /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/],
  evm: [/^0x[0-9a-fA-F]{40}$/],
  sol: [/^[1-9A-HJ-NP-Za-km-z]{32,44}$/],
  tron: [/^T[1-9A-HJ-NP-Za-km-z]{33}$/],
};

/**
 * Does this address belong on that chain?
 *
 * Shape only. The provider validates properly and will refuse a bad one, and
 * `checkAddress` in addresses.ts does real checksum work for the two chains
 * this wallet watches. What this catches is the mistake that actually happens,
 * which is a right address for the wrong chain, and it catches it before an
 * order exists rather than after the money has moved.
 */
export function addressLooksRight(family: AddressFamily, text: string): boolean {
  const address = String(text ?? '').trim();
  return ADDRESS_SHAPES[family].some((shape) => shape.test(address));
}

export function addressHint(coin: SwapCoin): string {
  switch (coin.family) {
    case 'xmr': return 'a mainnet Monero address, starting 4 or 8';
    case 'btc': return 'a Bitcoin address, starting bc1, 1 or 3';
    case 'evm': return 'an Ethereum address, starting 0x';
    case 'sol': return 'a Solana address';
    case 'tron': return 'a Tron address, starting T';
  }
}

// ---------------------------------------------------------------------------
// The request, and where the payout address comes from

export interface SwapRequest {
  provider: ProviderId;
  pair: SwapPair;
  amount: number;
  /** Where the bought coin goes. Derived when the wallet holds that coin. */
  payoutAddress: string;
  /** Where the sent coin comes back to if the trade fails. Always ours. */
  refundAddress: string;
  /** True when `payoutAddress` was derived from the account key rather than
   *  typed. The screen shows the difference, because the difference is the
   *  whole risk. */
  payoutIsOurs: boolean;
}

export type RequestResult = { ok: true; request: SwapRequest } | { ok: false; problem: string };

/** What the caller must supply so a payout address can be derived, not typed. */
export interface OwnAddresses {
  /** An unused receive address for a coin this wallet watches, derived from
   *  the account key the vault handed over. Returns null when the wallet has
   *  no account for that asset. */
  receive(asset: Asset): string | null;
}

/**
 * Build a swap request, deriving every address that can be derived.
 *
 * `typedPayout` is only consulted when the destination coin is one this wallet
 * does not watch, and in that case the screen has already said out loud that
 * nothing on either device can check it. When the destination *is* ours,
 * anything typed is ignored rather than preferred, because "the user typed it"
 * is exactly the story an attacker wants a reviewer to accept.
 */
export function buildRequest(params: {
  provider: ProviderId;
  pair: SwapPair;
  amount: number;
  own: OwnAddresses;
  typedPayout?: string;
}): RequestResult {
  const { provider, pair, amount, own } = params;

  if (!PROVIDERS.some((p) => p.id === provider)) return { ok: false, problem: 'Unknown provider.' };
  if (parseAmount(amount) === null) return { ok: false, problem: 'That is not an amount.' };

  const refundAddress = own.receive(pair.from.ours!);
  if (!refundAddress) {
    return { ok: false, problem: `This wallet has no ${pair.from.label} account to refund to.` };
  }

  let payoutAddress: string;
  let payoutIsOurs: boolean;

  if (pair.to.ours !== null) {
    const derived = own.receive(pair.to.ours);
    if (!derived) {
      return { ok: false, problem: `Pair a ${pair.to.label} account before swapping into it.` };
    }
    payoutAddress = derived;
    payoutIsOurs = true;
  } else {
    const typed = String(params.typedPayout ?? '').trim();
    if (!typed) return { ok: false, problem: `Where should the ${pair.to.label} go?` };
    if (!addressLooksRight(pair.to.family, typed)) {
      return { ok: false, problem: `That is not ${addressHint(pair.to)}.` };
    }
    payoutAddress = typed;
    payoutIsOurs = false;
  }

  if (payoutAddress === refundAddress) {
    /* Only reachable by pairing one account and asking to swap a coin for
     * itself, which parsePair already refuses, or by an `own` implementation
     * returning the same string for two assets. The second is a bug worth
     * failing loudly on rather than sending an exchange a nonsense order. */
    return { ok: false, problem: 'The payout and refund addresses are the same.' };
  }

  return {
    ok: true,
    request: { provider, pair, amount, payoutAddress, refundAddress, payoutIsOurs },
  };
}

// ---------------------------------------------------------------------------
// Quotes, orders and status, normalized across providers

export interface SwapQuote {
  provider: ProviderId;
  ok: boolean;
  /** Estimated amount received, when ok. */
  toAmount?: number;
  minAmount?: number;
  maxAmount?: number;
  /** Why there is no quote, in words fit for a screen. */
  reason?: string;
}

export interface SwapOrder {
  provider: ProviderId;
  id: string;
  /** Where to send the coin being spent. This is what the vault will show. */
  depositAddress: string;
  /** An extra id or memo some chains need. Null for everything here today,
   *  carried through so that adding one cannot silently lose it. */
  depositExtra: string | null;
  depositAmount: number;
  /** Estimated amount out, as quoted at creation. */
  toAmount: number;
  /** The payout address the provider recorded. Echoed so it can be compared
   *  against the one that was sent, which is the point of the whole file. */
  payoutAddress: string;
}

export type SwapStage =
  | 'waiting'
  | 'confirming'
  | 'exchanging'
  | 'sending'
  | 'done'
  | 'refunded'
  | 'expired'
  | 'failed';

export interface SwapStatus {
  stage: SwapStage;
  /** The provider's own word for it. */
  raw: string;
  txId?: string;
}

export const STAGE_LINES: Record<SwapStage, string> = {
  waiting: 'WAITING FOR YOUR DEPOSIT',
  confirming: 'DEPOSIT SEEN, CONFIRMING',
  exchanging: 'EXCHANGING',
  sending: 'SENDING TO YOUR ADDRESS',
  done: 'DONE',
  refunded: 'REFUNDED',
  expired: 'EXPIRED WITH NOTHING RECEIVED',
  failed: 'FAILED',
};

// ---------------------------------------------------------------------------
// Verifying the order against the request

export type OrderCheck =
  | { ok: true; order: SwapOrder }
  | { ok: false; problem: string; detail: string };

/**
 * How far the quoted output may drift between quote and order.
 *
 * Rates move, and a provider that requotes a fraction of a percent lower
 * between two calls a second apart is behaving normally. A provider that
 * comes back with half is not. Ten percent is loose enough never to fire on
 * ordinary movement and tight enough that "the rate changed" cannot be used to
 * explain away an order for a different trade entirely.
 */
export const RATE_TOLERANCE = 0.1;

/**
 * Compare what came back against what was asked for.
 *
 * This is `verifySigned`'s sibling. The signed-transaction check exists
 * because the thing that broadcasts is this device; this one exists because
 * the payout address is never in a transaction and so no other check in the
 * system covers it.
 *
 * A failure here is terminal by construction: the caller gets no `SwapOrder`,
 * and a deposit address is the one thing a `SwapOrder` carries. There is
 * nothing for a screen to display and nothing for a person to send coins to,
 * which is a better guarantee than a warning somebody can scroll past.
 */
export function verifyOrder(request: SwapRequest, order: SwapOrder, quotedOut: number): OrderCheck {
  const fail = (problem: string, detail: string): OrderCheck => ({ ok: false, problem, detail });

  if (order.provider !== request.provider) {
    return fail(
      'That order came from a different exchange.',
      `asked ${request.provider}, answered ${order.provider}`,
    );
  }

  if (order.payoutAddress !== request.payoutAddress) {
    return fail(
      'The exchange recorded a different payout address than the one it was given.',
      `sent ${request.payoutAddress}, recorded ${order.payoutAddress}`,
    );
  }

  if (!order.depositAddress || !addressLooksRight(request.pair.from.family, order.depositAddress)) {
    return fail(
      `The deposit address is not ${addressHint(request.pair.from)}.`,
      order.depositAddress || '(empty)',
    );
  }

  if (order.depositAddress === request.payoutAddress) {
    /* An exchange asking you to deposit to the same address it will pay out
     * to is either broken or arranging for you to pay yourself while it keeps
     * the coins. Neither is a trade. */
    return fail(
      'The deposit and payout addresses are the same.',
      order.depositAddress,
    );
  }

  if (!Number.isFinite(order.depositAmount) || Math.abs(order.depositAmount - request.amount) > 1e-8) {
    return fail(
      'The order is for a different amount than the one requested.',
      `asked ${request.amount}, order says ${order.depositAmount}`,
    );
  }

  if (!Number.isFinite(order.toAmount) || order.toAmount <= 0) {
    return fail('The order does not say what it pays out.', String(order.toAmount));
  }

  if (Number.isFinite(quotedOut) && quotedOut > 0) {
    const drift = Math.abs(order.toAmount - quotedOut) / quotedOut;
    if (drift > RATE_TOLERANCE) {
      return fail(
        'The order pays out a very different amount than the quote.',
        `quoted ${quotedOut}, order says ${order.toAmount}`,
      );
    }
  }

  if (!order.id) return fail('The order has no reference to track it by.', '(empty)');

  return { ok: true, order };
}

// ---------------------------------------------------------------------------
// Provider adapters
//
// Ported from the sibling project, where these request shapes and this reply
// parsing have run against the live APIs. Nothing here fetches: each function
// builds a request or reads a reply, and `SwapTransport` moves the bytes.
//
// Only the keyless providers came across. This app has no server to hold an
// API key on, and a key compiled into a phone app is a published key.

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  body?: Record<string, unknown>;
}

/** Whatever actually performs a request. Injected, never imported. */
export interface SwapTransport {
  send(request: HttpRequest): Promise<unknown>;
}

const number = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : NaN;
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

// ---- Exolix ---------------------------------------------------------------

export function exolixRate(pair: SwapPair, amount: number): HttpRequest {
  const query = new URLSearchParams({
    coinFrom: pair.from.ticker.toUpperCase(),
    networkFrom: pair.from.network,
    coinTo: pair.to.ticker.toUpperCase(),
    networkTo: pair.to.network,
    amount: String(amount),
    rateType: 'float',
  });
  return { method: 'GET', url: `https://exolix.com/api/v2/rate?${query}` };
}

export function parseExolixRate(json: unknown): SwapQuote {
  const body = (json ?? {}) as Record<string, unknown>;
  const toAmount = number(body['toAmount']);
  const min = number(body['minAmount']);
  const max = number(body['maxAmount']);
  if (!Number.isFinite(toAmount) || toAmount <= 0) {
    const message = text(body['message']) || text(body['error']);
    return {
      provider: 'exolix',
      ok: false,
      reason: message || 'No rate for that pair and amount.',
      ...(Number.isFinite(min) ? { minAmount: min } : {}),
      ...(Number.isFinite(max) ? { maxAmount: max } : {}),
    };
  }
  return {
    provider: 'exolix',
    ok: true,
    toAmount,
    ...(Number.isFinite(min) ? { minAmount: min } : {}),
    ...(Number.isFinite(max) ? { maxAmount: max } : {}),
  };
}

export function exolixCreate(request: SwapRequest): HttpRequest {
  return {
    method: 'POST',
    url: 'https://exolix.com/api/v2/transactions',
    body: {
      coinFrom: request.pair.from.ticker.toUpperCase(),
      networkFrom: request.pair.from.network,
      coinTo: request.pair.to.ticker.toUpperCase(),
      networkTo: request.pair.to.network,
      amount: request.amount,
      withdrawalAddress: request.payoutAddress,
      refundAddress: request.refundAddress,
      rateType: 'float',
    },
  };
}

export function parseExolixCreate(json: unknown): SwapOrder | null {
  const body = (json ?? {}) as Record<string, unknown>;
  const id = text(body['id']);
  const depositAddress = text(body['depositAddress']);
  const amount = number(body['amount']);
  const toAmount = number(body['amountTo']);
  const payoutAddress = text(body['withdrawalAddress']);
  if (!id || !depositAddress || !payoutAddress) return null;
  return {
    provider: 'exolix',
    id,
    depositAddress,
    depositExtra: text(body['depositExtraId']) || null,
    depositAmount: amount,
    toAmount,
    payoutAddress,
  };
}

export function exolixStatus(id: string): HttpRequest {
  return { method: 'GET', url: `https://exolix.com/api/v2/transactions/${encodeURIComponent(id)}` };
}

export function parseExolixStatus(json: unknown): SwapStatus {
  const body = (json ?? {}) as Record<string, unknown>;
  const raw = text(body['status']).toLowerCase();
  const hash = text((body['hashOut'] as Record<string, unknown> | undefined)?.['hash']);
  const stage: SwapStage =
    raw === 'wait' ? 'waiting'
    : raw === 'confirmation' ? 'confirming'
    : raw === 'exchanging' ? 'exchanging'
    : raw === 'sending' ? 'sending'
    : raw === 'success' ? 'done'
    : raw === 'refunded' ? 'refunded'
    : raw === 'overdue' ? 'expired'
    : 'failed';
  return { stage, raw: raw || 'unknown', ...(hash ? { txId: hash } : {}) };
}

// ---- Godex ----------------------------------------------------------------

export function godexRate(pair: SwapPair, amount: number): HttpRequest {
  return {
    method: 'POST',
    url: 'https://api.godex.io/api/v1/info',
    body: {
      from: pair.from.ticker.toUpperCase(),
      to: pair.to.ticker.toUpperCase(),
      amount: String(amount),
      coin_from_network: pair.from.gxNetwork,
      coin_to_network: pair.to.gxNetwork,
    },
  };
}

export function parseGodexRate(json: unknown): SwapQuote {
  const body = (json ?? {}) as Record<string, unknown>;
  const toAmount = number(body['amount']);
  const min = number(body['min_amount']);
  const max = number(body['max_amount']);
  if (!Number.isFinite(toAmount) || toAmount <= 0) {
    const message = text(body['error']) || text(body['message']);
    return {
      provider: 'godex',
      ok: false,
      reason: message || 'No rate for that pair and amount.',
      ...(Number.isFinite(min) ? { minAmount: min } : {}),
      ...(Number.isFinite(max) ? { maxAmount: max } : {}),
    };
  }
  return {
    provider: 'godex',
    ok: true,
    toAmount,
    ...(Number.isFinite(min) ? { minAmount: min } : {}),
    ...(Number.isFinite(max) ? { maxAmount: max } : {}),
  };
}

export function godexCreate(request: SwapRequest): HttpRequest {
  return {
    method: 'POST',
    url: 'https://api.godex.io/api/v1/transaction',
    body: {
      coin_from: request.pair.from.ticker.toUpperCase(),
      coin_to: request.pair.to.ticker.toUpperCase(),
      deposit_amount: String(request.amount),
      withdrawal: request.payoutAddress,
      return: request.refundAddress,
      coin_from_network: request.pair.from.gxNetwork,
      coin_to_network: request.pair.to.gxNetwork,
    },
  };
}

export function parseGodexCreate(json: unknown): SwapOrder | null {
  const body = (json ?? {}) as Record<string, unknown>;
  const id = text(body['transaction_id']);
  const depositAddress = text(body['deposit']);
  const payoutAddress = text(body['withdrawal']);
  if (!id || !depositAddress || !payoutAddress) return null;
  return {
    provider: 'godex',
    id,
    depositAddress,
    depositExtra: text(body['deposit_extra_id']) || null,
    depositAmount: number(body['deposit_amount']),
    toAmount: number(body['withdrawal_amount']),
    payoutAddress,
  };
}

export function godexStatus(id: string): HttpRequest {
  return {
    method: 'GET',
    url: `https://api.godex.io/api/v1/transaction/${encodeURIComponent(id)}`,
  };
}

export function parseGodexStatus(json: unknown): SwapStatus {
  const body = (json ?? {}) as Record<string, unknown>;
  const raw = text(body['status']).toLowerCase();
  const hash = text(body['hash_out']);
  const stage: SwapStage =
    raw === 'wait' ? 'waiting'
    : raw === 'confirmation' || raw === 'confirming' ? 'confirming'
    : raw === 'exchanging' ? 'exchanging'
    : raw === 'sending' ? 'sending'
    : raw === 'success' ? 'done'
    : raw === 'refunded' ? 'refunded'
    : raw === 'overdue' || raw === 'expired' ? 'expired'
    : 'failed';
  return { stage, raw: raw || 'unknown', ...(hash ? { txId: hash } : {}) };
}

// ---------------------------------------------------------------------------
// The two calls a screen makes

const RATE: Record<ProviderId, (pair: SwapPair, amount: number) => HttpRequest> = {
  exolix: exolixRate,
  godex: godexRate,
};
const PARSE_RATE: Record<ProviderId, (json: unknown) => SwapQuote> = {
  exolix: parseExolixRate,
  godex: parseGodexRate,
};
const CREATE: Record<ProviderId, (request: SwapRequest) => HttpRequest> = {
  exolix: exolixCreate,
  godex: godexCreate,
};
const PARSE_CREATE: Record<ProviderId, (json: unknown) => SwapOrder | null> = {
  exolix: parseExolixCreate,
  godex: parseGodexCreate,
};
const STATUS: Record<ProviderId, (id: string) => HttpRequest> = {
  exolix: exolixStatus,
  godex: godexStatus,
};
const PARSE_STATUS: Record<ProviderId, (json: unknown) => SwapStatus> = {
  exolix: parseExolixStatus,
  godex: parseGodexStatus,
};

/** Ask every provider at once. A provider that throws is a provider without a
 *  quote, not a failed screen. */
export async function quoteAll(
  transport: SwapTransport,
  pair: SwapPair,
  amount: number,
): Promise<SwapQuote[]> {
  return Promise.all(
    PROVIDERS.map(async ({ id }) => {
      try {
        return PARSE_RATE[id](await transport.send(RATE[id](pair, amount)));
      } catch (error) {
        return { provider: id, ok: false, reason: (error as Error)?.message ?? 'No answer.' };
      }
    }),
  );
}

/**
 * Create an order, and refuse to return one that does not match the request.
 *
 * The verification is inside this function rather than beside it so that there
 * is no call site which can obtain an unchecked order. A caller cannot forget
 * to check, because there is no path that hands one over unchecked.
 */
export async function createOrder(
  transport: SwapTransport,
  request: SwapRequest,
  quotedOut: number,
): Promise<OrderCheck> {
  let json: unknown;
  try {
    json = await transport.send(CREATE[request.provider](request));
  } catch (error) {
    return {
      ok: false,
      problem: 'The exchange did not answer.',
      detail: (error as Error)?.message ?? 'no answer',
    };
  }
  const order = PARSE_CREATE[request.provider](json);
  if (!order) {
    return { ok: false, problem: 'The exchange sent back something unreadable.', detail: 'unparseable' };
  }
  return verifyOrder(request, order, quotedOut);
}

export async function readStatus(
  transport: SwapTransport,
  provider: ProviderId,
  id: string,
): Promise<SwapStatus> {
  try {
    return PARSE_STATUS[provider](await transport.send(STATUS[provider](id)));
  } catch (error) {
    return { stage: 'failed', raw: (error as Error)?.message ?? 'no answer' };
  }
}
