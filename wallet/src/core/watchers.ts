/**
 * One watcher per account, and the thing that holds them.
 *
 * ## Why this exists rather than a bigger NodeWatcher
 *
 * `NodeWatcher` reads one Bitcoin account key and one Monero account. That was
 * right when a wallet could only be paired to a vault, and it stopped being
 * enough the day this app grew keys of its own: a phone holding both watched
 * one of them and said so in a sentence on the accounts screen, which was
 * honest and was still a wallet that could not see half of itself.
 *
 * The tempting fix is to teach `NodeWatcher` to hold arrays. That file carries
 * the Monero scan, the key image book, the spend events and the histories, all
 * keyed to one account, and every one of them would have to grow a dimension.
 * It is also the most heavily tested file in the package, and a rewrite would
 * retire tests that are currently about real behavior.
 *
 * So the account stays the unit a watcher watches, and this holds several. The
 * existing tests keep testing the thing they were written for, and what is new
 * here is only the keeping.
 *
 * ## Balances are not summed, and that is a product decision
 *
 * A vault account and an account on this phone are different wallets with
 * different security properties. Adding their balances into one number would
 * hide the only distinction this product exists to make: one of them can be
 * spent by whoever is holding the phone, and the other cannot be spent without
 * the other device. A single total is what a portfolio app shows, and this is
 * not one.
 *
 * So the app looks at one account at a time, every screen says which, and the
 * accounts list is where the several are seen together. `selected` is the whole
 * of that idea.
 *
 * ## What this costs
 *
 * A refresh asks each account's node separately, so two accounts are two sets
 * of address queries. That is not waste: they are genuinely different addresses
 * and there is no query that answers for both. It does mean the node sees twice
 * as much, which is a privacy fact worth stating rather than hiding, and it is
 * the same fact as running two wallets against one node, because that is what
 * this is.
 */

import {
  EMPTY_VIEW,
  NodeWatcher,
  priceTransportFor,
  type MoneroWatch,
  type RefreshResult,
  type WatcherNodes,
} from './watcher';
import { fetchPrices } from '../net/prices';
import type { Transport } from '../net/http';
import type { ChainSnapshot } from './chain';
import type { ScanState } from './moneroscan';

/**
 * What a screen renders when no account is selected.
 *
 * Stale from birth and empty everywhere, which is the same shape a watcher
 * that has fetched nothing hands back. It exists so a screen never has to
 * branch on `snapshot === null`: `accounts.length === 0` is the question that
 * decides whether there is anything to show, and it is asked once, on Home.
 */
export function emptySnapshot(now: number): ChainSnapshot {
  return {
    assets: { BTC: EMPTY_VIEW('BTC'), XMR: EMPTY_VIEW('XMR') },
    transactions: [],
    centsPerUnit: { BTC: 0, XMR: 0 },
    at: now,
    stale: true,
  };
}

/** What one account needs to be watched: an account key, a Monero account, or
 *  both. Neither means there is nothing to watch and no watcher is made. */
export interface AccountKeys {
  /** Matches `Account.id` from `accounts.ts`, so screens can join the two. */
  id: string;
  zpub: string | null;
  monero: MoneroWatch | null;
}

/**
 * Which account the interface is looking at.
 *
 * A function rather than a stored index, because the stored answer goes stale
 * the moment an account is forgotten and a stale selection is a screen showing
 * a balance for a wallet that no longer exists. The caller passes what it
 * wants and gets back something that is definitely present.
 */
export function selected(ids: readonly string[], wanted: string | null): string | null {
  if (ids.length === 0) return null;
  if (wanted !== null && ids.includes(wanted)) return wanted;
  /* The first, which `accountsFrom` orders vault first. Somebody who forgets
   * the account they were looking at lands on the one with the stronger
   * protection rather than wherever an index happened to point. */
  return ids[0]!;
}

/**
 * Where a rebuilt watcher should start its Monero scan.
 *
 * Its own function because the answer is a security property with three
 * inputs, and it was previously one inline ternary that had it backwards.
 *
 * Two conditions, and both are about the findings rather than the number. A
 * scan position is only half of a scan: the outputs it found live in
 * `NodeWatcher.found`, in memory, because a list of somebody's incoming
 * payments on disk is exactly what the view key was protecting. So a position
 * may only be resumed when the outputs that go with it are still here, which
 * is what `resumable` means and why it is compared by identity: it is the same
 * object the last refresh in this process wrote.
 *
 * The second condition is the one that was inverted. Resuming is only sound
 * when the earlier pass started at or before this account's birth height,
 * because a pass that started *later* never walked `[birth, stored.birth)` and
 * nothing else ever will: the height only moves forward and this wallet has no
 * rescan. The old comparison was `stored.birth >= birth`, which reused a
 * position in exactly the case that skips blocks and discarded it in the case
 * that does not. The equality case, an ordinary rescan of the same account, is
 * why the common path looked fine.
 */
export function resumeFrom(
  birth: number,
  stored: ScanState | undefined,
  resumable: ScanState | undefined,
): ScanState {
  if (resumable && stored && resumable === stored && stored.birth <= birth) return stored;
  return { birth, height: birth };
}

/**
 * What an account's watcher was built for.
 *
 * The watching keys and nothing else: the same account key and the same Monero
 * address mean the same wallet, so the watcher already holding its outputs and
 * its key image book is still the right watcher for it. The scan position is
 * deliberately absent, because a reused watcher keeps its own, which is the
 * whole point of reusing it.
 */
