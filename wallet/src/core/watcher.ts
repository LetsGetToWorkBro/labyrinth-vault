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
 * ## What is real here
 *
 * Bitcoin: discovery, outputs, history, fee estimates, broadcast.
 *
 * Monero: the node's height and fee estimate, and a chain scan that finds
 * every output paid to the paired account and proves each amount against the
 * commitment on the chain. What it cannot do, and says so on every screen that
 * shows the number, is tell which of those outputs has since been spent. That
 * needs key images, key images need the spend key, and the spend key is in the
 * vault. `core/moneroscan.ts` is where that is argued at length.
 *
 * A Monero scan is also long. It runs a bounded number of blocks per refresh
 * and hands back where it got to, so the app can persist that, show it, and
 * pick the work up again rather than starting over every launch.
 */

import { openWatch, type BtcWallet } from '@vault/keys/bitcoin';
import type { Asset, Atoms, Transaction } from './model';
import type { AssetView, BroadcastResult, ChainSnapshot, FeeOption, Watcher } from './chain';
import { discover, type Discovery } from './discover';
import type { NodeConfig } from './nodes';
import { KeyImageBook, buildOutputsRequest, settle, type ImportOutcome } from './keyimages';
import {
  outputKey,
  progressFraction,
  scan,
  totalReceived,
  SPEND_BLINDNESS,
  type MoneroAccount,
  type Received,
  type ScanState,
  type SpendEvent,
} from './moneroscan';
import { live, type Transport } from '../net/http';
import { moneroBroadcastGate } from './moneroreadiness';
import * as esplora from '../net/esplora';
import * as monerod from '../net/monerod';

export interface WatcherNodes {
  btc: NodeConfig | null;
  xmr: NodeConfig | null;
}

/** The Monero half of what this watcher is watching, when there is one. */
export interface MoneroWatch {
  account: MoneroAccount;
  /** Where a previous run got to, from storage, or the birth height twice. */
  scan: ScanState;
}

/** What the app persists after a refresh, and what the screens read. */
export interface MoneroStatus {
  scan: ScanState;
  tip: number;
  /** Zero to one, measured from the birth height. */
  fraction: number;
  caughtUp: boolean;
  outputs: number;
  /** Outputs found whose amount could not be proved. */
  unvalued: number;
  /** Key images imported from the vault. Zero until the round trip runs. */
  images: number;
  /** Outputs known spent, subtracted from the balance. */
  spentOutputs: number;
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
  caveat: null,
});

/** What the key image book contributed, for the sentence under the number. */
export interface SpendCoverage {
  /** Images imported from the vault. */
  images: number;
  /** Found outputs with no image yet, counted as unspent by default. */
  uncovered: number;
  /** Outputs known spent and subtracted. */
  spentCount: number;
  /** Outputs known spent whose amount was never proved: the number reads
   *  high by whatever they were worth, and the sentence has to say so. */
  spentUnknown: number;
}

/**
 * The sentence under a Monero balance, which is never absent.
 *
 * Several things can be true at once and each changes what the number means,
 * so they are said in order of how badly somebody would be misled by not
 * knowing: a scan that has not finished, then amounts that could not be
 * proved, then what is known about spends.
 *
 * The last part is the one that changed shape when the key image round trip
 * landed. With no images, the permanent warning stands: this is what arrived.
 * With images covering everything, spends are subtracted and the sentence
 * says where the images came from, because their correctness rests on the
 * vault rather than on anything this device can prove. In between, both are
 * true at once and both get said.
 */
export function moneroCaveat(status: MoneroStatus, unvalued: number, spends?: SpendCoverage): string {
  const parts: string[] = [];
  if (!status.caughtUp) {
    parts.push(
      `Scanned to block ${status.scan.height} of ${status.tip}, which is ${Math.floor(status.fraction * 100)}%. Anything paid after that has not been looked for yet.`,
    );
  }
  if (unvalued > 0) {
    parts.push(
      `${unvalued} ${unvalued === 1 ? 'output was' : 'outputs were'} found whose amount could not be proved against the chain, so ${unvalued === 1 ? 'it is' : 'they are'} not in this total.`,
    );
  }

  if (!spends || spends.images === 0) {
    parts.push(SPEND_BLINDNESS);
  } else {
    if (spends.spentCount > 0) {
      parts.push(
        `${spends.spentCount} spent ${spends.spentCount === 1 ? 'output is' : 'outputs are'} subtracted, using key images your vault computed.`,
      );
    } else {
      parts.push('No spends found so far, checked using key images your vault computed.');
    }
    if (spends.spentUnknown > 0) {
      parts.push(
        `${spends.spentUnknown} spent ${spends.spentUnknown === 1 ? 'output has' : 'outputs have'} an unproved amount, so this number reads high by whatever ${spends.spentUnknown === 1 ? 'it was' : 'they were'} worth.`,
      );
    }
    if (spends.uncovered > 0) {
      parts.push(
        `${spends.uncovered} ${spends.uncovered === 1 ? 'output has' : 'outputs have'} no key image yet and ${spends.uncovered === 1 ? 'counts' : 'count'} as unspent until the vault answers for ${spends.uncovered === 1 ? 'it' : 'them'}.`,
      );
    }
  }
  return parts.join(' ');
}

