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
  amountWithinQuote,
  chainCanBeProven,
  chainIsAmbiguous,
  confusableChains,
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
    /* Unechoed by default, which is what a provider that says nothing about
     * the network looks like. Tests that care set them explicitly. */
    fromCoin: null,
    fromNetwork: null,
    toCoin: null,
    toNetwork: null,
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
    /* Anything unrecognized is reported as unrecognized. The rule this
     * replaces mapped it to `failed`, guarding against a silent "probably
     * fine", which was the right instinct and the wrong lever: the status
     * screen turns `failed` into "the exchange reports this order failed,
     * contact them", a sentence about somebody's live money that the
     * exchange never said. `unknown` keeps the guard (nothing is lit, the
     * journey still reads as in flight) and drops the false claim, carrying
     * the exchange's own word through for a person to act on. */
    expect(parseExolixStatus({ status: 'something new' }).stage).toBe('unknown');
    expect(parseGodexStatus({}).stage).toBe('unknown');
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

  it('covers the assets that carry the volume, and nothing invented', () => {
    const tickers = new Set(SWAP_COINS.map((c) => c.ticker));
    expect([...tickers].sort()).toEqual(['btc', 'eth', 'sol', 'usdc', 'usdt', 'xmr']);
  });

  it('holds each native coin only on its own chain', () => {
    /* The exchanges list wrapped BTC, wrapped XMR and wrapped SOL under the
     * native ticker: Exolix alone offers SOL on Ethereum, BNB Chain and HECO,
     * and its own data marks the Ethereum one as native, which it is not.
     * They are somebody else's IOU, and a person choosing "Monero" must not
     * be able to land on a Solana token wearing that name. This is why the
     * catalog is written by hand rather than mirrored from a provider. */
    const chainsFor = (ticker: string) =>
      SWAP_COINS.filter((c) => c.ticker === ticker).map((c) => c.chain);
    expect(chainsFor('btc')).toEqual(['bitcoin']);
    expect(chainsFor('xmr')).toEqual(['monero']);
    expect(chainsFor('sol')).toEqual(['solana']);
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

describe('the chain a shape cannot prove', () => {
  /* The check every other coin gets for free: the address shape and the chain
   * are nearly the same question. On the EVM chains they are not, and these
   * tests pin the one place the product tells the truth about it. */

  it('knows the EVM chains are confusable with each other', () => {
    const arb = swapCoin('usdc-arbitrum')!;
    expect(chainIsAmbiguous(arb)).toBe(true);
    const confusable = confusableChains(arb);
    for (const chain of ['ethereum', 'base', 'polygon', 'avalanche', 'bsc', 'optimism']) {
      expect(confusable, `${chain} shares the 0x shape`).toContain(chain);
    }
    expect(confusable, 'a coin is not confusable with itself').not.toContain('arbitrum');
  });

  it('knows the coins whose shape does settle the chain', () => {
    /* Bitcoin, Monero, Tron, TON and Solana each have an address shape no
     * other chain in this catalog accepts, so a shape check is a chain check
     * and no warning is owed. */
    for (const id of ['btc', 'xmr', 'usdt-tron', 'usdt-ton', 'sol', 'usdc-solana']) {
      expect(chainIsAmbiguous(swapCoin(id)!), id).toBe(false);
    }
  });

  it('never calls a coin ambiguous when the shape check would catch it', () => {
    /* The invariant behind the warning: if two coins are confusable then the
     * same address really does pass both their shape checks. A warning shown
     * where the machine could have checked would train people to ignore it. */
    const sample: Record<string, string> = {
      evm: '0x' + 'a'.repeat(40),
      btc: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
      xmr: '4' + 'A'.repeat(94),
      sol: '1'.repeat(40),
      tron: 'T' + '1'.repeat(33),
      ton: 'EQ' + 'A'.repeat(46),
    };
    for (const coin of SWAP_COINS) {
      for (const chain of confusableChains(coin)) {
        const twin = SWAP_COINS.find((c) => c.chain === chain && c.family === coin.family)!;
        const address = sample[coin.family]!;
        expect(addressLooksRight(coin.family, address), coin.id).toBe(true);
        expect(
          addressLooksRight(twin.family, address),
          `${coin.id} and ${twin.id} are called confusable but do not accept the same address`,
        ).toBe(true);
      }
    }
  });
});

describe('being wrong about somebody else\'s money', () => {
  /* The two ways this module could have reported a falsehood about a live
   * order, both found by asking what happens at the edges rather than in the
   * middle. */

  it('never calls a live order failed because the vocabulary moved', () => {
    /* The old fallback was `: 'failed'`, so any status word not in the list
     * became FAILED, and the status screen tells a person their exchange
     * reports the order failed and to go contact them. An exchange adding a
     * state is normal; inventing bad news about somebody's money is not. */
    for (const word of ['verifying', 'on_hold', 'hold', 'processing', 'kyc', 'review', 'new']) {
      const exolix = parseExolixStatus({ status: word });
      const godex = parseGodexStatus({ status: word });
      expect(exolix.stage, `exolix ${word}`).toBe('unknown');
      expect(godex.stage, `godex ${word}`).toBe('unknown');
      /* And the exchange's own word survives, so a person can act on it. */
      expect(exolix.raw).toBe(word);
      expect(godex.raw).toBe(word);
    }
  });

  it('still reports a real failure as a failure', () => {
    for (const word of ['failed', 'error']) {
      expect(parseExolixStatus({ status: word }).stage, word).toBe('failed');
      expect(parseGodexStatus({ status: word }).stage, word).toBe('failed');
    }
    expect(parseExolixStatus({ status: 'refunded' }).stage).toBe('refunded');
    expect(parseExolixStatus({ status: 'overdue' }).stage).toBe('expired');
    expect(parseGodexStatus({ status: 'success' }).stage).toBe('done');
  });

  it('refuses an amount the exchange said it would not take', () => {
    const quote = { provider: 'exolix' as const, ok: true as const, toAmount: 5, minAmount: 0.1, maxAmount: 10 };
    expect(amountWithinQuote(0.5, quote).ok).toBe(true);
    const low = amountWithinQuote(0.05, quote);
    const high = amountWithinQuote(50, quote);
    expect(low.ok).toBe(false);
    expect(high.ok).toBe(false);
    expect(low.ok === false && low.problem).toMatch(/less than 0\.1/);
    expect(high.ok === false && high.problem).toMatch(/more than 10/);
  });

  it('treats a quote with no bounds as constraining nothing', () => {
    const bare = { provider: 'godex' as const, ok: true as const, toAmount: 5 };
    expect(amountWithinQuote(0.000001, bare).ok).toBe(true);
    expect(amountWithinQuote(999999, bare).ok).toBe(true);
    expect(amountWithinQuote(0, bare).ok).toBe(false);
  });

  it('will not create an order outside the quoted range, whatever the caller does', async () => {
    /* The gate is inside createOrder, so there is no call site that can skip
     * it by forgetting. A transport that would have answered is never asked. */
    let asked = false;
    const transport = { send: async () => { asked = true; return {}; } };
    const pair = parsePair('xmr', 'btc') as Extract<ReturnType<typeof parsePair>, { ok: true }>;
    const built = buildRequest({
      provider: 'exolix',
      pair: pair.pair,
      amount: 0.001,
      own: { receive: (a: string) => (a === 'BTC' ? 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' : '4' + 'A'.repeat(94)) },
    } as never) as Extract<ReturnType<typeof buildRequest>, { ok: true }>;
    expect(built.ok).toBe(true);
    const quote = { provider: 'exolix' as const, ok: true as const, toAmount: 1, minAmount: 1, maxAmount: 100 };
    const result = await createOrder(transport, built.request, 1, quote);
    expect(result.ok).toBe(false);
    expect(asked, 'the exchange should never have been asked').toBe(false);
  });
});

describe('the exchange naming the network back', () => {
  /* The only check that can catch a wrong chain. Every EVM chain takes the
   * same 0x address, so no address proves its network; the exchange saying
   * which network it built the order on is the sole evidence there is.
   *
   * The response below is Exolix's own documented example, field for field,
   * so the parser is held against the shape the API really returns rather
   * than against a shape convenient to the parser. */
  const DOC_RESPONSE = {
    id: 'dsd8f65609bb20',
    amount: 0.5,
    amountTo: 505.631486,
    coinFrom: {
      coinCode: 'ETH',
      coinName: 'Ethereum',
      network: 'ETH',
      networkName: 'Ethereum (ERC20)',
      networkShortName: 'ERC20',
      memoName: null,
      contract: '0x0000000000000000000000000000000000000000',
    },
    coinTo: {
      coinCode: 'USDT',
      coinName: 'TetherUS',
      network: 'ETH',
      networkName: 'Ethereum (ERC20)',
      networkShortName: 'ERC20',
      memoName: null,
      contract: '0x0000000000000000000000000000000000000000',
    },
    comment: null,
    createdAt: '2022-06-02T12:45:37.623Z',
    depositAddress: '0xDb3B8a6dd4ddfDCA3330eaebc1a20aF26fDbbCfa',
    depositExtraId: null,
    withdrawalAddress: '0x0E29D1E501q90649Adss982E90dd455006e4522FC',
    withdrawalExtraId: '',
    refundAddress: '0x0070BeBe9E30429437bD9c84C731031c27Fc7955',
    refundExtraId: '',
    hashIn: { hash: null, link: null },
    hashOut: { hash: null, link: null },
    rate: 1011.262972,
    rateType: 'float',
    status: 'wait',
  };

  it('reads the documented response, network and all', () => {
    const order = parseExolixCreate(DOC_RESPONSE)!;
    expect(order).not.toBeNull();
    expect(order.id).toBe('dsd8f65609bb20');
    expect(order.depositAddress).toBe('0xDb3B8a6dd4ddfDCA3330eaebc1a20aF26fDbbCfa');
    expect(order.depositAmount).toBe(0.5);
    expect(order.toAmount).toBe(505.631486);
    expect(order.fromCoin).toBe('ETH');
    expect(order.fromNetwork).toBe('ETH');
    expect(order.toCoin).toBe('USDT');
    expect(order.toNetwork).toBe('ETH');
    /* An absent extra id is null, not the string "null". */
    expect(order.depositExtra).toBeNull();
  });

  it('refuses an order the exchange built on a different chain', () => {
    /* The failure this exists for: ask for USDT on Arbitrum, receive an
     * order for USDT on Ethereum. Both deposit addresses are valid 0x
     * strings, both pass every shape check, and only this comparison can
     * tell them apart. */
    const pair = parsePair('xmr', 'usdt-arbitrum') as Extract<ReturnType<typeof parsePair>, { ok: true }>;
    const built = buildRequest({
      provider: 'exolix',
      pair: pair.pair,
      amount: 1,
      own,
      typedPayout: '0x' + 'a'.repeat(40),
    }) as Extract<ReturnType<typeof buildRequest>, { ok: true }>;
    expect(built.ok).toBe(true);

    const right = orderFor(built.request, {
      fromCoin: 'XMR', fromNetwork: 'XMR', toCoin: 'USDT', toNetwork: 'ARBITRUM',
      depositAddress: '4' + 'A'.repeat(94),
    });
    expect(verifyOrder(built.request, right, 7.5).ok).toBe(true);

    const wrongChain = orderFor(built.request, {
      fromCoin: 'XMR', fromNetwork: 'XMR', toCoin: 'USDT', toNetwork: 'ETH',
      depositAddress: '4' + 'A'.repeat(94),
    });
    const check = verifyOrder(built.request, wrongChain, 7.5);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.problem).toMatch(/different network coming back/i);
    expect(check.ok === false && check.detail).toMatch(/ARBITRUM.*ETH/);
  });

  it('refuses an order the exchange built for a different coin', () => {
    const request = btcToXmr();
    const swapped = orderFor(request, { toCoin: 'LTC', toNetwork: 'XMR', fromCoin: 'BTC', fromNetwork: 'BTC' });
    const check = verifyOrder(request, swapped, 7.5);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.problem).toMatch(/different coin coming back/i);
  });

  it('treats an unechoed network as unchecked, not as agreement', () => {
    /* Godex publishes no public schema, so its orders carry nulls. A null
     * must not read as a match: it means nobody checked, and the pair is
     * accepted on the strength of the other checks alone. */
    const request = btcToXmr();
    const silent = orderFor(request);
    expect(silent.fromNetwork).toBeNull();
    expect(verifyOrder(request, silent, 7.5).ok).toBe(true);
  });

  it('maps every status Exolix documents', () => {
    /* The documented set, verbatim. `confirmed` and `refund` were both
     * missing before these docs arrived, and both would have been reported
     * as a failure by the old fallback. */
    const documented: Record<string, string> = {
      wait: 'waiting',
      confirmation: 'confirming',
      confirmed: 'confirming',
      exchanging: 'exchanging',
      sending: 'sending',
      success: 'done',
      overdue: 'expired',
      refund: 'refunded',
      refunded: 'refunded',
    };
    for (const [word, stage] of Object.entries(documented)) {
      expect(parseExolixStatus({ status: word }).stage, word).toBe(stage);
      /* And none of the documented words is ever 'unknown', which is the
       * bucket reserved for vocabulary this build has genuinely not seen. */
      expect(parseExolixStatus({ status: word }).stage, word).not.toBe('unknown');
    }
  });
});

describe('the floor on the other side of the trade', () => {
  /* Exolix's rate reply documents two minimums, not one. `minAmount` is what
   * must be sent; `withdrawMin` is what must arrive. Reading only the first
   * lets through a trade the exchange cannot pay out, and it fails after the
   * deposit has landed, which is the expensive moment to find out. */

  it('reads both floors out of the documented rate reply', () => {
    /* Exolix's own example response, verbatim. */
    const quote = parseExolixRate({
      toAmount: 502.352518,
      rate: 1004.705036,
      message: null,
      minAmount: 0.3717403,
      withdrawMin: 3.24760808882742,
      maxAmount: 31811.44515,
    });
    expect(quote.ok).toBe(true);
    expect(quote.toAmount).toBe(502.352518);
    expect(quote.minAmount).toBe(0.3717403);
    expect(quote.maxAmount).toBe(31811.44515);
    expect(quote.withdrawMin).toBe(3.24760808882742);
  });

  it('refuses a trade that pays out less than the exchange can send', () => {
    /* Above the send floor and below the payout floor: the case only the
     * second check catches. */
    const quote = {
      provider: 'exolix' as const,
      ok: true as const,
      toAmount: 2,
      minAmount: 0.1,
      maxAmount: 100,
      withdrawMin: 3.2,
    };
    const check = amountWithinQuote(1, quote);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.problem).toMatch(/pays out less than the exchange can send/i);
  });

  it('accepts once enough is arriving', () => {
    const quote = {
      provider: 'exolix' as const,
      ok: true as const,
      toAmount: 500,
      minAmount: 0.1,
      maxAmount: 100,
      withdrawMin: 3.2,
    };
    expect(amountWithinQuote(1, quote).ok).toBe(true);
  });

  it('lets a provider that names no payout floor constrain nothing', () => {
    const quote = { provider: 'godex' as const, ok: true as const, toAmount: 0.0001, minAmount: 0.1 };
    expect(amountWithinQuote(1, quote).ok).toBe(true);
  });
});

describe('what Godex names back, and what it does not', () => {
  /* Godex's documented create reply, field for field from the reference.
   * It echoes the coins and says nothing about the networks: the request
   * accepts coin_from_network and coin_to_network, the response returns
   * neither. That asymmetry is the whole point of these tests. */
  const DOC_RESPONSE = {
    status: 'wait',
    coin_from: 'LTC',
    coin_to: 'ETH',
    deposit_amount: 1,
    withdrawal: '0x5aadfa328D778383d1134F7530f9feaC676',
    withdrawal_extra_id: 'qbGDbH9gwrAkJTM6gxsfQpWYMfe8',
    return: 'LsZK2wfxvXrfsfB6L39qmCcV5DK29ismmAwN41',
    return_extra_id: 'qbGDbH9gwrAkfJTM6gxsfQpWYMfe8zRu',
    withdrawal_amount: 0.25281436,
    deposit: 'LsZK2wfxvXrdffsfB6L39qmCcV5DK29ismmAwN41',
    deposit_extra_id: null,
    rate: 0.26011493,
    fee: 0.00730057,
    transaction_id: '5bb4d99cd44a5',
    float: true,
  };

  it('reads the documented reply', () => {
    const order = parseGodexCreate(DOC_RESPONSE)!;
    expect(order).not.toBeNull();
    expect(order.id).toBe('5bb4d99cd44a5');
    expect(order.depositAddress).toBe('LsZK2wfxvXrdffsfB6L39qmCcV5DK29ismmAwN41');
    expect(order.payoutAddress).toBe('0x5aadfa328D778383d1134F7530f9feaC676');
    expect(order.depositAmount).toBe(1);
    expect(order.toAmount).toBe(0.25281436);
    expect(order.depositExtra).toBeNull();
  });

  it('carries the coins it was told, and no network at all', () => {
    const order = parseGodexCreate(DOC_RESPONSE)!;
    expect(order.fromCoin).toBe('LTC');
    expect(order.toCoin).toBe('ETH');
    /* Null because the API does not say, not because the parser skipped it.
     * verifyOrder reads null as unchecked, so a Godex order is never treated
     * as having proven a chain it never mentioned. */
    expect(order.fromNetwork).toBeNull();
    expect(order.toNetwork).toBeNull();
  });

  it('catches a Godex order built for the wrong coin', () => {
    const request = btcToXmr();
    const wrong = orderFor(request, { fromCoin: 'BTC', toCoin: 'LTC' });
    const check = verifyOrder(request, wrong, 7.5);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.problem).toMatch(/different coin coming back/i);
  });

  it('maps every status Godex documents', () => {
    const documented: Record<string, string> = {
      wait: 'waiting',
      confirmation: 'confirming',
      exchanging: 'exchanging',
      sending: 'sending',
      sending_confirmation: 'sending',
      success: 'done',
      overdue: 'expired',
      error: 'failed',
      refunded: 'refunded',
    };
    for (const [word, stage] of Object.entries(documented)) {
      expect(parseGodexStatus({ status: word }).stage, word).toBe(stage);
      expect(parseGodexStatus({ status: word }).stage, word).not.toBe('unknown');
    }
  });
});

describe('which provider can prove a chain', () => {
  it('says Exolix can, because it names the network back', () => {
    expect(chainCanBeProven('exolix', swapCoin('usdc-arbitrum')!)).toBe(true);
    expect(chainCanBeProven('exolix', swapCoin('btc')!)).toBe(true);
  });

  it('says Godex cannot, for a coin that rides more than one chain', () => {
    expect(chainCanBeProven('godex', swapCoin('usdc-arbitrum')!)).toBe(false);
    expect(chainCanBeProven('godex', swapCoin('usdt-eth')!)).toBe(false);
    expect(chainCanBeProven('godex', swapCoin('eth-base')!)).toBe(false);
  });

  it('says Godex can, where the coin itself settles the chain', () => {
    /* One chain in the catalog means echoing the coin names the network by
     * elimination, so the missing network field costs nothing here. */
    for (const id of ['btc', 'xmr', 'sol', 'usdt-tron', 'usdt-ton']) {
      expect(chainCanBeProven('godex', swapCoin(id)!), id).toBe(true);
    }
  });
});
