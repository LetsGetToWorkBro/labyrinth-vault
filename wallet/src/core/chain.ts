/**
 * What the chain looks like from here, and where these numbers really come
 * from.
 *
 * ## The honest disclosure, first
 *
 * This build has no network code in it. Not as a security property — the
 * online half is *supposed* to have a network, that is the entire division of
 * labour — but because this is the frontend, and the node client behind it is
 * not written yet. Every balance, fee estimate, price and confirmation count
 * in the running app comes from `demo.ts`, which is a fixture.
 *
 * That is said here, in the file the numbers come out of, rather than only in
 * a README, because a wallet screenshot showing $48,291.82 is a claim about
 * somebody's money and it should be impossible to read this code and not know
 * it is fiction. The app says so on screen too, in the status line: `DEMO
 * DATA`. When the real watcher lands, that line disappears with it.
 *
 * ## Why there is an interface at all, this early
 *
 * Because the shape of the boundary is a security decision and it is cheaper
 * to get right now than later. A `Watcher` is allowed to know addresses,
 * unspent outputs, fee markets and prices. It is not given anything else, and
 * there is nothing in these types it could ask for. When this is a real
 * client talking to Electrum servers or a Monero daemon, the compiler is the
 * thing keeping the boundary where it is: a watcher that wanted a key would
 * have to change this file, in a diff somebody reviews.
 *
 * The other reason is that `broadcast` belongs *here*, on the online side. The
 * vault signs and hands back bytes; it never publishes anything and cannot.
 * Putting the broadcast call in the same interface as the balance lookups is
 * the architecture written down as a type.
 */

import type { Asset, Atoms, Transaction } from './model';

/** One unspent output this wallet can spend, given a signature it cannot make. */
export interface Utxo {
  txid: string;
  vout: number;
  value: Atoms;
  /** Which of our addresses holds it, so the PSBT can carry the derivation. */
  address: string;
  /** `change/index` under the account key. */
  path: { change: 0 | 1; index: number };
  script: Uint8Array;
  /** Depth. Unconfirmed coins are spendable and worth flagging, not hiding. */
  confirmations: number;
}

/**
 * A fee choice, presented as three and not as a slider.
 *
 * A slider asks the user to have an opinion about sat/vB. Three named options
 * with a real time estimate and a real cost in their own currency asks them
 * the question they actually have, which is "how long, and how much".
 */
export interface FeeOption {
  key: 'economy' | 'standard' | 'priority';
  label: string;
  /** sat/vB for Bitcoin; a multiplier over the base for Monero. */
  rate: number;
  /** Honest range, not a promise. Rendered as "about 30 minutes". */
  etaMinutes: number;
}

export interface AssetView {
  asset: Asset;
  balance: Atoms;
  /** Confirmed only. The difference is worth showing when there is one. */
  spendable: Atoms;
  utxos: Utxo[];
  addresses: { address: string; path: string | null; used: boolean }[];
  feeOptions: FeeOption[];
  /** Blocks this chain treats as settled. */
  confirmationTarget: number;
  /** Tip height, for the "N confirmations" arithmetic. */
  height: number;
  /**
   * Why the balance above is not quite what it looks like, when it is not.
   *
   * Required rather than optional, so that adding an asset means answering the
   * question rather than forgetting it. It exists because of Monero: a view
   * key finds every payment coming in and cannot tell which of them has since
   * been spent, so the honest figure is what arrived rather than what is left.
   * It is also where a scan that has not reached the tip says how far it got.
   *
   * Null means the number under the word BALANCE means what that word normally
   * means, and the screens show nothing extra.
   */
  caveat: string | null;
}

export interface ChainSnapshot {
  assets: Record<Asset, AssetView>;
  transactions: Transaction[];
  /** Cents per whole unit. Integer, because money. */
  centsPerUnit: Record<Asset, number>;
  /** When this snapshot was taken. */
  at: number;
  /** True when it is the last one we managed to get, not a fresh one. */
  stale: boolean;
}

export interface BroadcastResult {
  ok: boolean;
  txid: string | null;
  /** A sentence for a person, when it failed. Node errors are not that. */
  problem: string | null;
}

/** What a caller knows about a signed transaction that the raw bytes do not say. */
export interface BroadcastOptions {
  /** The network the transaction was built for. The Monero mainnet gate reads
   *  this: a stagenet transaction is not held by the mainnet gate, which is how
   *  the evidence to lift it gets made. Defaults to mainnet, the safe reading. */
  network?: 'mainnet' | 'stagenet' | 'testnet';
  /** The transaction id, for chains whose broadcast reply does not echo one.
   *  monerod answers with a status, not an id, so the id computed at signing is
   *  passed through here rather than reconstructed. */
  txid?: string;
}

/**
 * The one thing the online half is for.
 *
 * Deliberately asynchronous even in the fixture, because the screen that waits
 * on it has to be designed for waiting: a broadcast that resolves instantly in
 * development and takes four seconds against a real node produces a "success"
 * animation nobody ever tested at the length it actually runs.
 */
export interface Watcher {
  snapshot(now: number): ChainSnapshot;
  broadcast(asset: Asset, raw: Uint8Array, options?: BroadcastOptions): Promise<BroadcastResult>;
}

/* There is no `nextAddress` here on purpose. Handing out a fresh address means
 * remembering which ones were handed out, or the gap limit stops meaning
 * anything, and this build has nowhere to remember it. The receive screen
 * shows the first address the chain has not seen a payment to, which is
 * derivable from the snapshot and needs no memory. When there is storage, this
 * is where rotation goes. */
