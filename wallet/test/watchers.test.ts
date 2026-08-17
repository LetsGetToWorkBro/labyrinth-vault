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
import {
  Watchers,
  emptySnapshot,
  problemsFrom,
  resumeFrom,
  selected,
  type AccountKeys,
} from '../src/core/watchers';
import { NodeWatcher, type RefreshResult, type WatcherNodes } from '../src/core/watcher';
import type { Transport } from '../src/net/http';

/* No nodes, so every watcher below builds its transports as null and reaches
 * no network. The keeping is what is under test, not the fetching. */
const NO_NODES: WatcherNodes = { btc: null, xmr: null };

const NOW = 1_760_000_000_000;

const ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

/* A second real account key, from BIP39's "legal winner thank year wave
 * sausage worth useful legal winner thank yellow". Real rather than a mangled
 * copy of the one above, because a zpub that fails to open produces a watcher
 * with no Bitcoin wallet in it, and a test comparing two of those would be
 * comparing two empty things. */
const OTHER_ZPUB =
  'zpub6s3Buz3fYNRSZk9BFYo9RCMkAvSiknUtRVjuYYCZmDJPrxTwYEW6fBXzYwMdT3DaKaE7TxN1QQwU2tjpNzAYS3S9G2xGEPQcMsrgxQNwh47';

/** Comments removed, so a guard never fires on its own documentation. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function keys(over: Partial<AccountKeys> = {}): AccountKeys {
  return { id: 'vault', zpub: ZPUB, monero: null, ...over };
}

/**
 * A price relay that counts, and answers the way the real one does.
 *
 * `fetchPrices` believes a positive integer number of cents under a hundred
 * million dollars, so these are real figures rather than ones the parser
 * would reject: a transport whose answer is thrown away could not tell a
 * fetch that happened from one that did not.
 */
function countingPrices(): { transport: Transport; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    transport: {
      base: 'https://relay.example',
      async send(request) {
        calls += 1;
        expect(request.path).toBe('/v1/price');
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ ok: true, prices: { BTC: 6_000_000, XMR: 15_000 } }),
        };
      },
    },
  };
}

describe('the price is one number for the app, so it is asked for once', () => {
  /* W-L3. The fetch lived inside `NodeWatcher.refresh`, so a phone watching a
   * vault account and a hot account made two identical `/v1/price` calls to
   * the same relay, from the same address, in the same second, every refresh.
   * The relay is the one hop that sees a request it could correlate, and the
   * call count per refresh is the number of accounts somebody holds. */

  it('asks once for a set of two accounts, and gives both the answer', async () => {
    const relay = countingPrices();
    const watchers = new Watchers(NO_NODES, [keys(), keys({ id: 'hot' })], NOW, null, relay.transport);
    await watchers.refreshAll(NOW);

    expect(relay.calls(), 'one call per account, which is the account count leaking').toBe(1);
    for (const id of ['vault', 'hot']) {
      expect(watchers.watcherFor(id)!.snapshot().centsPerUnit, `${id} did not get the price`).toEqual({
        BTC: 6_000_000,
        XMR: 15_000,
      });
    }
  });

  it('asks once whatever the account count is', async () => {
    /* Three rather than two, because "once" and "once per account" agree at
     * one and a two-account check cannot tell a fixed two from a per-account
     * two. */
    const relay = countingPrices();
    const watchers = new Watchers(
      NO_NODES,
      [keys(), keys({ id: 'hot' }), keys({ id: 'third', zpub: OTHER_ZPUB })],
      NOW,
      null,
      relay.transport,
    );
    await watchers.refreshAll(NOW);
    expect(relay.calls()).toBe(1);
  });

  it('does not go out at all when there is no relay', async () => {
    /* Null is not undefined. A watcher told "nobody fetched one" asks for
     * itself, which is right for a lone watcher and is exactly what must not
     * happen behind a set that has already looked and found no price source. */
    const watchers = new Watchers(NO_NODES, [keys(), keys({ id: 'hot' })], NOW, null, null);
    const results = await watchers.refreshAll(NOW);
    expect([...results.keys()]).toEqual(['vault', 'hot']);
    for (const id of ['vault', 'hot']) {
      expect(watchers.watcherFor(id)!.snapshot().centsPerUnit).toEqual({ BTC: 0, XMR: 0 });
    }
  });
});

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

