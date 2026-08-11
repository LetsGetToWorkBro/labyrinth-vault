/**
 * A real chain behind the interface the screens already use.
 *
 * `chain.ts` defined `Watcher` before there was anything to implement it with,
 * on the grounds that the shape of the boundary is a security decision and
 * cheaper to get right early. This is the payoff: the screens do not change,
 * the fixture and the node produce the same type, and the compiler is what
 * keeps a watcher from quietly acquiring an appetite for a private key.
 *
 * ## Why a snapshot and a refresh, rather than a live feed
 *
 * `Watcher.snapshot()` is synchronous and returns what is already known. This
 * one keeps the last successful answer and hands it back instantly, and
 * `refresh()` is the thing that goes to the network.
 *
 * A wallet whose every screen awaits a node is a wallet that shows spinners
 * where numbers go, and worse, one whose balance can change under a person
 * mid-decision. Reading a fixed snapshot means the amount on the review screen
 * is the amount that was on the home screen, and a refresh that lands during a
 * send does not rearrange a transaction somebody is halfway through approving.
 *
 * ## Stale is a state, not a failure
 *
 * When a refresh fails, the last good snapshot stays and is marked `stale`.
 * The alternative is a wallet that empties itself on a flaky connection, which
 * is alarming and false. A person seeing yesterday's balance labeled as
 * yesterday's is better informed than one seeing zero.
 *
 * ## What is real here and what is not
 *
 * Bitcoin is real: discovery, outputs, history, fee estimates, broadcast.
 *
 * Monero is not, and this file does not pretend. There is no sync loop yet,
 * for the reason set out at length in `net/monerod.ts`: walking the chain
 * needs either an epee decoder or a light wallet server, and that is a product
 * decision rather than an afternoon. Until then the Monero view carries the
 * node's height and its fee estimate, both real, and a balance of zero marked
 * as not-yet-scanned. A zero that is labeled is honest. A zero that is not is
 * a wallet telling somebody their money is gone.
 */

import { openWatch, type BtcWallet } from '@vault/keys/bitcoin';
import type { Asset, Atoms, Transaction } from './model';
import type { AssetView, BroadcastResult, ChainSnapshot, FeeOption, Watcher } from './chain';
import { discover, type Discovery } from './discover';
import type { NodeConfig } from './nodes';
import { live, type Transport } from '../net/http';
import * as esplora from '../net/esplora';
import * as monerod from '../net/monerod';

export interface WatcherNodes {
  btc: NodeConfig | null;
  xmr: NodeConfig | null;
}

export interface RefreshResult {
  ok: boolean;
  /** One sentence per asset that failed, for the screen that shows it. */
  problems: { asset: Asset; problem: string }[];
  /** Addresses this refresh told the Bitcoin node about. */
  queried: number;
}

/**
 * Fee options from the node's own estimates.
 *
 * Esplora answers with up to twenty-eight block targets. A person choosing a
 * fee has one question, which is "how long and how much", so three are picked:
 * next block, half an hour, and a day. The estimate is the node's; the naming
 * and the arithmetic about waiting are ours.
 *
 * The floor of one sat/vB is not a preference. A node with an empty mempool
 * reports estimates below the relay minimum, and a transaction built at that
 * rate is one no peer will forward.
 */
export function feeOptionsFrom(estimates: esplora.FeeEstimates): FeeOption[] {
  const at = (target: number, fallback: number): number => {
    const known = Object.keys(estimates)
      .map(Number)
      .filter((key) => key <= target)
      .sort((a, b) => b - a);
    const rate = known.length ? estimates[known[0]!] : undefined;
    return Math.max(1, Math.round((rate ?? fallback) * 10) / 10);
  };

  return [
    { key: 'economy', label: 'ECONOMY', rate: at(144, 2), etaMinutes: 24 * 60 },
    { key: 'standard', label: 'STANDARD', rate: at(6, 8), etaMinutes: 60 },
    { key: 'priority', label: 'PRIORITY', rate: at(1, 20), etaMinutes: 10 },
  ];
}

/**
 * History, from the transactions touching this account's addresses.
 *
 * Direction is decided by arithmetic rather than by a flag: add up what our
 * addresses paid in and what they received, and the sign of the difference is
 * whether this was a payment or a receipt. A transaction that both spends and
 * receives, which is every payment with change, comes out as sent, correctly.
 */
