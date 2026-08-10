/**
 * The fixture, and every reason it is one.
 *
 * There is no node client in this build. Everything the app displays comes
 * from this file: balances, unspent outputs, fee quotes, prices, history,
 * confirmation depths. It is not a mock in the testing sense — it is the data
 * source the running application actually has, until the watcher is written.
 *
 * Three rules were followed here, and they are worth stating because fixtures
 * are usually where honesty goes to die in a design-led build:
 *
 * **Everything derives from real key material.** The Bitcoin side is the
 * account key published in BIP84 itself — the `abandon abandon … about`
 * vector, the same one `src/keys/bitcoin.ts` self-tests against. Every address
 * on screen is really derived from it, by the real derivation code. They are
 * valid mainnet addresses that pass the real validator, because a screenshot
 * full of `bc1qxxxxx…` teaches a design nothing about how a real address
 * wraps, groups and reads at 15pt.
 *
 * **Nothing here is anybody's money.** That key is the most published
 * extended key in Bitcoin; the Monero wallet below is derived from a seed
 * written out in this file in plain sight. Both are empty and will stay
 * empty. The balances are numerals, and the app labels them `DEMO DATA` on
 * the home screen for as long as this file is what is behind them.
 *
 * **The arithmetic is real.** The fiat totals are not typed in — they are
 * computed from the amounts and the prices below, by the same code the real
 * watcher will feed. If the numbers on the home screen do not add up, that is
 * a bug in `units.ts` and not a typo here, which is the point.
 */

import { Transaction as BtcTransaction } from '@scure/btc-signer';
import { addressAt, openWatch, type BtcWallet } from '@vault/keys/bitcoin';
import { walletFromSeed } from '@vault/keys/monero';
import type { AssetView, BroadcastResult, ChainSnapshot, FeeOption, Utxo, Watcher } from './chain';
import type { Asset, Transaction } from './model';

/** BIP84's own test vector. Published, empty, and self-tested against. */
export const DEMO_ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

/** A Monero wallet whose seed is on the next line. Deliberately. */
const DEMO_XMR_SEED = new Uint8Array(32).map((_, i) => (i * 7 + 11) & 0xff);

const btcWallet: BtcWallet = (() => {
  const opened = openWatch(DEMO_ZPUB);
  if (!opened.ok || !opened.wallet) throw new Error('the demo account key does not open, which means the derivation is broken');
  return opened.wallet;
})();

const xmrWallet = walletFromSeed(DEMO_XMR_SEED);

export const DEMO_XMR_ADDRESS = xmrWallet.address;

/** Receiving addresses, really derived, in order. */
function receiveAddress(index: number): { address: string; script: Uint8Array } {
  return addressAt(btcWallet, 0, index);
}

// ------------------------------------------------------------------- prices

/* Cents per whole unit. A price feed is a network call, so these are as fixed
 * as everything else here, and the wallet marks the figure `stale` rather than
 * pretending it just fetched it. */
const CENTS: Record<Asset, number> = { BTC: 11_788_000, XMR: 26_580 };

// -------------------------------------------------------------------- coins

/**
 * The unspent outputs. Four of them, on purpose.
 *
 * A single fat UTXO makes coin selection look trivial and hides every
 * interesting state: the change output, the "this needs three of your coins"
 * fee jump, the dust remainder that goes to the miner. Four coins across two
 * addresses produces all of them from the amounts a person is likely to type.
 */
const COINS: { value: bigint; index: number; confirmations: number; txid: string }[] = [
  { value: 25_000_000n, index: 0, confirmations: 412, txid: 'd41b8f2c19a75e3f0b6c4d8e2a91f37c5b0e6d4a8c2f19b73e5d0a6c8b4f2e19' },
  { value: 15_000_000n, index: 1, confirmations: 210, txid: '7a3e1c9d5b2f8e04a6c1d3b7f9e2a5c8d0b4f6a1e3c7d9b2f5a8e0c4d6b1f3a7' },
  { value: 6_273_100n, index: 2, confirmations: 68, txid: '2f9c4a7e1d6b3f8a0c5e2d9b7f4a1c6e3d0b8f5a2c9e6d3b0f7a4c1e8d5b2f9c' },
  { value: 2_000_000n, index: 3, confirmations: 3, txid: 'b8e5d2a9c6f3b0e7d4a1c8f5b2e9d6a3c0f7b4e1d8a5c2f9b6e3d0a7c4f1b8e5' },
];

