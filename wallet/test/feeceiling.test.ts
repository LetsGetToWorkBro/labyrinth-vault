/**
 * What a node is allowed to charge.
 *
 * Both chains take their fee rate from whatever node happens to be configured,
 * and both had a floor and no ceiling. The floor is the well understood half: a
 * node with an empty mempool quotes below the relay minimum and the
 * transaction goes nowhere. The missing half is worse, because nothing
 * downstream can catch it. The rate goes into the draft, the draft is what the
 * returned signature is checked against, and the two agree because they came
 * from the same number. On a vault-paired account a person reads the fee off a
 * second device and might notice; on an account this phone signs for, the
 * review screen is the only screen and it is showing the node's number back.
 *
 * These are the ceilings, and the tests below are as much about what they do
 * not refuse as what they do. A ceiling tight enough to reject a real
 * congestion spike would push the wallet onto its fallback rate, underpay, and
 * leave a payment unconfirmed, which is its own way of losing a day.
 */

import { describe, expect, it } from 'vitest';
import { toHex, walletFromSeed } from '@vault/keys/monero';
import type { Reply, Request, Transport } from '../src/net/http';
import {
  feeOptionsFrom,
  MAX_BTC_FEE_RATE,
  MAX_XMR_FEE_PER_BYTE,
  NodeWatcher,
} from '../src/core/watcher';
import { openAccount } from '../src/core/moneroscan';

describe('the ceiling on a Bitcoin fee estimate', () => {
  it('takes a congestion spike, because a real fee market produces one', () => {
    /* The busiest blocks Bitcoin has ever had are in the low thousands of
     * sat/vB. A ceiling that refused this would send the wallet to its
     * fallback rate in exactly the conditions where the fallback underpays. */
    const options = feeOptionsFrom({ 1: 900, 6: 640, 144: 300 });
    expect(options.map((o) => o.rate)).toEqual([300, 640, 900]);
    expect(900).toBeLessThan(MAX_BTC_FEE_RATE);
  });

  it('refuses a rate no fee market produces, and uses the fallback', () => {
    /* A node answering with this is broken or hostile, not expensive. The
     * fallback is the same route an absent estimate already takes. */
    const options = feeOptionsFrom({ 1: 1e9, 6: 1e9, 144: 1e9 });
    expect(options.map((o) => o.rate)).toEqual([2, 8, 20]);
    for (const option of options) expect(option.rate).toBeLessThanOrEqual(MAX_BTC_FEE_RATE);
  });

  it('refuses one silly target without discarding the sane ones beside it', () => {
    const options = feeOptionsFrom({ 1: 50_000, 6: 9.4, 144: 2.1 });
    expect(options.find((o) => o.key === 'priority')!.rate).toBe(20);
    expect(options.find((o) => o.key === 'standard')!.rate).toBe(9.4);
    expect(options.find((o) => o.key === 'economy')!.rate).toBe(2.1);
  });

  it('does not treat a number that is not one as an estimate', () => {
    const options = feeOptionsFrom({ 1: Number.POSITIVE_INFINITY, 6: Number.NaN, 144: 2.1 });
    expect(options.find((o) => o.key === 'priority')!.rate).toBe(20);
    expect(options.find((o) => o.key === 'standard')!.rate).toBe(8);
  });
});

describe('the ceiling on a Monero fee estimate', () => {
  const wallet = walletFromSeed(new Uint8Array(32).map((_, i) => (i * 13 + 5) & 0xff));
  const account = (() => {
    const opened = openAccount(wallet.address, toHex(wallet.viewSecret));
    if (!opened.ok) throw new Error(opened.problem);
    return opened.account;
  })();

  const nodes = {
    btc: null,
    xmr: { kind: 'monerod' as const, url: 'https://node.example', label: 'somebody-elses-node', mine: false },
  };

  /** A node with one block and one answer for the fee, whatever it is asked. */
  function nodeQuoting(fee: number | null): Transport {
    return {
      base: 'https://node.example',
      async send(request: Request): Promise<Reply> {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const result = (value: unknown): Reply => ({
          ok: true,
          status: 200,
          text: JSON.stringify({ id: '0', jsonrpc: '2.0', result: value }),
        });
        if (body['method'] === 'get_info') {
          return result({ height: 2, target_height: 0, synchronized: true, mainnet: true, status: 'OK' });
        }
        if (body['method'] === 'get_block') {
          return result({
            block_header: { hash: 'c'.repeat(64), height: 1, timestamp: 1_700_000_000, miner_tx_hash: 'd'.repeat(64) },
            tx_hashes: [],
            status: 'OK',
          });
        }
        if (body['method'] === 'get_fee_estimate') {
          return fee === null
            ? { ok: false, status: 500, problem: 'no estimate here' }
            : result({ fee, status: 'OK' });
        }
        return { ok: false, status: 404, problem: `nothing here for ${request.path}` };
      },
    };
  }

  const watcherOn = (fee: number | null): NodeWatcher =>
    new NodeWatcher(nodes, null, { btc: null, xmr: nodeQuoting(fee) }, 1_700_000_000_000, {
      account,
      scan: { birth: 1, height: 1 },
      source: 'vault',
    });

  it('refuses an estimate outside any real fee market, and names the node', async () => {
    const watcher = watcherOn(1e15);
    await watcher.refresh(1_700_000_000_000);

    const materials = watcher.moneroSpendMaterials(() => 0.5);
    expect(materials.ok).toBe(false);
    if (!materials.ok) {
      expect(materials.problem).toContain('somebody-elses-node');
      expect(materials.problem).toMatch(/outside any real Monero fee market/);
      /* Not the sentence for a node that has not been asked yet. Those send
       * somebody to two different places: one says refresh, this one says
       * change the node. */
      expect(materials.problem).not.toMatch(/has not quoted a fee yet/);
    }
  });

  it('takes an ordinary estimate and gets past the fee check', async () => {
    /* The other side of the same fixture, so the refusal above is a ceiling
     * and not a wallet that refuses every fee a node offers. Twenty thousand
     * piconero per byte is roughly what monerod quotes on an ordinary day, and
     * the refusal that follows is about coins rather than about price. */
    const watcher = watcherOn(20_000);
    await watcher.refresh(1_700_000_000_000);

    const materials = watcher.moneroSpendMaterials(() => 0.5);
    expect(materials.ok).toBe(false);
    if (!materials.ok) {
      expect(materials.problem).not.toMatch(/fee/i);
      expect(materials.problem).toMatch(/key images/);
    }
    expect(20_000n).toBeLessThan(MAX_XMR_FEE_PER_BYTE);
  });

  it('still says refresh when the node simply has not answered', async () => {
    const watcher = watcherOn(null);
    await watcher.refresh(1_700_000_000_000);

    const materials = watcher.moneroSpendMaterials(() => 0.5);
    expect(materials.ok).toBe(false);
    if (!materials.ok) expect(materials.problem).toMatch(/has not quoted a fee yet/);
  });
});