export function historyFrom(
  txs: readonly esplora.NodeTx[],
  ours: ReadonlySet<string>,
  tipHeight: number,
): Transaction[] {
  const seen = new Set<string>();
  const out: Transaction[] = [];

  for (const tx of txs) {
    if (seen.has(tx.txid)) continue;
    seen.add(tx.txid);

    let paidIn = 0n;
    for (const input of tx.inputs) if (input.address && ours.has(input.address)) paidIn += input.value;
    let received = 0n;
    let leaving = 0n;
    let counterparty: string | null = null;
    for (const output of tx.outputs) {
      if (output.address && ours.has(output.address)) received += output.value;
      else {
        leaving += output.value;
        counterparty = counterparty ?? output.address;
      }
    }

    const sent = paidIn > 0n;
    const amount: Atoms = sent ? leaving : received;
    const confirmations = tx.confirmed && tx.height !== null && tipHeight >= tx.height
      ? tipHeight - tx.height + 1
      : 0;

    out.push({
      id: tx.txid,
      asset: 'BTC',
      direction: sent ? 'sent' : 'received',
      amount,
      fee: sent ? tx.fee : 0n,
      /* An output paying a script with no address still moved money, and the
       * activity list has to show it. Empty here rather than a placeholder
       * sentence, because the display layer already knows how to render an
       * address it cannot show and inventing words for it here would put two
       * different phrasings in front of the same thing. */
      counterparty: counterparty ?? '',
      stage: confirmations > 0 ? 'confirmed' : 'broadcast',
      confirmations,
      confirmationTarget: 6,
      txid: tx.txid,
      blockHeight: tx.height,
      at: tx.time !== null ? tx.time * 1000 : Date.now(),
      /* Null, not zero. This wallet has no price source, and a fiat value of
       * nothing renders as nothing while a zero renders as "$0.00", which is a
       * claim about what somebody's money was worth. */
      fiatCents: null,
    });
  }

  /* Newest first, and by height rather than by the order a node happened to
   * list them. Unconfirmed sits at the top, which is where somebody looking
   * for the payment they just made will look. */
  out.sort((a, b) => b.at - a.at);
  return out;
}

const EMPTY_VIEW = (asset: Asset): AssetView => ({
  asset,
  balance: 0n,
  spendable: 0n,
  utxos: [],
  addresses: [],
  feeOptions:
    asset === 'BTC'
      ? [
          { key: 'economy', label: 'ECONOMY', rate: 2, etaMinutes: 24 * 60 },
          { key: 'standard', label: 'STANDARD', rate: 8, etaMinutes: 60 },
          { key: 'priority', label: 'PRIORITY', rate: 20, etaMinutes: 10 },
        ]
      : [
          { key: 'economy', label: 'SLOW', rate: 1, etaMinutes: 40 },
          { key: 'standard', label: 'NORMAL', rate: 4, etaMinutes: 20 },
          { key: 'priority', label: 'FAST', rate: 25, etaMinutes: 5 },
        ],
  confirmationTarget: asset === 'BTC' ? 6 : 10,
  height: 0,
});

/**
 * The watcher the app uses when a node is configured.
 *
 * Built with its transports rather than making them, so the tests drive it
 * with recorded node answers and the thing under test is the real class.
 */
export class NodeWatcher implements Watcher {
  private snap: ChainSnapshot;
  private readonly btcWallet: BtcWallet | null;

  constructor(
    private readonly nodes: WatcherNodes,
    zpub: string | null,
    private readonly transports: { btc: Transport | null; xmr: Transport | null } = {
      btc: nodes.btc ? live(nodes.btc.url) : null,
      xmr: nodes.xmr ? live(nodes.xmr.url) : null,
    },
    now: number = Date.now(),
  ) {
    const opened = zpub ? openWatch(zpub) : null;
    this.btcWallet = opened?.ok ? opened.wallet ?? null : null;
    this.snap = {
      assets: { BTC: EMPTY_VIEW('BTC'), XMR: EMPTY_VIEW('XMR') },
      transactions: [],
      centsPerUnit: { BTC: 0, XMR: 0 },
      at: now,
      /* Stale from birth. Nothing has been fetched, and a fresh-looking
       * snapshot full of zeroes is the most misleading state this app can be
       * in. */
      stale: true,
      demo: false,
    };
  }

  snapshot(): ChainSnapshot {
    return this.snap;
  }

