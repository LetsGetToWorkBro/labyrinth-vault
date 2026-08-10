/**
 * What the wallet knows.
 *
 * The online half is allowed to know a great deal — balances, addresses,
 * history, fee markets — and none of it is a secret. That is the whole reason
 * this half can be an everyday phone with a network on it. There is exactly
 * one thing missing from every type in this file, and its absence is the
 * product: nothing here holds a private key, and nothing here can be turned
 * into one.
 *
 * The types are written so that is checkable rather than promised. A wallet is
 * a watch-only descriptor and a list of addresses. A transaction the user is
 * building is a `Draft`, and a draft has no signature field to fill in. The
 * only thing that turns a draft into something broadcastable is a signature
 * that arrived from outside this device, through a camera, and the type for
 * that is `Signed`, which cannot be constructed from a `Draft` alone.
 *
 * If a future version needs a key here, it needs a different file, a different
 * argument, and a very good reason.
 */

/** The two chains this wallet watches. Nothing else, on purpose. */
export type Asset = 'BTC' | 'XMR';

/** Smallest units: satoshi for Bitcoin, piconero for Monero. bigint always,
 *  because a float is a rounding error waiting for somebody's savings. */
export type Atoms = bigint;

export const ATOMS_PER_UNIT: Record<Asset, bigint> = {
  BTC: 100_000_000n,
  XMR: 1_000_000_000_000n,
};

export const DECIMALS: Record<Asset, number> = { BTC: 8, XMR: 12 };

export const TICKER_NAME: Record<Asset, string> = { BTC: 'BITCOIN', XMR: 'MONERO' };

// ------------------------------------------------------------------- wallet

/**
 * A watch-only account, which is all this device is ever given.
 *
 * For Bitcoin that is an extended public key: enough to derive every address
 * the vault will ever use, and no help at all in spending from them. For
 * Monero it is the private *view* key and the primary address, which is the
 * equivalent trade — the view key reads incoming payments and cannot author an
 * outgoing one.
 */
export interface WatchOnlyAccount {
  asset: Asset;
  /** zpub for Bitcoin, primary address for Monero. Display-truncated in UI. */
  descriptor: string;
  /** Human label for where it came from. */
  source: string;
  /** When the vault handed this over, as a wall-clock millisecond stamp. */
  importedAt: number;
}

/** One address this wallet can receive on. Derived from the account key. */
export interface ReceiveAddress {
  asset: Asset;
  address: string;
  /** BIP32 tail, e.g. `0/7`. Null for Monero, which has one address here. */
  path: string | null;
  /** True once anything has ever been sent to it. */
  used: boolean;
}

// -------------------------------------------------------------- transactions

export type Direction = 'sent' | 'received';

/**
 * Where a transaction is in the two-device loop.
 *
 * These are not decorations. The whole architecture of the product is legible
 * from this list: the wallet can reach `prepared`, `sent-to-vault`,
 * `broadcast` and `confirmed` on its own, and it can reach `signed` only
 * because a different device did something. `awaiting-signature` is the state
 * where this device is deliberately useless.
 */
export type Stage =
  /** Built here. Unsigned. Worth nothing to anybody. */
  | 'prepared'
  /** Shown to the vault as QR frames. Still unsigned. */
  | 'sent-to-vault'
  /** The vault is rendering it to a person. Nothing to do but wait. */
  | 'awaiting-signature'
  /** A signature came back and matched what was prepared. */
  | 'signed'
  /** Handed to the network by this device. Not by the vault. */
  | 'broadcast'
  /** In a block, with the depth to prove it. */
  | 'confirmed'
  /** Rejected, replaced, or abandoned. */
  | 'failed';

export const STAGE_ORDER: Stage[] = [
  'prepared',
  'sent-to-vault',
  'awaiting-signature',
  'signed',
  'broadcast',
  'confirmed',
];

/** The six words the journey glyph draws, in order. */
export const JOURNEY: { stage: Stage; label: string; by: 'wallet' | 'vault' }[] = [
  { stage: 'prepared', label: 'PREPARED', by: 'wallet' },
  { stage: 'sent-to-vault', label: 'SENT TO VAULT', by: 'wallet' },
  { stage: 'awaiting-signature', label: 'VERIFIED', by: 'vault' },
  { stage: 'signed', label: 'SIGNED', by: 'vault' },
  { stage: 'broadcast', label: 'BROADCAST', by: 'wallet' },
  { stage: 'confirmed', label: 'CONFIRMED', by: 'wallet' },
];

