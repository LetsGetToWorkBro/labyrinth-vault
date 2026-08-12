/**
 * The swap, and mostly the one thing about it that is dangerous.
 *
 * Every other payment this wallet makes is covered by the vault's confirmation
 * screen: a person reads the destination and the amount on a second device and
 * approves them. A swap has an address in it that is in no transaction, so it
 * appears on no confirmation screen, and no amount of care on the vault can
 * check it. That is the payout address, and most of this file is about it.
 *
 * The shape of the attack, stated once so the tests below read as what they
 * are: a compromised build quotes honestly, shows the real deposit address,
 * lets the vault render it, and hands the exchange its own payout address. The
 * deposit goes exactly where the screen said. The proceeds do not come back.
 * Every screen along the way was telling the truth.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PROVIDER_CHAINS,
  PROVIDERS,
  PRIVACY_NOTE,
  RATE_TOLERANCE,
  STAGE_LINES,
  SWAP_COINS,
  addressHint,
  addressLooksRight,
  buildRequest,
  createOrder,
  exolixCreate,
  godexCreate,
  parseAmount,
  parseExolixCreate,
  parseExolixRate,
  parseExolixStatus,
  parseGodexCreate,
  parseGodexRate,
  parseGodexStatus,
  parsePair,
  providerChain,
  providerHandles,
  quoteAll,
  readStatus,
  swapCoin,
  verifyOrder,
  type HttpRequest,
  type OwnAddresses,
  type SwapOrder,
  type SwapRequest,
  type SwapTransport,
} from '../src/core/swap';

/** Addresses this wallet would derive. Fixed so a diff is readable. */
const OUR_BTC = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const OUR_XMR =
  '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
/** Somebody else's. This is what a compromised build would substitute. */
const THEIR_XMR =
  '48daf1rG3hE1Txapcsxh6WXNe9MLNKtu7W7tKTivtSoVLHErYzvdcpea2nSTgGkz66RFP4GKVAsTV14v6G3Ct8ZmDXamzuF';
const THEIR_EVM = '0x1234567890abcdef1234567890abcdef12345678';

const own: OwnAddresses = {
  receive: (asset) => (asset === 'BTC' ? OUR_BTC : OUR_XMR),
};

/** The ordinary happy request: Bitcoin out, Monero back to an address we own. */
function btcToXmr(): SwapRequest {
  const pair = parsePair('btc', 'xmr');
  expect(pair.ok).toBe(true);
  const built = buildRequest({
    provider: 'exolix',
    pair: (pair as Extract<typeof pair, { ok: true }>).pair,
    amount: 0.05,
    own,
  });
  expect(built.ok, (built as { problem?: string }).problem).toBe(true);
  return (built as Extract<typeof built, { ok: true }>).request;
}

function orderFor(request: SwapRequest, overrides: Partial<SwapOrder> = {}): SwapOrder {
  return {
    provider: request.provider,
    id: 'ord_123456',
    depositAddress: 'bc1qexchangedepositaddresswhichisnotours00000',
    depositExtra: null,
    depositAmount: request.amount,
    toAmount: 7.5,
    payoutAddress: request.payoutAddress,
    ...overrides,
  };
}

