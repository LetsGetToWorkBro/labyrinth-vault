/**
 * What the chain looks like from here, and where these numbers really come
 * from.
 *
 * ## The honest disclosure, first
 *
 * The numbers in the running app are real, and they were not always. This file
 * used to open by saying that every balance, fee estimate and confirmation
 * count came from `demo.ts`, and that the app put a `DEMO DATA` chip over the
 * total to say so. Both stopped being true when `NodeWatcher` landed: the
 * store builds only that, it asks an Esplora server and a monerod for
 * everything under the word BALANCE, and `Watchers` never constructs a
 * `DemoWatcher` at all. The fixture is still in the tree, and it is now only
 * the test suite's wallet.
 *
 * The disclosure is kept, correct, in the file the numbers come out of rather
 * than only in a README, because a wallet screenshot showing $48,291.82 is a
 * claim about somebody's money. What is worth knowing here now is the other
 * direction: these figures come from one node, chosen by the user, with no
 * default and no second opinion. `caveat` below is where a view says what its
 * own number is not.
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

/* There is no `nextAddress` here on purpose, and storage arriving did not
 * change that. A counter has to be remembered, and a wallet that loses its
 * counter hands out an address it already gave somebody, which links two
 * payments that had no reason to be linked. Both places that need an index
 * derive it from the scan instead: `nextReceiveAddress` for what to hand out,
 * `nextChangeIndex` for where change goes. Neither needs memory and neither
 * can drift out of the window the gap limit defines, which is what the change
 * index did for as long as it was a number chosen in the store. */
