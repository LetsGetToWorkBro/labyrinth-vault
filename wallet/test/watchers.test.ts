/*
 * One watcher per account.
 *
 * The behavior of a single watcher is `watcher.test.ts` and the several tests
 * around it; none of that changed. What is under test here is the keeping: that
 * every account gets its own, that an account with no keys gets none rather
 * than an empty one, that asking about an account nobody is watching says so
 * rather than handing back a snapshot full of zeroes, and that the selection
 * always resolves to something that exists.
 *
 * The last of those is the one worth having. A stored selection goes stale the
 * moment an account is forgotten, and a stale selection is a screen rendering a
 * balance for a wallet that is gone.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Watchers, emptySnapshot, problemsFrom, selected, type AccountKeys } from '../src/core/watchers';
import { NodeWatcher, type RefreshResult, type WatcherNodes } from '../src/core/watcher';

/* No nodes, so every watcher below builds its transports as null and reaches
 * no network. The keeping is what is under test, not the fetching. */
const NO_NODES: WatcherNodes = { btc: null, xmr: null };

const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

function keys(over: Partial<AccountKeys> = {}): AccountKeys {
  return { id: 'vault', zpub: ZPUB, monero: null, ...over };
}

describe('keeping a watcher for each account', () => {
  it('builds one per account, in the order given', () => {
    const watchers = new Watchers(NO_NODES, [keys(), keys({ id: 'hot' })]);
    expect(watchers.ids()).toEqual(['vault', 'hot']);
    expect(watchers.watcherFor('vault')).toBeInstanceOf(NodeWatcher);
    expect(watchers.watcherFor('hot')).toBeInstanceOf(NodeWatcher);
  });

  it('builds none for an account with no keys at all', () => {
    /* An account row with neither an account key nor a Monero account has
     * nothing to watch. A watcher for it would answer every question with
     * zeroes, which reads as a wallet with no money rather than as a wallet
     * nobody can see. */
    const watchers = new Watchers(NO_NODES, [keys({ id: 'empty', zpub: null, monero: null })]);
    expect(watchers.ids()).toEqual([]);
    expect(watchers.has('empty')).toBe(false);
  });

  it('says null for an account nobody is watching, rather than an empty snapshot', () => {
    const watchers = new Watchers(NO_NODES, [keys()]);
    expect(watchers.snapshotFor('hot')).toBeNull();
    expect(watchers.snapshotFor(null)).toBeNull();
    expect(watchers.watcherFor('nonsense')).toBeNull();
  });

  it('gives each account its own snapshot object, not a shared one', () => {
    /* Two accounts sharing a snapshot would show one account's balance under
     * the other's name, which is the worst possible version of this bug: the
     * number is real, it is just somebody else's. */
    const watchers = new Watchers(NO_NODES, [keys(), keys({ id: 'hot' })]);
    expect(watchers.snapshotFor('vault')).not.toBe(watchers.snapshotFor('hot'));
  });

  it('starts every account stale, because nothing has been fetched', () => {
    /* Same rule a single watcher follows. A fresh-looking snapshot full of
     * zeroes reads as "you have nothing" rather than "nothing has been
     * asked". */
    const watchers = new Watchers(NO_NODES, [keys(), keys({ id: 'hot' })]);
    for (const id of watchers.ids()) expect(watchers.snapshotFor(id)!.stale).toBe(true);
  });

  it('refreshes every account and reports one result each', async () => {
    /* Every account, not only the one on screen. Refreshing what is being
     * looked at makes the other account's balance a thing that only updates
     * when somebody visits it. */
    const watchers = new Watchers(NO_NODES, [keys(), keys({ id: 'hot' })]);
    const results = await watchers.refreshAll(1_760_000_000_000);
    expect([...results.keys()]).toEqual(['vault', 'hot']);
  });
});

describe('the empty snapshot, for a wallet with no accounts', () => {
  it('is empty and stale rather than fresh and zero', () => {
    const snapshot = emptySnapshot(1_760_000_000_000);
    expect(snapshot.stale).toBe(true);
    expect(snapshot.assets.BTC.balance).toBe(0n);
    expect(snapshot.assets.XMR.balance).toBe(0n);
    expect(snapshot.transactions).toEqual([]);
  });

  it('knows no price, so no screen renders a dollar figure over nothing', () => {
    const snapshot = emptySnapshot(0);
    expect(snapshot.centsPerUnit.BTC).toBe(0);
    expect(snapshot.centsPerUnit.XMR).toBe(0);
  });
});

describe('which account is being looked at', () => {
  it('is nothing when there are no accounts', () => {
    expect(selected([], 'vault')).toBeNull();
  });

  it('is the wanted one when it exists', () => {
    expect(selected(['vault', 'hot'], 'hot')).toBe('hot');
  });

  it('falls back to the first when the wanted one is gone', () => {
    expect(selected(['vault', 'hot'], 'missing')).toBe('vault');
    expect(selected(['vault', 'hot'], null)).toBe('vault');
  });

  it('never returns an id that is not in the list', () => {
    /* The property, rather than three examples of it. A selection pointing at
     * an account nobody is watching is a screen with no data and no
     * explanation. */
    const lists = [[], ['vault'], ['hot'], ['vault', 'hot'], ['standin']];
    const wishes = [null, 'vault', 'hot', 'standin', 'missing', ''];
    for (const ids of lists) {
      for (const wanted of wishes) {
        const answer = selected(ids, wanted);
        if (answer === null) expect(ids).toEqual([]);
        else expect(ids).toContain(answer);
      }
    }
  });
});

describe('problems, said with the account they came from', () => {
  it('names the account, because the sentence is ambiguous without it', () => {
    /* "No account key has been paired for Bitcoin" reads as a bug in the app
     * until it says which of two accounts it is about. */
    const results = new Map<string, RefreshResult>();
    results.set('vault', { ok: false, problems: [{ asset: 'BTC', problem: 'No account key.' }], queried: 0 });
    results.set('hot', { ok: false, problems: [{ asset: 'XMR', problem: 'The node did not answer.' }], queried: 0 });
    const labels: Record<string, string> = { vault: 'VAULT · iPhone 11', hot: 'This phone' };
    expect(problemsFrom(results, (id) => labels[id] ?? id)).toEqual([
      { asset: 'BTC', problem: 'VAULT · iPhone 11: No account key.' },
      { asset: 'XMR', problem: 'This phone: The node did not answer.' },
    ]);
  });

  it('says nothing when nothing went wrong', () => {
    const results = new Map<string, RefreshResult>();
    results.set('vault', { ok: true, problems: [], queried: 3 });
    expect(problemsFrom(results, (id) => id)).toEqual([]);
  });
});

describe('the store keeps them, rather than keeping one', () => {
  const store = readFileSync('src/state/store.tsx', 'utf8');

  it('refreshes all accounts, not the selected one', () => {
    expect(store).toMatch(/watchers\.refreshAll\(/);
    expect(store, 'only the account on screen is being refreshed').not.toMatch(
      /watcher\.refresh\(Date\.now\(\)\)/,
    );
  });

  it('keeps a scan position per account', () => {
    /* Two accounts scan two different sets of blocks for two different view
     * keys. One shared position hands one account's progress to the other,
     * which is a scan that starts too late and a balance that is short. */
    expect(store).toMatch(/scanStarts = useRef<Record<string, ScanState>>/);
    expect(store, 'a single shared scan position is back').not.toMatch(/scanStart\.current = /);
  });

  it('resolves the selection rather than trusting stored state', () => {
    expect(store).toMatch(/selected\(accounts\.map\(\(account\) => account\.id\), wantedAccount\)/);
  });
});
