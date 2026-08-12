/**
 * Prices, from the relay and from nowhere else, believed only when believable.
 *
 * Two layers under test. The client parses what the relay serves and refuses
 * anything that is not a positive integer number of cents within reason,
 * because a "$NaN" or a negative price under somebody's balance is a broken
 * screen wearing a real number's clothes. The watcher then treats a price as
 * a convenience and never as a fact: a refresh with no price transport leaves
 * zero, a good answer fills `centsPerUnit`, and a later failure keeps the
 * last known figures rather than flipping every screen to coin display
 * because one request dropped.
 */

import { describe, expect, it } from 'vitest';
import { recorded } from '../src/net/http';
import { fetchPrices } from '../src/net/prices';
import { NodeWatcher } from '../src/core/watcher';
import type { Transport } from '../src/net/http';
import type { NodeConfig } from '../src/core/nodes';

const nodes: { btc: NodeConfig | null; xmr: NodeConfig | null } = { btc: null, xmr: null };

const GOOD = JSON.stringify({ ok: true, prices: { BTC: 11_788_013, XMR: 26_580 } });

describe('the price client', () => {
  it('reads the relay answer into cents per unit', async () => {
    const transport = recorded({ 'GET /v1/price': GOOD });
    const result = await fetchPrices(transport);
    expect(result).toEqual({ ok: true, centsPerUnit: { BTC: 11_788_013, XMR: 26_580 } });
  });

  it('refuses a price it should not believe', async () => {
    /* The relay is ours and it is still a network answer. Floats, zeros,
     * negatives, strings and ten-billion-dollar coins are all refusals, and a
     * refusal costs nothing: the app keeps showing coin amounts. */
    const bad = [
      { ok: true, prices: { BTC: 11_788_013.5, XMR: 26_580 } },
      { ok: true, prices: { BTC: 0, XMR: 26_580 } },
      { ok: true, prices: { BTC: -5, XMR: 26_580 } },
      { ok: true, prices: { BTC: '11788013', XMR: 26_580 } },
      { ok: true, prices: { BTC: 2_000_000_000_000, XMR: 26_580 } },
      { ok: true, prices: { BTC: 11_788_013 } },
      { ok: true },
      { ok: false, problem: 'no' },
    ];
    for (const body of bad) {
      const transport = recorded({ 'GET /v1/price': JSON.stringify(body) });
      const result = await fetchPrices(transport);
      expect(result.ok, JSON.stringify(body)).toBe(false);
    }
  });

  it('turns a relay that is down into a refusal, not a throw', async () => {
    const transport = recorded({ 'GET /v1/price': { status: 502, body: 'gateway' } });
    const result = await fetchPrices(transport);
    expect(result.ok).toBe(false);
  });
});

describe('the watcher and the price', () => {
  it('leaves zero, meaning unknown, when there is no relay', async () => {
    const watcher = new NodeWatcher(nodes, null, { btc: null, xmr: null }, 1_700_000_000_000);
    await watcher.refresh(1_700_000_000_000);
    expect(watcher.snapshot().centsPerUnit).toEqual({ BTC: 0, XMR: 0 });
  });

  it('fills the price from the relay on refresh', async () => {
    const prices = recorded({ 'GET /v1/price': GOOD });
    const watcher = new NodeWatcher(nodes, null, { btc: null, xmr: null, prices }, 1_700_000_000_000);
    await watcher.refresh(1_700_000_000_000);
    expect(watcher.snapshot().centsPerUnit).toEqual({ BTC: 11_788_013, XMR: 26_580 });
  });

  it('keeps the last known price through a relay failure', async () => {
    /* A refresh whose price request dropped is not a wallet whose money
     * changed. Yesterday's convenience number, still marked by the ordinary
     * staleness the snapshot already carries, beats a screen that flips to
     * coin display because one request timed out. */
    let healthy = true;
    const flaky: Transport = {
      base: 'https://relay.example',
      async send() {
        return healthy
          ? { ok: true, status: 200, text: GOOD }
          : { ok: false, status: null, problem: 'The relay could not be reached.' };
      },
    };
    const watcher = new NodeWatcher(nodes, null, { btc: null, xmr: null, prices: flaky }, 1_700_000_000_000);
    await watcher.refresh(1_700_000_000_000);
    expect(watcher.snapshot().centsPerUnit.BTC).toBe(11_788_013);
    healthy = false;
    await watcher.refresh(1_700_000_060_000);
    expect(watcher.snapshot().centsPerUnit.BTC).toBe(11_788_013);
  });
});
