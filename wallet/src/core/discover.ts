/**
 * Finding your own coins, and the arithmetic that decides when to stop.
 *
 * ## The gap limit, and why it is a real number rather than a convention
 *
 * A watch-only wallet holds one account key and can derive an unlimited number
 * of addresses from it. Nothing on the chain says which of them you have used.
 * So a light client walks outward, asking the node about each address in turn,
 * and stops after some run of consecutive unused ones. That run is the gap
 * limit, and BIP44 fixes it at twenty.
 *
 * Getting it wrong is not symmetrical. Too large costs queries and privacy.
 * Too small loses money: an address past the gap is never asked about, its
 * balance never appears, and the owner concludes the coins are gone. That
 * happens to real people, usually after they handed out fifty addresses to a
 * payment processor.
 *
 * So twenty, matching every other wallet, and a note in the type that says
 * raising it is the safe direction.
 *
 * ## What this costs in privacy, stated plainly
 *
 * Every address asked about is an address the node now knows somebody cares
 * about. Asked in sequence, from one IP, within a second, they are obviously
 * one wallet. A node operator watching this traffic learns the whole account.
 *
 * That is inherent to light clients and cannot be fixed by being clever here.
 * What it can be is honest: the app names the node it is talking to, there is
 * no default node, and running your own is the documented answer rather than
 * an advanced option.
 *
 * The one thing this file does do about it is not making the leak worse than
 * it has to be. Addresses are asked about in one pass, batched by the caller's
 * concurrency, and the scan stops at the gap. It does not poll, it does not
 * re-scan on every screen, and it does not ask about addresses it has no
 * reason to ask about.
 *
 * ## Where the addresses come from
 *
 * `@vault/keys/bitcoin`, the same derivation the vault signs with, checked
 * against the BIP84 vectors in the vault's own suite. Not a second
 * implementation: a wallet that derived addresses differently from the device
 * holding the keys would show a balance nobody can spend.
 */

import { addressAt, type BtcWallet } from '@vault/keys/bitcoin';
import { addressActivity, addressUtxos, type NodeUtxo } from '../net/esplora';
import type { Transport } from '../net/http';
import type { Atoms } from './model';
import type { Utxo } from './chain';

/**
 * Consecutive unused addresses that end a scan. BIP44's number.
 *
 * Raising this is safe and costs queries. Lowering it loses coins, silently,
 * and the owner finds out when a balance is wrong rather than when a scan
 * fails. If this ever needs to move, it moves up.
 */
export const GAP_LIMIT = 20;

/** How many addresses to ask about at once. */
const BATCH = 10;

/** A cap, so a wallet pointed at a hostile node cannot be walked forever. */
export const MAX_ADDRESSES = 500;

export interface DiscoveredAddress {
  address: string;
  change: 0 | 1;
  index: number;
  used: boolean;
  script: Uint8Array;
}

export interface Discovery {
  ok: boolean;
  problem: string | null;
  addresses: DiscoveredAddress[];
  utxos: Utxo[];
  balance: Atoms;
  spendable: Atoms;
  /** How many addresses were asked about, which is what the node learned. */
  queried: number;
  /**
   * True when a branch hit `MAX_ADDRESSES` before it hit the gap limit, which
   * means the walk stopped somewhere the account was still in use.
   *
   * Carried separately from `problem` so a caller can tell a cap from a node
   * failure, and reported as a refusal either way. Both of the loop's exits
   * used to return `problem: null`, so a wallet with more used addresses than
   * the cap got `ok: true` and a balance covering only the part that was
   * reached, which is the same silent shortfall the gap limit exists to
   * prevent, arriving through the mechanism meant to bound it.
   */
  truncated: boolean;
}

/**
 * Walk one branch of the account until the gap limit is reached.
 *
 * Returns every address seen, used or not, because the receive screen wants
 * the first unused one and the send flow wants the used ones' outputs.
 */
async function walkBranch(
  transport: Transport,
  wallet: BtcWallet,
  change: 0 | 1,
): Promise<{ problem: string | null; addresses: DiscoveredAddress[]; queried: number; truncated: boolean }> {
  const addresses: DiscoveredAddress[] = [];
  let index = 0;
  let sinceUsed = 0;
  let queried = 0;

  while (sinceUsed < GAP_LIMIT && index < MAX_ADDRESSES) {
    const batch: DiscoveredAddress[] = [];
    for (let i = 0; i < BATCH && index + i < MAX_ADDRESSES; i++) {
      const derived = addressAt(wallet, change, index + i);
      batch.push({
        address: derived.address,
        change,
        index: index + i,
        used: false,
        script: derived.script,
      });
    }

    const activity = await Promise.all(
      batch.map((entry) => addressActivity(transport, entry.address)),
    );
    queried += batch.length;

    for (let i = 0; i < batch.length; i++) {
      const answer = activity[i]!;
      if (!answer.ok) {
        /* One address failing means the node is unwell or unreachable, and a
         * partial scan is worse than none: it produces a balance that is
         * confidently too low. Stop and say so. */
        return { problem: answer.problem, addresses, queried, truncated: false };
      }
      const entry = batch[i]!;
      entry.used = answer.value.used;
      addresses.push(entry);
      sinceUsed = entry.used ? 0 : sinceUsed + 1;
      if (sinceUsed >= GAP_LIMIT) break;
    }

    index += batch.length;
  }

  /* Stopping at the cap with the gap still unclosed means the account was
   * still in use where the walk gave up, so there are addresses beyond it that
   * were never asked about. The gap limit is the honest stop; the cap is a
   * leash against a hostile node, and reaching it is not an answer. */
  return { problem: null, addresses, queried, truncated: sinceUsed < GAP_LIMIT };
}