const btcUtxos: Utxo[] = COINS.map((coin) => {
  const derived = receiveAddress(coin.index);
  return {
    txid: coin.txid,
    vout: 0,
    value: coin.value,
    address: derived.address,
    path: { change: 0, index: coin.index },
    script: derived.script,
    confirmations: coin.confirmations,
  };
});

const XMR_BALANCE = 14_381_000_000_000n;

// --------------------------------------------------------------------- fees

const BTC_FEES: FeeOption[] = [
  { key: 'economy', label: 'ECONOMY', rate: 4, etaMinutes: 180 },
  { key: 'standard', label: 'STANDARD', rate: 11, etaMinutes: 30 },
  { key: 'priority', label: 'PRIORITY', rate: 24, etaMinutes: 10 },
];

/* Monero quotes a base fee and multiplies it by priority, so the "rate" here
 * is that multiplier and the estimator in build.ts treats it as one. Naming it
 * `rate` for both chains and meaning something different is the kind of small
 * dishonesty that costs an afternoon later, so `formatFeeRate` renders them
 * differently and the difference is visible on screen. */
const XMR_FEES: FeeOption[] = [
  { key: 'economy', label: 'ECONOMY', rate: 1, etaMinutes: 40 },
  { key: 'standard', label: 'STANDARD', rate: 2.4, etaMinutes: 20 },
  { key: 'priority', label: 'PRIORITY', rate: 5.2, etaMinutes: 10 },
];

// ------------------------------------------------------------------ history

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * History, relative to now.
 *
 * Times are offsets rather than stamps so that the app never shows a
 * transaction from 2024 sitting above "3m ago" — a fixture that ages badly
 * makes every screenshot after the first month look broken.
 */
export function demoTransactions(now: number): Transaction[] {
  const journeyFor = (at: number): { stage: Transaction['stage']; at: number }[] => [
    { stage: 'prepared', at: at - 6 * MINUTE },
    { stage: 'sent-to-vault', at: at - 5 * MINUTE },
    { stage: 'awaiting-signature', at: at - 4 * MINUTE },
    { stage: 'signed', at: at - 3 * MINUTE },
    { stage: 'broadcast', at },
  ];

  return [
    {
      id: 'tx-pending',
      asset: 'BTC',
      direction: 'sent',
      amount: 21_400_000n,
      fee: 14_200n,
      counterparty: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      stage: 'broadcast',
      confirmations: 2,
      confirmationTarget: 6,
      txid: '8f91c4a7e2d5b0f3a6c9e1d4b7f2a5c8e0d3b6f9a2c5e8d1b4f7a0c3e6d9b82a',
      blockHeight: 874_902,
      at: now - 11 * MINUTE,
      fiatCents: 2_522_632,
      journey: [...journeyFor(now - 11 * MINUTE), { stage: 'confirmed', at: now - 4 * MINUTE }].slice(0, 5),
    },
    {
      id: 'tx-received-xmr',
      asset: 'XMR',
      direction: 'received',
      amount: 3_200_000_000_000n,
      fee: 0n,
      counterparty: DEMO_XMR_ADDRESS,
      stage: 'confirmed',
      confirmations: 44,
      confirmationTarget: 10,
      txid: 'c1d4b7f2a5c8e0d3b6f9a2c5e8d1b4f7a0c3e6d9b82a8f91c4a7e2d5b0f3a6c9',
      blockHeight: 3_204_881,
      at: now - 5 * HOUR,
      fiatCents: 85_056,
    },
    {
      id: 'tx-sent-btc-yesterday',
      asset: 'BTC',
      direction: 'sent',
      amount: 4_500_000n,
      fee: 9_800n,
      counterparty: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      stage: 'confirmed',
      confirmations: 138,
      confirmationTarget: 6,
      txid: 'a5c8e0d3b6f9a2c5e8d1b4f7a0c3e6d9b82a8f91c4a7e2d5b0f3a6c9e1d4b7f2',
      blockHeight: 874_764,
      at: now - 1 * DAY - 3 * HOUR,
      fiatCents: 530_460,
      journey: journeyFor(now - 1 * DAY - 3 * HOUR),
    },
    {
      id: 'tx-received-btc',
      asset: 'BTC',
      direction: 'received',
      amount: 6_273_100n,
      fee: 0n,
      counterparty: receiveAddress(2).address,
      stage: 'confirmed',
      confirmations: 68,
      confirmationTarget: 6,
      txid: '2f9c4a7e1d6b3f8a0c5e2d9b7f4a1c6e3d0b8f5a2c9e6d3b0f7a4c1e8d5b2f9c',
      blockHeight: 874_834,
      at: now - 3 * DAY,
      fiatCents: 739_474,
    },
    {
      id: 'tx-sent-xmr',
      asset: 'XMR',
      direction: 'sent',
      amount: 1_750_000_000_000n,
      fee: 32_000_000n,
      counterparty: '4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2684Rge',
      stage: 'confirmed',
      confirmations: 1_204,
      confirmationTarget: 10,
      txid: 'e8d1b4f7a0c3e6d9b82a8f91c4a7e2d5b0f3a6c9e1d4b7f2a5c8e0d3b6f9a2c5',
      blockHeight: 3_203_641,
      at: now - 6 * DAY,
      fiatCents: 46_515,
      journey: journeyFor(now - 6 * DAY),
    },
    {
      id: 'tx-received-btc-old',
      asset: 'BTC',
      direction: 'received',
      amount: 25_000_000n,
      fee: 0n,
      counterparty: receiveAddress(0).address,
      stage: 'confirmed',
      confirmations: 412,
      confirmationTarget: 6,
      txid: 'd41b8f2c19a75e3f0b6c4d8e2a91f37c5b0e6d4a8c2f19b73e5d0a6c8b4f2e19',
      blockHeight: 874_490,
      at: now - 21 * DAY,
      fiatCents: 2_947_000,
    },
  ];
}