export interface Transaction {
  id: string;
  asset: Asset;
  direction: Direction;
  /** What moved, not counting the fee. */
  amount: Atoms;
  fee: Atoms;
  /** Counterparty address, truncated only at the display layer. */
  counterparty: string;
  stage: Stage;
  /** Depth in blocks. 0 while unconfirmed. */
  confirmations: number;
  /** What this chain counts as settled. 6 for Bitcoin, 10 for Monero. */
  confirmationTarget: number;
  txid: string | null;
  blockHeight: number | null;
  /** Milliseconds since epoch, of the most recent stage change. */
  at: number;
  /** Fiat value at the time it happened, in whole cents. */
  fiatCents: number | null;
  /** Present only on transactions this wallet built, which is the only kind
   *  that has a vault story to tell. */
  journey?: { stage: Stage; at: number }[];
}

// ------------------------------------------------------------- draft + wire

/**
 * A payment being built. Unsigned by construction — there is nowhere to put a
 * signature, and nothing in this package can produce one.
 */
export interface Draft {
  asset: Asset;
  recipient: string;
  amount: Atoms;
  fee: Atoms;
  feeRate: number;
  /** What goes on the wire to the vault: the unsigned transaction bytes. */
  unsigned: Uint8Array;
  /** Digest of `unsigned`, computed when the draft was made and never
   *  recomputed from anything that arrives later. See `verifySigned`. */
  digest: string;
  createdAt: number;

  /* The three fields below are the *intent*, recorded before the vault sees
   * anything, and they are what a returned signature gets compared against.
   * They are never re-read from what comes back — a record that updates itself
   * from the thing it is supposed to be checking is not a record. */

  /** Exactly which coins this spends. Order-insensitive on comparison. */
  inputs: { txid: string; vout: number }[];
  /** What those coins are worth in total, which is how the fee is recomputed
   *  from a finished transaction that no longer carries its input values. */
  inputTotal: Atoms;
  /** Our own change addresses in this transaction. Any output that is neither
   *  the recipient nor one of these is somebody else being paid. */
  changeAddresses: string[];
  /** True for a payload whose format is a stand-in rather than the real one.
   *  Monero, today. Shown on screen; never silently true. */
  provisional?: boolean;
}

/** What came back from the camera, before anybody has decided to trust it. */
export interface SignedReturn {
  bytes: Uint8Array;
  /** The digest the vault says these bytes finish. */
  claimsDigest: string;
}

// --------------------------------------------------------------- vault link

/**
 * The state of the link to the vault, which is not a connection.
 *
 * `lastSession` and `lastVerified` are deliberately two fields. A session is
 * any handoff that happened; a verified session is one where what came back
 * matched what was sent. Collapsing them means a signature that did *not*
 * match gets recorded on the security screen as the last time this device
 * verified something, which is the opposite of what happened.
 *
 * There is no socket, no pairing radio and no session key. "Connected" here
 * means this wallet holds a watch-only account the vault exported, and knows
 * how to render frames the vault can read. The vault does not know this device
 * exists, and cannot be reached — the wallet can only put a QR on the screen
 * and hope a person is holding the other phone.
 *
 * Naming that honestly matters, because a user who believes there is a live
 * link will not understand why signing needs them to go and get something.
 */
export type VaultLink =
  /** Never paired. The wallet has no account key and can do nothing. */
  | { state: 'unpaired' }
  /** Paired, and the vault is presumed to be in a drawer, which is correct. */
  | { state: 'ready'; pairedAt: number; lastSession: number | null; lastVerified: number | null; label: string }
  /** Mid-handoff: frames on screen, or camera open, right now. */
  | { state: 'in-session'; pairedAt: number; lastSession: number | null; lastVerified: number | null; label: string };

export interface Prices {
  /** Whole cents per whole unit, so BTC at $118,000 is 11_800_000. */
  centsPerUnit: Record<Asset, number>;
  fetchedAt: number;
  /** True when the number on screen is the last one we got, not a fresh one. */
  stale: boolean;
}