describe('a resumed scan must carry its findings, or it reports zero', () => {
  /* The defect: `NodeWatcher.found` is in memory by design, because a list of
   * somebody's incoming payments on disk is what the view key was protecting.
   * The scan height was persisted anyway, so a relaunch resumed past every
   * funded block with an empty output set and reported a balance of zero,
   * under a caveat reading "this total is what arrived". Rescanning could not
   * recover it either: the key image request is built from the outputs the
   * scan found, so an empty set makes the vault round trip return nothing. */

  const store = readFileSync('src/state/store.tsx', 'utf8');

  it('only resumes from a position this process produced', () => {
    expect(store).toMatch(/sessionScans = useRef<Record<string, ScanState>>/);
    expect(store).toMatch(/const resumable = sessionScans\.current\[opened\.account\.address\]/);
  });

  it('asks the one resolver rather than deciding inline', () => {
    /* Inline, this was a ternary with the comparison backwards, and no test
     * could reach it without a React tree. */
    expect(store).toMatch(/resumeFrom\(birth, stored, resumable\)/);
    expect(store, 'the disk position is being trusted on its own again').not.toMatch(
      /const scan = stored && stored\.birth >= birth \? stored :/,
    );
  });

  it('records a position as resumable only after a real refresh', () => {
    /* Written where the outputs that go with it are still in memory, and
     * nowhere else. */
    expect(store).toMatch(/sessionScans\.current = \{ \.\.\.sessionScans\.current, \.\.\.byAddress \}/);
    const loadAt = store.indexOf('scanStarts.current = stored.moneroScans');
    const sessionAt = store.indexOf('sessionScans.current = {');
    expect(loadAt).toBeGreaterThan(0);
    expect(sessionAt).toBeGreaterThan(loadAt);
  });

  it('drops an account\'s scan when the account is forgotten', () => {
    /* The ids are role names. Forgetting the hot keys and restoring a
     * different wallet, or unpairing and pairing a different vault, put a
     * second wallet under an id that already had a position against it. */
    const code = codeOnly(store);
    expect(code).toMatch(/forgetScanFor\('hot', hotWatch\?\.xmr\?\.address \?\? null\)/);
    expect(code).toMatch(/forgetScanFor\('vault', pairing\?\.xmr\?\.address \?\? null\)/);
  });
});

describe('where a rebuilt watcher starts its scan', () => {
  /* `resumeFrom` is the whole of the rule, and both halves of it have been
   * wrong in shipped code: the findings half reported a balance of zero after
   * every relaunch, and the comparison half was inverted, so it reused a
   * position exactly when doing so skips blocks. */

  const at = (birth: number, height: number) => ({ birth, height });

  it('resumes a position this process produced over blocks it really walked', () => {
    const position = at(100, 900);
    expect(resumeFrom(100, position, position)).toBe(position);
    /* And from a pass that started earlier than this account needs, which has
     * covered everything from the birth height onward. */
    const earlier = at(50, 900);
    expect(resumeFrom(100, earlier, earlier)).toBe(earlier);
  });

  it('starts at birth when the earlier pass began after it', () => {
    /* `[birth, stored.birth)` was never walked and nothing will walk it: the
     * height only moves forward and this wallet has no rescan. The old
     * comparison kept exactly this case. */
    const later = at(500, 900);
    expect(resumeFrom(100, later, later)).toEqual(at(100, 100));
  });

  it('starts at birth when the findings did not survive', () => {
    /* A position read off disk with no live pass behind it. The outputs are in
     * memory by design, so the height alone resumes past every funded block
     * and reports zero under a caveat saying "this total is what arrived". */
    expect(resumeFrom(100, at(100, 900), undefined)).toEqual(at(100, 100));
  });

  it('starts at birth when the live position is for a different wallet', () => {
    /* Two positions with the same numbers are still two positions. The
     * identity comparison is what ties a height to the outputs found with it,
     * so an equal-looking value from somewhere else must not be enough. */
    expect(resumeFrom(100, at(100, 900), at(100, 900))).toEqual(at(100, 100));
  });

  it('starts at birth when nothing is stored at all', () => {
    expect(resumeFrom(2_800_000, undefined, undefined)).toEqual(at(2_800_000, 2_800_000));
  });
});

describe('rebuilding the list keeps the watchers whose accounts did not change', () => {
  /* The defect: `accountKeys` is one memo over the whole array, so making a
   * wallet on this phone built a fresh `NodeWatcher` for the *vault* account
   * too. Its found outputs and its key image book are memory-only by design,
   * so both went, and a vault account's spendable Monero dropped to zero for
   * an action about a different account. */

  it('carries an unchanged account across a rebuild', () => {
    const first = new Watchers(NO_NODES, [keys()]);
    const kept = first.watcherFor('vault');
    const second = new Watchers(NO_NODES, [keys(), keys({ id: 'hot' })], Date.now(), first);
    expect(second.watcherFor('vault')).toBe(kept);
    expect(second.watcherFor('hot')).not.toBe(kept);
  });

  it('builds a new one when the account key under an id changes', () => {
    /* The ids are role names, so a different wallet can arrive under one. A
     * watcher carrying the previous wallet's outputs would report the wrong
     * account's balance under the right account's name. */
    const first = new Watchers(NO_NODES, [keys()]);
    const second = new Watchers(NO_NODES, [keys({ zpub: OTHER_ZPUB })], Date.now(), first);
    expect(second.watcherFor('vault')).not.toBe(first.watcherFor('vault'));
  });

  it('builds new ones when the nodes change, which is not the same question', () => {
    /* A balance from a different node is not a balance from this one. The
     * store decides this by not passing the previous set at all. */
    const first = new Watchers(NO_NODES, [keys()]);
    const second = new Watchers(NO_NODES, [keys()], Date.now(), null);
    expect(second.watcherFor('vault')).not.toBe(first.watcherFor('vault'));
  });
});