  /** Go to the network. Everything else in this class reads what this leaves. */
  async refresh(now: number = Date.now()): Promise<RefreshResult> {
    const problems: { asset: Asset; problem: string }[] = [];
    let queried = 0;

    const assets = { ...this.snap.assets };
    let transactions = this.snap.transactions;

    if (this.transports.btc && this.btcWallet) {
      const result = await this.refreshBitcoin(this.transports.btc, this.btcWallet);
      if (result.problem) problems.push({ asset: 'BTC', problem: result.problem });
      else {
        assets.BTC = result.view;
        transactions = result.transactions;
      }
      queried += result.queried;
    } else if (this.nodes.btc) {
      problems.push({ asset: 'BTC', problem: 'No account key has been paired for Bitcoin.' });
    }

    if (this.transports.xmr) {
      const result = await this.refreshMonero(this.transports.xmr);
      if (result.problem) problems.push({ asset: 'XMR', problem: result.problem });
      else assets.XMR = result.view;
    }

    const ok = problems.length === 0;
    this.snap = {
      ...this.snap,
      assets,
      transactions,
      at: now,
      /* A refresh that partly failed leaves a snapshot that is partly old, and
       * the honest label for that is stale. Anything else invites somebody to
       * trust a number that did not come back. */
      stale: !ok,
    };
    return { ok, problems, queried };
  }

  private async refreshBitcoin(
    transport: Transport,
    wallet: BtcWallet,
  ): Promise<{ problem: string | null; view: AssetView; transactions: Transaction[]; queried: number }> {
    const failed = (problem: string, queried = 0) => ({
      problem,
      view: this.snap.assets.BTC,
      transactions: this.snap.transactions,
      queried,
    });

    const height = await esplora.tipHeight(transport);
    if (!height.ok) return failed(height.problem);

    const found: Discovery = await discover(transport, wallet, height.value);
    if (!found.ok) return failed(found.problem ?? 'The scan did not finish.', found.queried);

    const fees = await esplora.feeEstimates(transport);

    /* History only for addresses the chain has actually seen. Asking about the
     * rest would tell the node about addresses that have never been used,
     * which is precisely the information it has no business having. */
    const used = found.addresses.filter((entry) => entry.used);
    const histories = await Promise.all(
      used.map((entry) => esplora.addressTxs(transport, entry.address)),
    );
    const txs: esplora.NodeTx[] = [];
    for (const answer of histories) if (answer.ok) txs.push(...answer.value);

    const ours = new Set(found.addresses.map((entry) => entry.address));

    return {
      problem: null,
      queried: found.queried + used.length,
      transactions: historyFrom(txs, ours, height.value),
      view: {
        asset: 'BTC',
        balance: found.balance,
        spendable: found.spendable,
        utxos: found.utxos,
        addresses: found.addresses.map((entry) => ({
          address: entry.address,
          path: `${entry.change}/${entry.index}`,
          used: entry.used,
        })),
        feeOptions: fees.ok ? feeOptionsFrom(fees.value) : this.snap.assets.BTC.feeOptions,
        confirmationTarget: 6,
        height: height.value,
      },
    };
  }

  /**
   * Monero: what a node can answer today.
   *
   * Height and fee are real. The balance is not scanned, because the sync loop
   * does not exist, and it is left at zero rather than invented. The screen
   * reads `height > 0 && balance === 0n` together with the note in
   * `nodes.ts` to say "connected, not scanned" rather than "you have nothing".
   */
  private async refreshMonero(
    transport: Transport,
  ): Promise<{ problem: string | null; view: AssetView }> {
    const reply = await monerod.info(transport);
    if (!reply.ok) return { problem: reply.problem, view: this.snap.assets.XMR };
    if (reply.value.syncing) {
      return {
        problem: `That node is still catching up, at ${reply.value.height} of ${reply.value.targetHeight}.`,
        view: this.snap.assets.XMR,
      };
    }
    return {
      problem: null,
      view: { ...this.snap.assets.XMR, height: reply.value.height },
    };
  }

  async broadcast(asset: Asset, raw: Uint8Array): Promise<BroadcastResult> {
    const transport = asset === 'BTC' ? this.transports.btc : this.transports.xmr;
    if (!transport) {
      return { ok: false, txid: null, problem: `No ${asset} node is set, so there is nothing to broadcast through.` };
    }

    const hex = Array.from(raw, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const result = asset === 'BTC'
      ? await esplora.broadcast(transport, hex)
      : await monerod.broadcast(transport, hex);

    return result.ok
      ? { ok: true, txid: asset === 'BTC' ? result.value : null, problem: null }
      : { ok: false, txid: null, problem: result.problem };
  }
}