describe('what a swap is allowed to be', () => {
  it('starts from a coin this wallet holds', () => {
    expect(parsePair('btc', 'xmr').ok).toBe(true);
    expect(parsePair('xmr', 'usdt-tron').ok).toBe(true);
    const notOurs = parsePair('usdt-tron', 'eth');
    expect(notOurs.ok).toBe(false);
    expect((notOurs as { problem: string }).problem).toMatch(/wallet holds/);
  });

  it('refuses a coin for itself, and coins that do not exist', () => {
    expect(parsePair('btc', 'btc').ok).toBe(false);
    expect(parsePair('btc', 'dogecoin').ok).toBe(false);
    expect(swapCoin('nonsense')).toBeNull();
  });

  it('keeps a coin and its network together', () => {
    /* USDT on Tron and USDT on Ethereum share a ticker and are different
     * coins. Treating them as one is how somebody's money goes down a chain
     * their wallet cannot read. */
    const tron = swapCoin('usdt-tron')!;
    const ethereum = swapCoin('usdt-eth')!;
    expect(tron.ticker).toBe(ethereum.ticker);
    expect(tron.id).not.toBe(ethereum.id);
    expect(tron.family).not.toBe(ethereum.family);
    const ids = SWAP_COINS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('takes an amount only when it is one', () => {
    expect(parseAmount('0.05')).toBe(0.05);
    for (const bad of ['', 'abc', '0', '-1', 'Infinity', '1e12', null, undefined]) {
      expect(parseAmount(bad), String(bad)).toBeNull();
    }
  });
});

describe('the payout address is derived, never accepted', () => {
  /* The heart of it. When the far side of a swap is a coin this wallet
   * watches, the address comes from the account key the vault handed over. */

  it('derives it when the destination is ours', () => {
    const request = btcToXmr();
    expect(request.payoutAddress).toBe(OUR_XMR);
    expect(request.payoutIsOurs).toBe(true);
  });

  it('ignores a typed address when it could derive one', () => {
    /* "The user typed it" is exactly the story an attacker wants a reviewer to
     * accept. If the wallet can derive the address, what was typed is not
     * preferred and not merged: it is ignored. */
    const pair = parsePair('btc', 'xmr') as Extract<ReturnType<typeof parsePair>, { ok: true }>;
    const built = buildRequest({
      provider: 'exolix',
      pair: pair.pair,
      amount: 0.05,
      own,
      typedPayout: THEIR_XMR,
    });
    expect(built.ok).toBe(true);
    expect((built as Extract<typeof built, { ok: true }>).request.payoutAddress).toBe(OUR_XMR);
  });

  it('always refunds to an address of ours', () => {
    const request = btcToXmr();
    expect(request.refundAddress).toBe(OUR_BTC);
  });

  it('accepts a typed address only for a coin it cannot derive, and says so', () => {
    const pair = parsePair('xmr', 'usdt-tron') as Extract<ReturnType<typeof parsePair>, { ok: true }>;
    const built = buildRequest({
      provider: 'exolix',
      pair: pair.pair,
      amount: 2,
      own,
      typedPayout: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KNGtGz',
    });
    expect(built.ok).toBe(true);
    const request = (built as Extract<typeof built, { ok: true }>).request;
    expect(request.payoutIsOurs, 'the screen has to be able to say this is unchecked').toBe(false);
  });

  it('refuses a typed address of the wrong shape for its chain', () => {
    const pair = parsePair('xmr', 'usdt-tron') as Extract<ReturnType<typeof parsePair>, { ok: true }>;
    const built = buildRequest({
      provider: 'exolix',
      pair: pair.pair,
      amount: 2,
      own,
      // An Ethereum address for a Tron payout: the mistake that actually happens.
      typedPayout: THEIR_EVM,
    });
    expect(built.ok).toBe(false);
    expect((built as { problem: string }).problem).toMatch(/Tron/);
  });

  it('refuses to swap into a coin with no account paired', () => {
    const bare: OwnAddresses = { receive: (asset) => (asset === 'BTC' ? OUR_BTC : null) };
    const pair = parsePair('btc', 'xmr') as Extract<ReturnType<typeof parsePair>, { ok: true }>;
    const built = buildRequest({ provider: 'exolix', pair: pair.pair, amount: 0.05, own: bare });
    expect(built.ok).toBe(false);
    expect((built as { problem: string }).problem).toMatch(/Pair a Monero account/);
  });
});

describe('the order is checked against the request', () => {
  const request = btcToXmr();

  it('accepts an order that matches', () => {
    expect(verifyOrder(request, orderFor(request), 7.5).ok).toBe(true);
  });

  it('refuses an order whose payout address is not the one we sent', () => {
    // The attack, in one assertion.
    const swapped = verifyOrder(request, orderFor(request, { payoutAddress: THEIR_XMR }), 7.5);
    expect(swapped.ok).toBe(false);
    expect((swapped as { problem: string }).problem).toMatch(/different payout address/);
  });

  it('gives back no order at all when it refuses, so there is nothing to deposit to', () => {
    /* The structural half of the guarantee. A refusal is not a warning beside
     * a deposit address; there is no deposit address, because there is no
     * order. Nothing for a screen to render and nothing to send coins to. */
    const refused = verifyOrder(request, orderFor(request, { payoutAddress: THEIR_XMR }), 7.5);
    expect('order' in refused).toBe(false);
  });

  it('refuses an order for a different amount', () => {
    const wrong = verifyOrder(request, orderFor(request, { depositAmount: 0.5 }), 7.5);
    expect(wrong.ok).toBe(false);
    expect((wrong as { problem: string }).problem).toMatch(/different amount/);
  });

  it('refuses an order from a provider we did not ask', () => {
    const wrong = verifyOrder(request, orderFor(request, { provider: 'godex' }), 7.5);
    expect(wrong.ok).toBe(false);
  });

  it('refuses a deposit address on the wrong chain', () => {
    const wrong = verifyOrder(request, orderFor(request, { depositAddress: THEIR_XMR }), 7.5);
    expect(wrong.ok).toBe(false);
    expect((wrong as { problem: string }).problem).toMatch(/Bitcoin address/);
  });

  it('refuses when the deposit address is the payout address', () => {
    const pair = parsePair('btc', 'btc');
    expect(pair.ok, 'a coin for itself is refused earlier').toBe(false);
    // Constructed directly, because the ordinary path cannot produce it.
    const same = verifyOrder(request, orderFor(request, { depositAddress: request.payoutAddress }), 7.5);
    expect(same.ok).toBe(false);
  });

  it('tolerates a moved rate and refuses a different trade', () => {
    /* Rates move between the quote and the order, and a provider requoting a
     * fraction lower is behaving normally. One coming back with half is not. */
    const nudged = verifyOrder(request, orderFor(request, { toAmount: 7.5 * (1 - RATE_TOLERANCE / 2) }), 7.5);
    expect(nudged.ok).toBe(true);
    const halved = verifyOrder(request, orderFor(request, { toAmount: 3.5 }), 7.5);
    expect(halved.ok).toBe(false);
    expect((halved as { problem: string }).problem).toMatch(/very different amount/);
  });

  it('refuses an order with nothing to track it by', () => {
    expect(verifyOrder(request, orderFor(request, { id: '' }), 7.5).ok).toBe(false);
  });

  it('says what it saw, so a person can tell a bug from an attack', () => {
    const swapped = verifyOrder(request, orderFor(request, { payoutAddress: THEIR_XMR }), 7.5);
    expect((swapped as { detail: string }).detail).toContain(OUR_XMR);
    expect((swapped as { detail: string }).detail).toContain(THEIR_XMR);
  });
});

describe('there is no unchecked path to an order', () => {
  /* `createOrder` verifies inside itself rather than beside itself, so a
   * caller cannot forget. This is the test that would fail if somebody
   * "simplified" it by exporting the raw create call. */

  const request = btcToXmr();

  function transportReturning(json: unknown): SwapTransport {
    return { send: async () => json };
  }

  it('refuses an order the exchange answered with a substituted payout', async () => {
    const hostile = transportReturning({
      id: 'ord_1',
      depositAddress: 'bc1qexchangedepositaddresswhichisnotours00000',
      amount: 0.05,
      amountTo: 7.5,
      withdrawalAddress: THEIR_XMR,
    });
    const result = await createOrder(hostile, request, 7.5);
    expect(result.ok).toBe(false);
    expect('order' in result).toBe(false);
  });

  it('passes an honest one through', async () => {
    const honest = transportReturning({
      id: 'ord_1',
      depositAddress: 'bc1qexchangedepositaddresswhichisnotours00000',
      amount: 0.05,
      amountTo: 7.5,
      withdrawalAddress: OUR_XMR,
    });
    const result = await createOrder(honest, request, 7.5);
    expect(result.ok, (result as { problem?: string }).problem).toBe(true);
  });

  it('turns an unreachable exchange into a refusal, not an exception', async () => {
    const dead: SwapTransport = {
      send: async () => {
        throw new Error('offline');
      },
    };
    const result = await createOrder(dead, request, 7.5);
    expect(result.ok).toBe(false);
    expect((result as { detail: string }).detail).toContain('offline');
  });

  it('turns an unreadable answer into a refusal', async () => {
    const result = await createOrder(transportReturning({ nonsense: true }), request, 7.5);
    expect(result.ok).toBe(false);
    expect((result as { problem: string }).problem).toMatch(/unreadable/);
  });
});

describe('the provider adapters', () => {
  it('never send a key, because there is nowhere to keep one', () => {
    /* A key compiled into a phone app is a published key. Only the keyless
     * providers came across from the sibling project, and this fails if one
     * that needs a key is added without somewhere to keep it. */
    expect(PROVIDERS.map((p) => p.id).sort()).toEqual(['exolix', 'godex']);
    const request = btcToXmr();
    for (const built of [exolixCreate(request), godexCreate({ ...request, provider: 'godex' })]) {
      const serialized = JSON.stringify(built);
      expect(serialized).not.toMatch(/api[_-]?key/i);
      expect(serialized).not.toMatch(/token/i);
    }
  });

  it('put both of our addresses in every create call', () => {
    const request = btcToXmr();
    for (const built of [exolixCreate(request), godexCreate({ ...request, provider: 'godex' })]) {
      const serialized = JSON.stringify(built.body);
      expect(serialized).toContain(OUR_XMR);
      expect(serialized).toContain(OUR_BTC);
    }
  });

  it('carry the network, not just the ticker', () => {
    /* USDT is a ticker on four chains. An order that names the ticker and not
     * the network is an order that can be filled on the wrong one. */
    const pair = parsePair('xmr', 'usdt-tron') as Extract<ReturnType<typeof parsePair>, { ok: true }>;
    const built = buildRequest({
      provider: 'exolix',
      pair: pair.pair,
      amount: 2,
      own,
      typedPayout: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KNGtGz',
    });
    const request = (built as Extract<typeof built, { ok: true }>).request;
    expect(JSON.stringify(exolixCreate(request).body)).toContain('TRX');
    expect(JSON.stringify(godexCreate({ ...request, provider: 'godex' }).body)).toContain('TRX');
  });

  it('read a rate, and read a refusal as a refusal', () => {
    expect(parseExolixRate({ toAmount: 7.5, minAmount: 0.01 })).toMatchObject({ ok: true, toAmount: 7.5 });
    expect(parseGodexRate({ amount: '7.5', min_amount: '0.01' })).toMatchObject({ ok: true, toAmount: 7.5 });
    for (const empty of [{}, null, { toAmount: 0 }, { message: 'amount too small', minAmount: 0.1 }]) {
      expect(parseExolixRate(empty).ok, JSON.stringify(empty)).toBe(false);
    }
    // A refusal that knows the minimum passes it along, because that is the
    // one thing that tells somebody what to do next.
    expect(parseExolixRate({ message: 'too small', minAmount: 0.1 }).minAmount).toBe(0.1);
  });

  it('return null rather than a half-built order', () => {
    for (const partial of [{}, null, { id: 'x' }, { id: 'x', depositAddress: 'y' }]) {
      expect(parseExolixCreate(partial), JSON.stringify(partial)).toBeNull();
      expect(parseGodexCreate(partial), JSON.stringify(partial)).toBeNull();
    }
  });

  it('map every status either provider can report', () => {
    expect(parseExolixStatus({ status: 'wait' }).stage).toBe('waiting');
    expect(parseExolixStatus({ status: 'success', hashOut: { hash: 'abc' } })).toMatchObject({
      stage: 'done',
      txId: 'abc',
    });
    expect(parseExolixStatus({ status: 'overdue' }).stage).toBe('expired');
    expect(parseGodexStatus({ status: 'refunded' }).stage).toBe('refunded');
    // Anything unrecognized is a failure, not a silent "probably fine".
    expect(parseExolixStatus({ status: 'something new' }).stage).toBe('failed');
    expect(parseGodexStatus({}).stage).toBe('failed');
    // And every stage has words for a screen.
    for (const stage of Object.keys(STAGE_LINES)) expect(STAGE_LINES[stage as never]).toBeTruthy();
  });

  it('never build a request to anywhere but the two providers', () => {
    const request = btcToXmr();
    const requests: HttpRequest[] = [
      exolixCreate(request),
      godexCreate({ ...request, provider: 'godex' }),
    ];
    for (const built of requests) {
      expect(built.url).toMatch(/^https:\/\/(exolix\.com|api\.godex\.io)\//);
    }
  });
});

describe('asking both providers at once', () => {
  it('lets a provider fail without failing the screen', async () => {
    const flaky: SwapTransport = {
      send: async (request) => {
        if (request.url.includes('godex')) throw new Error('down');
        return { toAmount: 7.5 };
      },
    };
    const pair = parsePair('btc', 'xmr') as Extract<ReturnType<typeof parsePair>, { ok: true }>;
    const quotes = await quoteAll(flaky, pair.pair, 0.05);
    expect(quotes).toHaveLength(2);
    expect(quotes.find((q) => q.provider === 'exolix')!.ok).toBe(true);
    const dead = quotes.find((q) => q.provider === 'godex')!;
    expect(dead.ok).toBe(false);
    expect(dead.reason).toContain('down');
  });

  it('reports a status it could not fetch as failed rather than as done', async () => {
    const dead: SwapTransport = {
      send: async () => {
        throw new Error('offline');
      },
    };
    expect((await readStatus(dead, 'exolix', 'ord_1')).stage).toBe('failed');
  });
});

describe('what the screen has to say out loud', () => {
  it('has a privacy note that names what leaks', () => {
    expect(PRIVACY_NOTE).toMatch(/IP address/);
    expect(PRIVACY_NOTE).toMatch(/addresses you own/);
    // Not a promise that care fixes it, because care does not.
    expect(PRIVACY_NOTE).toMatch(/no amount of care/i);
  });

  it('has a hint for every chain it will accept an address for', () => {
    for (const coin of SWAP_COINS) {
      expect(addressHint(coin), coin.id).toBeTruthy();
      expect(addressLooksRight(coin.family, 'obviously not an address')).toBe(false);
    }
    expect(addressLooksRight('btc', OUR_BTC)).toBe(true);
    expect(addressLooksRight('xmr', OUR_XMR)).toBe(true);
    // The mistake this actually catches: right address, wrong chain.
    expect(addressLooksRight('btc', OUR_XMR)).toBe(false);
    expect(addressLooksRight('tron', THEIR_EVM)).toBe(false);
  });
});

describe('a swap deposit is an ordinary payment, checked by reading the source', () => {
  /* The structural claim, and the one worth guarding by grep because it is
   * about what the code does *not* contain.
   *
   * A swap deposit is a send to an address. It has to go through compose,
   * prepare, the vault and the confirmation screen like any other, because the
   * deposit address is the one part of a swap the vault can actually check. The
   * moment the swap screen gets its own quiet path to a signature, that check
   * is gone and nothing in a test of `core/swap.ts` would notice.
   */

  const screen = readFileSync('src/screens/Swap.tsx', 'utf8');
  const store = readFileSync('src/state/store.tsx', 'utf8');

  it('hands off to the send flow rather than signing anything itself', () => {
    expect(screen).toMatch(/depositForSwap\(/);
    expect(screen).toMatch(/navigation\.navigate\('Send'\)/);
    // Nothing on this screen may reach for the signing machinery directly.
    for (const forbidden of ['prepareDraft', 'offerSignature', 'broadcast', 'beginTransmit']) {
      expect(screen, `Swap.tsx calls ${forbidden}`).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  it('routes the deposit through compose, so the vault renders the address', () => {
    const handoff = /const depositForSwap[\s\S]*?\n  \);/.exec(store)?.[0] ?? '';
    expect(handoff, 'depositForSwap not found in the store').toBeTruthy();
    expect(handoff).toMatch(/type: 'recipient'/);
    expect(handoff).toMatch(/type: 'amount'/);
    expect(handoff, 'it must not jump the session past compose').not.toMatch(/step:/);
  });

  it('derives the payout address from the snapshot, never from a field', () => {
    /* The store's `own` is the only implementation the screen is given, and it
     * reads addresses out of the chain snapshot: the same ones the receive
     * screen shows, from the account key the vault handed over. */
    const derived = /const own: OwnAddresses[\s\S]*?\n  \);/.exec(store)?.[0] ?? '';
    expect(derived, 'own not found in the store').toBeTruthy();
    expect(derived).toMatch(/snapshot\.assets/);
    expect(derived).not.toMatch(/useState|typed|input/i);
  });

  it('offers a field only where one is unavoidable', () => {
    /* A field is somewhere to paste an attacker's address. The derived case
     * has none, because the whole point of deriving is that there is nothing
     * to paste; the external case has one, because there is no other way to
     * name an address on a chain this wallet does not watch.
     *
     * Split at the early return so the two branches are compared separately.
     * A whole-file grep for TextInput passes whichever branch it is in, which
     * is the failure this test exists to avoid. */
    const block = /function PayoutBlock[\s\S]*$/.exec(screen)?.[0] ?? '';
    expect(block, 'PayoutBlock not found').toBeTruthy();
    const split = block.indexOf('  return (', block.indexOf('THIS ADDRESS IS YOURS'));
    expect(split, 'the two branches could not be told apart').toBeGreaterThan(-1);
    const derived = block.slice(0, split);
    const external = block.slice(split);

    expect(derived, 'the derived payout address has a field to paste into').not.toMatch(/TextInput/);
    expect(derived).toMatch(/THIS ADDRESS IS YOURS/);
    expect(external, 'the external case has no way to enter an address').toMatch(/TextInput/);
    expect(external).toMatch(/NOTHING CAN CHECK THIS ADDRESS/);
  });

  it('marks the case nothing can check', () => {
    expect(screen).toMatch(/NOTHING CAN CHECK THIS ADDRESS/);
  });

  it('says the quotes are a fixture, because they are', () => {
    expect(screen).toMatch(/DEMO DATA/);
  });
});

describe('the coin catalog, and the chain tables that translate it', () => {
  /* The catalog is small on purpose and every entry was read from a provider's
   * own live currency endpoint. These are the checks that keep it that way:
   * a typo in a chain table is a request for a network the exchange has never
   * heard of, and the honest failure mode for that is an order that cannot be
   * filled after somebody has already chosen. */

  it('names every coin once', () => {
    const ids = SWAP_COINS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers the five assets that carry the volume, and nothing invented', () => {
    const tickers = new Set(SWAP_COINS.map((c) => c.ticker));
    expect([...tickers].sort()).toEqual(['btc', 'eth', 'usdc', 'usdt', 'xmr']);
  });

  it('holds only native Bitcoin and native Monero', () => {
    /* Both exchanges list wrapped BTC and wrapped XMR under the native
     * ticker. They are somebody else's IOU, and a person choosing "Monero"
     * must not be able to land on a Solana token by that name. */
    const btc = SWAP_COINS.filter((c) => c.ticker === 'btc');
    const xmr = SWAP_COINS.filter((c) => c.ticker === 'xmr');
    expect(btc.map((c) => c.chain)).toEqual(['bitcoin']);
    expect(xmr.map((c) => c.chain)).toEqual(['monero']);
  });

  it('is the only thing the wallet itself holds', () => {
    const ours = SWAP_COINS.filter((c) => c.ours !== null).map((c) => c.id);
    expect(ours.sort()).toEqual(['btc', 'xmr']);
  });

  it('every chain table names coins that exist', () => {
    /* The check that catches a typo. An id in a provider table that is not in
     * the catalog is dead weight at best and a mistranslated chain at worst. */
    const known = new Set(SWAP_COINS.map((c) => c.id));
    for (const [provider, table] of Object.entries(PROVIDER_CHAINS)) {
      for (const id of Object.keys(table)) {
        expect(known.has(id), `${provider} names unknown coin ${id}`).toBe(true);
      }
    }
  });

  it('every chain table gives a non-empty code', () => {
    for (const [provider, table] of Object.entries(PROVIDER_CHAINS)) {
      for (const [id, code] of Object.entries(table)) {
        expect(code.length, `${provider}:${id} has an empty network code`).toBeGreaterThan(0);
        expect(code.trim(), `${provider}:${id} is untrimmed`).toBe(code);
      }
    }
  });

  it('trades the two coins this wallet holds on every provider', () => {
    /* A provider that cannot send or receive Bitcoin and Monero has no
     * business on this screen, because those are the only coins a swap can
     * start from. */
    for (const { id } of PROVIDERS) {
      expect(providerChain(id, swapCoin('btc')!), `${id} btc`).not.toBeNull();
      expect(providerChain(id, swapCoin('xmr')!), `${id} xmr`).not.toBeNull();
    }
  });

  it('says plainly when a provider does not trade a chain', () => {
    /* Read from Godex's live coin list: USDC on Ethereum and USDT on
     * Avalanche are both listed inactive. The catalog records the gap rather
     * than asking and being refused later. */
    expect(providerChain('godex', swapCoin('usdc-eth')!)).toBeNull();
    expect(providerChain('godex', swapCoin('usdt-avalanche')!)).toBeNull();
    expect(providerChain('exolix', swapCoin('usdc-eth')!)).toBe('ETH');
    expect(providerChain('exolix', swapCoin('usdt-avalanche')!)).toBe('AVAXC');
  });

  it('refuses a pair a provider cannot serve, without asking it', () => {
    const pair = parsePair('xmr', 'usdc-eth') as Extract<ReturnType<typeof parsePair>, { ok: true }>;
    expect(pair.ok).toBe(true);
    expect(providerHandles('godex', pair.pair)).toBe(false);
    expect(providerHandles('exolix', pair.pair)).toBe(true);
  });

  it('gives a quote answer for every provider even when one cannot serve it', async () => {
    const pair = parsePair('xmr', 'usdc-eth') as Extract<ReturnType<typeof parsePair>, { ok: true }>;
    const transport = { send: async () => ({ toAmount: 5, minAmount: 1, maxAmount: 9 }) };
    const quotes = await quoteAll(transport, pair.pair, 1);
    expect(quotes).toHaveLength(PROVIDERS.length);
    const godex = quotes.find((q) => q.provider === 'godex')!;
    expect(godex.ok).toBe(false);
    expect(godex.ok === false && godex.reason).toMatch(/does not trade/i);
  });

  it('checks a TON address by shape, and tells the two EVM chains apart in words', () => {
    expect(addressLooksRight('ton', 'EQ' + 'A'.repeat(46))).toBe(true);
    expect(addressLooksRight('ton', 'UQ' + 'B'.repeat(46))).toBe(true);
    expect(addressLooksRight('ton', 'ZZ' + 'A'.repeat(46))).toBe(false);

    /* Every EVM chain shares one address shape, so the shape check cannot
     * tell Arbitrum from Base. The hint is the only place the difference is
     * stated before the money moves, so it has to name the chain. */
    const evm = '0x' + 'a'.repeat(40);
    expect(addressLooksRight('evm', evm)).toBe(true);
    expect(addressHint(swapCoin('usdc-arbitrum')!)).toMatch(/Arbitrum/);
    expect(addressHint(swapCoin('usdc-base')!)).toMatch(/Base/);
    expect(addressHint(swapCoin('usdc-arbitrum')!)).not.toBe(addressHint(swapCoin('usdc-base')!));
  });

  it('has a readable hint for every coin it lists', () => {
    for (const coin of SWAP_COINS) {
      expect(addressHint(coin).length, coin.id).toBeGreaterThan(8);
    }
  });
});