/**
 * The Monero activity list, from what the scan established.
 *
 * Received rows group a transaction's outputs to this account and sum the
 * amounts it could prove. Spent rows exist only for spends the chain walk
 * itself saw, because those are the ones with a transaction and a height; a
 * spend that only `is_key_image_spent` reported moves the balance and cannot
 * make a row, since the node says "spent" and not where.
 *
 * The sent amount uses the same convention every watching wallet uses: what
 * the spent outputs were worth, minus anything the same transaction paid back
 * to this account, which is the change returning. The fee cannot be known
 * without the full transaction arithmetic, so it is zero rather than a guess,
 * and there is no counterparty because the chain does not publish one; that
 * silence is Monero working, not data gone missing.
 *
 * Outputs whose amount was never proved are left out of the rows: a listed
 * receipt of zero would be a claim, and the caveat under the balance already
 * counts them.
 */
export function moneroHistory(
  found: readonly Received[],
  spends: readonly SpendEvent[],
  book: KeyImageBook,
  tip: number,
): Transaction[] {
  const byOutput = new Map<string, Received>();
  for (const entry of found) byOutput.set(outputKey(entry), entry);
  const outputs = [...byOutput.values()];

  const rows: Transaction[] = [];

  /* Received, grouped by transaction. */
  const receivedByTx = new Map<string, Received[]>();
  for (const entry of outputs) {
    const list = receivedByTx.get(entry.txid) ?? [];
    list.push(entry);
    receivedByTx.set(entry.txid, list);
  }
  for (const [txid, entries] of receivedByTx) {
    const amount = entries.reduce((sum, entry) => sum + (entry.amount ?? 0n), 0n);
    if (amount === 0n && entries.every((entry) => entry.amount === null)) continue;
    const height = entries[0]!.height;
    rows.push({
      id: `xmr-in-${txid}`,
      asset: 'XMR',
      direction: 'received',
      amount,
      fee: 0n,
      counterparty: '',
      stage: 'confirmed',
      confirmations: Math.max(tip - height + 1, 1),
      confirmationTarget: 10,
      txid,
      blockHeight: height,
      at: entries[0]!.at * 1000,
      fiatCents: null,
    });
  }

  /* Spent, grouped by the transaction that did the spending. */
  const spendsByTx = new Map<string, SpendEvent[]>();
  for (const event of spends) {
    const list = spendsByTx.get(event.txid) ?? [];
    list.push(event);
    spendsByTx.set(event.txid, list);
  }
  const outputByImage = new Map<string, Received>();
  for (const entry of outputs) {
    const image = book.imageFor(entry.key);
    if (image) outputByImage.set(image, entry);
  }
  for (const [txid, events] of spendsByTx) {
    let spent = 0n;
    for (const event of events) {
      const output = outputByImage.get(event.image);
      if (output?.amount) spent += output.amount;
    }
    /* Change coming back is a receipt in the same transaction; net it off so
     * the row reads as what actually left, the way wallet2 shows it. */
    const changeBack = (receivedByTx.get(txid) ?? []).reduce(
      (sum, entry) => sum + (entry.amount ?? 0n),
      0n,
    );
    const net = spent - changeBack;
    if (net <= 0n) continue;
    /* The receipt row for the change is now half of a payment; drop it so the
     * same coins do not appear as both sent and received. */
    const changeRow = rows.findIndex((row) => row.id === `xmr-in-${txid}`);
    if (changeRow >= 0) rows.splice(changeRow, 1);
    const height = events[0]!.height;
    rows.push({
      id: `xmr-out-${txid}`,
      asset: 'XMR',
      direction: 'sent',
      amount: net,
      fee: 0n,
      counterparty: '',
      stage: 'confirmed',
      confirmations: Math.max(tip - height + 1, 1),
      confirmationTarget: 10,
      txid,
      blockHeight: height,
      at: events[0]!.at * 1000,
      fiatCents: null,
    });
  }

  rows.sort((a, b) => b.at - a.at);
  return rows;
}