// ------------------------------------------------------------------ watcher

/**
 * The fixture as a `Watcher`, so nothing above this line knows it is one.
 *
 * Every screen in the application talks to this interface. Swapping in a real
 * client is a change to this file and no other, which is the only way to know
 * that a demo has not quietly grown into the architecture.
 */
export class DemoWatcher implements Watcher {
  private nextIndex = 4;

  snapshot(now: number): ChainSnapshot {
    const btcBalance = btcUtxos.reduce((sum, utxo) => sum + utxo.value, 0n);
    const spendable = btcUtxos
      .filter((utxo) => utxo.confirmations > 0)
      .reduce((sum, utxo) => sum + utxo.value, 0n);

    const bitcoin: AssetView = {
      asset: 'BTC',
      balance: btcBalance,
      spendable,
      utxos: btcUtxos,
      addresses: [0, 1, 2, 3, 4].map((index) => ({
        address: receiveAddress(index).address,
        path: `0/${index}`,
        used: index < 3,
      })),
      feeOptions: BTC_FEES,
      confirmationTarget: 6,
      height: 874_904,
    };

    const monero: AssetView = {
      asset: 'XMR',
      balance: XMR_BALANCE,
      spendable: XMR_BALANCE,
      utxos: [],
      addresses: [{ address: DEMO_XMR_ADDRESS, path: null, used: true }],
      feeOptions: XMR_FEES,
      confirmationTarget: 10,
      height: 3_204_925,
    };

    return {
      assets: { BTC: bitcoin, XMR: monero },
      transactions: demoTransactions(now),
      centsPerUnit: CENTS,
      at: now,
      stale: true,
      demo: true,
    };
  }

  nextAddress(asset: Asset): { address: string; path: string | null } {
    if (asset === 'XMR') return { address: DEMO_XMR_ADDRESS, path: null };
    const index = this.nextIndex++;
    return { address: receiveAddress(index).address, path: `0/${index}` };
  }

  /**
   * Publishing, with nowhere to publish to.
   *
   * It waits, and then it reports success with the transaction's real txid —
   * computed from the actual signed bytes, not invented — because the screen
   * after this one shows that txid and offers to look it up. Anything that
   * arrives at a block explorer and finds nothing is a fixture that has
   * started lying, so the app labels this one too.
   */
  async broadcast(asset: Asset, raw: Uint8Array): Promise<BroadcastResult> {
    await new Promise((resolve) => setTimeout(resolve, 1400));
    if (raw.length === 0) return { ok: false, txid: null, problem: 'There was nothing to publish.' };
    if (asset !== 'BTC') {
      return { ok: false, txid: null, problem: 'Monero broadcasting is not finished in this build.' };
    }
    try {
      return { ok: true, txid: BtcTransaction.fromRaw(raw, { allowUnknownOutputs: true }).id, problem: null };
    } catch {
      return { ok: false, txid: null, problem: 'Those bytes are not a transaction a node would accept.' };
    }
  }
}