function identityOf(account: AccountKeys): string {
  return `${account.zpub ?? ''}|${account.monero?.account.address ?? ''}`;
}

export class Watchers {
  private readonly byId = new Map<string, NodeWatcher>();
  /** The relay, when there is one, asked once per refresh for the whole set.
   *  Built from the same rule the watchers use, from the same function, so
   *  the two cannot come to disagree about whether the relay is on. */
  private readonly prices: Transport | null;
  /** What each watcher was built for, so a later rebuild can tell whether an
   *  account's keys are still the same ones. */
  private readonly builtFor = new Map<string, string>();

  /**
   * @param carry the previous set, when the same nodes are still configured.
   *
   * Making or forgetting a wallet on this phone used to rebuild every watcher,
   * because the account list is one memo over the whole array. A fresh
   * `NodeWatcher` has an empty `found` map and an empty key image book, both
   * memory-only by design, so adding a hot wallet dropped the *vault*
   * account's spendable Monero to zero and made somebody repeat a physical QR
   * round trip for an action that had nothing to do with that account.
   *
   * Passing the previous set keeps a watcher whose account is unchanged. A
   * changed node still rebuilds everything, and that is correct rather than an
   * oversight: a balance from a different node is not a balance from this one.
   */
  constructor(
    nodes: WatcherNodes,
    accounts: readonly AccountKeys[],
    now: number = Date.now(),
    carry: Watchers | null = null,
    /* Overridable for the same reason `NodeWatcher`'s transports are: the
     * thing under test has to be the real class, driven by a recorded answer.
     * A test that could not count the calls could not tell one price fetch
     * for the set from one per account, which is the whole property. */
    prices: Transport | null = priceTransportFor(nodes),
  ) {
    this.prices = prices;
    for (const account of accounts) {
      if (account.zpub === null && account.monero === null) continue;
      const identity = identityOf(account);
      this.byId.set(
        account.id,
        carry?.builtFrom(account.id, identity) ??
          new NodeWatcher(nodes, account.zpub, undefined, now, account.monero),
      );
      this.builtFor.set(account.id, identity);
    }
  }

  /** The watcher this set holds for `id`, but only if it was built for exactly
   *  these keys. A different wallet under a reused id gets nothing. */
  private builtFrom(id: string, identity: string): NodeWatcher | null {
    if (this.builtFor.get(id) !== identity) return null;
    return this.byId.get(id) ?? null;
  }

  /** The ids that have a watcher, in the order they were given. */
  ids(): string[] {
    return [...this.byId.keys()];
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** The watcher for one account, or null. Named `for` on purpose: a caller
   *  that wants a watcher has to say which account it is asking about. */
  watcherFor(id: string | null): NodeWatcher | null {
    return id === null ? null : this.byId.get(id) ?? null;
  }

  /**
   * One account's view of the chain.
   *
   * Null when there is no watcher for it, which the caller has to handle
   * rather than being handed an empty snapshot that looks like a wallet with
   * no money in it. Those are different states and only one of them is about
   * a balance.
   */
  snapshotFor(id: string | null): ChainSnapshot | null {
    return this.watcherFor(id)?.snapshot() ?? null;
  }

  /**
   * Refresh every account, and report per account.
   *
   * Sequential rather than parallel, deliberately. Two accounts firing their
   * address queries at one node at the same moment is a burst that looks like
   * something worth rate limiting, and the whole refresh strategy in this app
   * is pull rather than poll precisely to keep its footprint at a node small.
   * The wait is a few hundred milliseconds and nobody is watching a spinner
   * race.
   */
  async refreshAll(now: number = Date.now()): Promise<Map<string, RefreshResult>> {
    /*
     * One price for the set, not one per account.
     *
     * The price fetch lived inside `NodeWatcher.refresh`, so a phone watching
     * a vault account and a hot account made two identical `/v1/price` calls
     * to the same relay, from the same address, in the same second, on every
     * refresh. The relay is the one hop in this app that sees a request it
     * could correlate, and the number of calls per refresh is exactly the
     * number of accounts somebody holds. The price itself is one number for
     * the whole app, so there was never a second question being asked.
     *
     * `null` rather than `undefined` when there is no price source, because
     * the two mean different things to a watcher: undefined sends it out to
     * ask for itself, which is what a lone watcher wants and is precisely
     * what must not happen here.
     */
    const priced = this.prices ? await fetchPrices(this.prices) : null;
    const results = new Map<string, RefreshResult>();
    for (const [id, watcher] of this.byId) {
      results.set(id, await watcher.refresh(now, priced));
    }
    return results;
  }
}

/**
 * Every problem from a refresh, tagged with the account it came from.
 *
 * Flattened here rather than in a screen, because "no account key has been
 * paired for Bitcoin" reads as a bug in the app until it says which of two
 * accounts it is about.
 */
export function problemsFrom(
  results: Map<string, RefreshResult>,
  labelFor: (id: string) => string,
): { asset: 'BTC' | 'XMR'; problem: string }[] {
  const out: { asset: 'BTC' | 'XMR'; problem: string }[] = [];
  for (const [id, result] of results) {
    for (const problem of result.problems) {
      out.push({ asset: problem.asset, problem: `${labelFor(id)}: ${problem.problem}` });
    }
  }
  return out;
}