/**
 * The watcher the app uses when a node is configured.
 *
 * Built with its transports rather than making them, so the tests drive it
 * with recorded node answers and the thing under test is the real class.
 */
export class NodeWatcher implements Watcher {
  private snap: ChainSnapshot;
  private readonly btcWallet: BtcWallet | null;
  private monero: MoneroWatch | null;
  /**
   * Every output found so far, keyed so a rescan cannot double-count.
   *
   * In memory only. The outputs themselves are cheap to find again given the
   * scan height, and writing a list of somebody's incoming payments to disk
   * would put on the filesystem exactly the thing the view key was protecting.
   * The height is persisted; the findings are not.
   */
  private readonly found = new Map<string, Received>();
  /**
   * The key image book, empty until the vault answers a round trip.
   *
   * In memory for the same reason `found` is: a list of key images on disk is
   * a list that names every future spend of this account, sitting on the
   * networked device. Importing again after a relaunch is one scan of a QR.
   */
  private readonly book = new KeyImageBook();
  /** Spends the walk has seen, keyed by image, for the activity list. A spend
   *  the settle query reports has no event: the node says "spent" and not
   *  where, so it moves the balance and cannot make a history row. */
  private readonly spendEvents = new Map<string, SpendEvent>();
  private moneroStatus: MoneroStatus | null = null;
  private xmrHistory: Transaction[] = [];
  private btcHistory: Transaction[] = [];

  constructor(
    private readonly nodes: WatcherNodes,
    zpub: string | null,
    private readonly transports: { btc: Transport | null; xmr: Transport | null } = {
      btc: nodes.btc ? live(nodes.btc.url) : null,
      xmr: nodes.xmr ? live(nodes.xmr.url) : null,
    },
    now: number = Date.now(),
    monero: MoneroWatch | null = null,
  ) {
    this.monero = monero;
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

    if (this.transports.btc && this.btcWallet) {
      const result = await this.refreshBitcoin(this.transports.btc, this.btcWallet);
      if (result.problem) problems.push({ asset: 'BTC', problem: result.problem });
      else {
        assets.BTC = result.view;
        this.btcHistory = result.transactions;
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
      /* One list, both chains, newest first. Each chain's history is only
       * replaced by its own successful refresh, so a Bitcoin failure does not
       * empty the Monero rows or the other way around. */
      transactions: [...this.btcHistory, ...this.xmrHistory].sort((a, b) => b.at - a.at),
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
        /* Bitcoin needs no caveat: the chain states amounts in the clear and
         * `discover` refuses to report a total it did not finish gathering. */
        caveat: null,
      },
    };
  }

  /** Where the Monero scan has got to, for the caller that persists it. */
  moneroProgress(): MoneroStatus | null {
    return this.moneroStatus;
  }

  /** The outputs the scan has found, for building an XMROUTPUTS payload. */
  moneroOutputs(): Received[] {
    return [...this.found.values()];
  }

  /** The XMROUTPUTS payload listing everything found, or why not. */
  keyImageRequest(): ReturnType<typeof buildOutputsRequest> {
    return buildOutputsRequest(this.moneroOutputs());
  }

  /**
   * Accept a vault's XMRKEYIMAGES reply.
   *
   * Images are kept only for outputs the scan really found; the next refresh
   * settles their history against the node and watches the chain from there.
   * The book changes immediately, but the *balance* changes on the next
   * refresh, because subtracting spends takes a look at the chain and this
   * method is called from a screen that should not block on a node.
   */
  importKeyImages(payload: Uint8Array): ImportOutcome {
    const known = new Set([...this.found.values()].map((entry) => entry.key));
    return this.book.offerReply(payload, known);
  }