/**
 * Everything this account owns, according to one node.
 *
 * Both branches: receive addresses and change addresses. Change has to be
 * walked too, or a wallet that has spent once shows a balance missing its own
 * change, which is the most alarming possible way for a wallet to be wrong.
 */
export async function discover(
  transport: Transport,
  wallet: BtcWallet,
  tipHeight: number,
): Promise<Discovery> {
  const empty: Discovery = {
    ok: false,
    problem: null,
    addresses: [],
    utxos: [],
    balance: 0n,
    spendable: 0n,
    queried: 0,
    truncated: false,
  };

  const receive = await walkBranch(transport, wallet, 0);
  if (receive.problem) return { ...empty, problem: receive.problem, queried: receive.queried };

  const change = await walkBranch(transport, wallet, 1);
  if (change.problem) {
    return { ...empty, problem: change.problem, queried: receive.queried + change.queried };
  }

  const addresses = [...receive.addresses, ...change.addresses];
  const queried = receive.queried + change.queried;

  /* The same policy the node-error branch already applies, for the same
   * reason: a partial scan produces a balance that is confidently too low, and
   * a number under the word BALANCE that is missing coins is worse than no
   * number at all. Nothing is lost on the chain, and saying which branch ran
   * out is what tells whoever reads this that the cap is what has to move. */
  if (receive.truncated || change.truncated) {
    const branch = receive.truncated ? 'receiving' : 'change';
    return {
      ...empty,
      truncated: true,
      queried,
      problem: `This account has used more than ${MAX_ADDRESSES} ${branch} addresses, which is further than this wallet walks. The balance it could show would be missing coins, so it is showing none. The coins are on the chain and a wallet that walks further will find them.`,
    };
  }

  /* Only the used ones can hold anything, so only they are asked for outputs.
   * That is a real reduction in what the node is told: an account with three
   * used addresses out of forty-four asks three questions here, not forty-four. */
  const used = addresses.filter((entry) => entry.used);
  const fetched = await Promise.all(used.map((entry) => addressUtxos(transport, entry.address)));

  const utxos: Utxo[] = [];
  for (let i = 0; i < used.length; i++) {
    const answer = fetched[i]!;
    if (!answer.ok) return { ...empty, problem: answer.problem, queried: queried + used.length };
    const entry = used[i]!;
    for (const raw of answer.value) {
      utxos.push(toUtxo(raw, entry, tipHeight));
    }
  }

  /* Deterministic order, so two scans of the same wallet build the same
   * transaction. Coin selection reads this list, and a list whose order
   * depends on how fast a node answered is a transaction that changes shape
   * between the screen and the signature. */
  utxos.sort((a, b) => (a.txid === b.txid ? a.vout - b.vout : a.txid < b.txid ? -1 : 1));

  const balance = utxos.reduce((sum, utxo) => sum + utxo.value, 0n);
  const spendable = utxos
    .filter((utxo) => utxo.confirmations > 0)
    .reduce((sum, utxo) => sum + utxo.value, 0n);

  return { ok: true, problem: null, addresses, utxos, balance, spendable, queried: queried + used.length, truncated: false };
}

function toUtxo(raw: NodeUtxo, entry: DiscoveredAddress, tipHeight: number): Utxo {
  /* Confirmations counted from the tip the same snapshot was taken at, so a
   * screen never shows a coin with more confirmations than the chain has
   * blocks. An unconfirmed output is zero, not one. */
  const confirmations =
    raw.confirmed && raw.height !== null && tipHeight >= raw.height ? tipHeight - raw.height + 1 : 0;

  return {
    txid: raw.txid,
    vout: raw.vout,
    value: raw.value,
    address: entry.address,
    path: { change: entry.change, index: entry.index },
    script: entry.script,
    confirmations,
  };
}

/**
 * The first address the chain has not seen, which is what to hand out next.
 *
 * Not a counter. A counter needs somewhere to remember what it handed out, and
 * a wallet that forgets its counter starts handing out an address it already
 * gave somebody. Derived from the scan, this is stable across launches and
 * across devices holding the same key, and it advances exactly when a payment
 * arrives.
 *
 * Null when every address in the walk has been paid to, rather than the first
 * one. That fallback handed out an address the chain had already seen, which
 * is the one thing this function exists not to do: it links the next payment
 * to the last one and it is invisible on screen. A successful `discover` can
 * no longer produce that list, since a branch still in use at the cap is now a
 * refusal, so this is the shape of the type agreeing with the shape of the
 * code rather than a live case.
 */
export function nextReceiveAddress(addresses: readonly DiscoveredAddress[]): DiscoveredAddress | null {
  const receiving = addresses.filter((entry) => entry.change === 0);
  return receiving.find((entry) => !entry.used) ?? null;
}