  /**
   * Monero: the node's numbers, then one bounded pass of the chain scan.
   *
   * Bounded because a scan from a wallet's birth is tens of thousands of
   * requests and will not finish inside one pull-to-refresh. Each pass moves
   * the height forward, the caller writes it down, and the next refresh
   * carries on. A person watching this sees a percentage that climbs rather
   * than a spinner that never resolves.
   *
   * The balance it produces is what arrived. Read `core/moneroscan.ts` for why
   * that is not the same as what is left, and why saying so is not a
   * placeholder for a feature that is coming.
   */
  private async refreshMonero(
    transport: Transport,
  ): Promise<{ problem: string | null; view: AssetView }> {
    const reply = await monerod.info(transport);
    if (!reply.ok) return { problem: reply.problem, view: this.snap.assets.XMR };
    if (reply.value.syncing) {
      /* A node behind the chain answers happily and its answers are correct
       * for a past that is not now. Scanning against it would record a height
       * this wallet has not really passed. */
      return {
        problem: `That node is still catching up, at ${reply.value.height} of ${reply.value.targetHeight}.`,
        view: this.snap.assets.XMR,
      };
    }

    const tip = reply.value.height;
    const watch = this.monero;
    if (!watch) {
      return {
        problem: null,
        view: {
          ...this.snap.assets.XMR,
          height: tip,
          caveat: 'No Monero account has been paired, so nothing has been scanned for.',
        },
      };
    }

    const pass = await scan(transport, watch.account, watch.scan, tip, {
      watch: this.book.watch(),
    });
    /* The height advances even when the pass failed part way. `scan` leaves it
     * on the block it did not finish, so keeping it is resuming rather than
     * skipping, and throwing it away would redo work that succeeded. */
    this.monero = { ...watch, scan: pass.state };
    for (const output of pass.received) this.found.set(outputKey(output), output);
    for (const event of pass.spent) this.spendEvents.set(event.image, event);
    this.book.markSpent(pass.spent.map((event) => event.image));

    /* Newly imported images need one backward look: the spend may sit in a
     * block the walk passed before the image existed here. One question to the
     * node settles it; everything after is caught live by the walk. The
     * privacy cost of asking is real and is written up beside the call in
     * net/monerod.ts and in docs/monero-sync.md. */
    const unsettled = this.book.unsettled();
    if (unsettled.length > 0) {
      const answer = await monerod.isKeyImageSpent(transport, unsettled);
      if (answer.ok) {
        this.book.markSpent(answer.value.filter((entry) => entry.spent).map((entry) => entry.image));
        this.book.markSettled(unsettled);
      }
      /* A failed settle is not a failed refresh: the images stay unsettled and
       * the next refresh asks again. Until then those outputs count as
       * unspent, which is the same received-total assumption as before the
       * import, said by the caveat. */
    }

    const all = [...this.found.values()];
    const total = totalReceived(all);
    const balance = settle(all, this.book);
    this.xmrHistory = moneroHistory(all, [...this.spendEvents.values()], this.book, tip);
    const status: MoneroStatus = {
      scan: pass.state,
      tip,
      fraction: progressFraction(pass.state, tip),
      caughtUp: pass.caughtUp,
      outputs: total.outputs,
      unvalued: total.unknown,
      images: this.book.size(),
      spentOutputs: balance.spentCount + balance.spentUnknown,
    };
    this.moneroStatus = status;

    return {
      problem: pass.problem,
      view: {
        ...this.snap.assets.XMR,
        balance: balance.balance,
        /* Zero, and not because the scan is incomplete. Building a Monero
         * spend needs key images and ring members, neither of which this half
         * of the product has. A non-zero spendable here would put a send
         * button in front of somebody it cannot serve. */
        spendable: 0n,
        addresses: [{ address: watch.account.address, path: null, used: true }],
        height: tip,
        caveat: moneroCaveat(status, total.unknown, {
          images: this.book.size(),
          uncovered: balance.uncovered,
          spentCount: balance.spentCount,
          spentUnknown: balance.spentUnknown,
        }),
      },
    };
  }

  async broadcast(asset: Asset, raw: Uint8Array): Promise<BroadcastResult> {
    const transport = asset === 'BTC' ? this.transports.btc : this.transports.xmr;
    if (!transport) {
      return { ok: false, txid: null, problem: `No ${asset} node is set, so there is nothing to broadcast through.` };
    }

    if (asset === 'XMR') {
      /* The gate. A Monero spend may be built and signed as far as the
       * verified pieces reach, but it is not broadcast with real value until a
       * live node has accepted bytes this code produced. `core/moneroreadiness`
       * carries the whole reasoning; this is the chokepoint it guards. The app
       * is mainnet-only today, so the network is mainnet. */
      const gate = moneroBroadcastGate('mainnet');
      if (!gate.allowed) return { ok: false, txid: null, problem: gate.problem };
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
