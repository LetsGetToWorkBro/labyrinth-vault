/*
 * Writing the keys down.
 *
 * Two different things under test. The words themselves have one failure worth
 * fearing: a backup screen that prints a phrase restoring to a different
 * wallet than the one holding the money. That is silent, it is discovered
 * years later by somebody who needs it, and there is no recovering from it.
 *
 * The other is an ordering, which is the kind of rule a refactor flattens
 * because it looks like a UI convention: a record is not stored until its
 * words have been on screen. Written as a disabled button that would be a fact
 * about a screen. Written as a transition table it is a fact about the
 * application, and this file walks every event against every step to hold it.
 *
 * The upstream question this file does *not* answer: whether our twenty-five
 * words are Monero's twenty-five words. That is settled in the vault's own
 * suite against Monero's code, which is where it belongs. What is settled here
 * is that the words shown and the seed stored are the same wallet.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  beginCreation,
  creationHint,
  creationReduce,
  isKept,
  mayKeep,
  phrasesFor,
  restoreEffect,
  wordCount,
  type Creation,
  type CreationEvent,
} from '../src/core/backup';
import { makeHotRecord, openMonero, readPhrase, watchOnlyFrom, type HotRecord } from '../src/core/keyvault';
import { revealSecretHex, wipeWallet } from '@vault/keys/monero';
import { addressAt, openWatch } from '@vault/keys/bitcoin';
import { openBitcoin, closeBitcoin } from '../src/core/keyvault';

/* Varied rather than a repeated byte, for the reason `keyvault.test.ts`
 * carries at length: 32 bytes of one value reduce to a seed with no letters in
 * it, and a test whose input cannot exercise the branch it asserts on is a
 * test reporting on itself. Different constants from that file's, so a change
 * that happens to suit one fixture does not quietly suit both. */
const XMR_ENTROPY = Uint8Array.from({ length: 32 }, (_, i) => (i * 61 + 5) & 0xff);
const BTC_ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => (i * 47 + 13) & 0xff);
const WHEN = 1_700_000_000_000;

function fresh(): HotRecord {
  const made = makeHotRecord(XMR_ENTROPY, BTC_ENTROPY, 'mainnet', WHEN);
  if (!made.ok) throw new Error(made.problem);
  return made.record;
}

describe('the words a backup screen shows', () => {
  it('gives twenty-five for Monero and twelve for Bitcoin', () => {
    const phrases = phrasesFor(fresh());
    expect(phrases.monero).toHaveLength(25);
    expect(phrases.bitcoin).toHaveLength(12);
    expect(wordCount(phrases)).toBe(37);
  });

  it('restores to the same Monero wallet it was printed from', () => {
    /* The failure this exists for: a phrase on paper that opens a different
     * wallet than the address it was written beside. Nobody finds out until
     * the day they need it. */
    const record = fresh();
    const phrases = phrasesFor(record);
    const back = readPhrase(phrases.monero!.join(' '));
    expect(back.ok).toBe(true);
    if (!back.ok || back.chain !== 'xmr') throw new Error('expected a Monero phrase');
    expect(back.xmrSeed).toBe(record.xmrSeed);

    /* And the address, which is the thing a person actually compares. A seed
     * matching is the mechanism; an address matching is the claim. */
    const from = openMonero(record)!;
    const restored = openMonero({ ...record, xmrSeed: back.xmrSeed })!;
    expect(restored.address).toBe(from.address);
    wipeWallet(from);
    wipeWallet(restored);
  });

  it('restores to the same Bitcoin account it was printed from', () => {
    const record = fresh();
    const phrases = phrasesFor(record);
    const back = readPhrase(phrases.bitcoin!.join(' '));
    expect(back.ok).toBe(true);
    if (!back.ok || back.chain !== 'btc') throw new Error('expected a Bitcoin phrase');
    expect(back.btcMnemonic).toBe(record.btcMnemonic);

    const from = openBitcoin(record)!;
    const restored = openBitcoin({ ...record, btcMnemonic: back.btcMnemonic })!;
    expect(addressAt(restored, 0, 0).address).toBe(addressAt(from, 0, 0).address);
    closeBitcoin(from);
    closeBitcoin(restored);
  });

  it('says null for a chain the record does not hold, rather than an empty list', () => {
    /* A heading over an empty array reads as a backup that went missing. A
     * person restoring twenty-five words out of Feather has no Bitcoin half
     * and the screen has to be able to say that rather than show a gap. */
    const record = fresh();
    const moneroOnly = phrasesFor({ ...record, btcMnemonic: null });
    expect(moneroOnly.bitcoin).toBeNull();
    expect(moneroOnly.monero).toHaveLength(25);
    expect(wordCount(moneroOnly)).toBe(25);

    const bitcoinOnly = phrasesFor({ ...record, xmrSeed: null });
    expect(bitcoinOnly.monero).toBeNull();
    expect(bitcoinOnly.bitcoin).toHaveLength(12);
    expect(wordCount(bitcoinOnly)).toBe(12);
  });

  it('is reproducible, so the same record always prints the same paper', () => {
    expect(phrasesFor(fresh())).toEqual(phrasesFor(fresh()));
  });

  it('hands back words rather than a wallet, so nothing holds a spend secret', () => {
    /* `phrasesFor` opens a Monero wallet to read its words and wipes it before
     * returning. The shape of the return value is what enforces that: a caller
     * given only strings has nothing to keep by accident. */
    const phrases = phrasesFor(fresh());
    expect(Object.keys(phrases).sort()).toEqual(['bitcoin', 'monero']);
    expect(phrases.monero!.every((word) => typeof word === 'string')).toBe(true);
  });
});

describe('a new wallet is not stored until its words have been shown', () => {
  const EVENTS: CreationEvent[] = [{ type: 'revealed' }, { type: 'keep' }];

  it('starts unsaved and unshown', () => {
    const state = beginCreation(fresh());
    expect(state.step).toBe('drawn');
    expect(mayKeep(state)).toBe(false);
    expect(isKept(state)).toBe(false);
  });

  it('refuses to keep a record whose words nobody has seen', () => {
    const state = beginCreation(fresh());
    const after = creationReduce(state, { type: 'keep' });
    expect(after.step).toBe('drawn');
    expect(isKept(after)).toBe(false);
  });

  it('reaches kept only through shown, whatever order the events arrive in', () => {
    /* The property, stated as a search rather than as one happy path. Every
     * reachable state is walked and any route to `kept` that never passed
     * through `shown` fails this. */
    const start = beginCreation(fresh());
    const seen = new Map<string, string[]>([['drawn', []]]);
    const queue: Creation[] = [start];

    while (queue.length > 0) {
      const state = queue.shift()!;
      const history = seen.get(state.step)!;
      for (const event of EVENTS) {
        const next = creationReduce(state, event);
        if (seen.has(next.step)) continue;
        const path = [...history, event.type];
        seen.set(next.step, path);
        queue.push(next);
      }
    }

    expect(seen.has('kept')).toBe(true);
    expect(seen.get('kept')).toContain('revealed');
    /* And the stronger statement: the only path found to `kept` reveals first. */
    expect(seen.get('kept')).toEqual(['revealed', 'keep']);
  });

  it('lets the words be revealed more than once, because a person reads them twice', () => {
    /* Hold-to-reveal fires on every press. A transition that only tolerated
     * one would put the flow in a state a second glance could not leave. */
    let state = beginCreation(fresh());
    state = creationReduce(state, { type: 'revealed' });
    state = creationReduce(state, { type: 'revealed' });
    state = creationReduce(state, { type: 'revealed' });
    expect(state.step).toBe('shown');
    expect(mayKeep(state)).toBe(true);
  });

  it('is finished once, so a second keep changes nothing', () => {
    let state = beginCreation(fresh());
    state = creationReduce(state, { type: 'revealed' });
    state = creationReduce(state, { type: 'keep' });
    expect(isKept(state)).toBe(true);
    const again = creationReduce(state, { type: 'keep' });
    expect(again).toEqual(state);
  });

  it('cannot be walked backwards out of kept by revealing again', () => {
    let state = beginCreation(fresh());
    state = creationReduce(state, { type: 'revealed' });
    state = creationReduce(state, { type: 'keep' });
    expect(creationReduce(state, { type: 'revealed' }).step).toBe('kept');
  });

  it('carries the same record from end to end, so what is shown is what is saved', () => {
    /* The words on the paper and the seed in the keychain have to be one
     * wallet. Swapping the record mid-flow would produce a backup for a wallet
     * that never held anything. */
    const record = fresh();
    let state = beginCreation(record);
    state = creationReduce(state, { type: 'revealed' });
    state = creationReduce(state, { type: 'keep' });
    expect(state.record).toEqual(record);
  });

  it('explains itself in a sentence at every step', () => {
    /* The house rule about refusals. A disabled control with no sentence
     * teaches somebody the app is broken. */
    let state = beginCreation(fresh());
    for (const step of ['drawn', 'shown', 'kept'] as const) {
      expect(state.step).toBe(step);
      const hint = creationHint(state);
      expect(hint.length).toBeGreaterThan(20);
      expect(hint).toMatch(/[.]$/);
      state = creationReduce(state, step === 'drawn' ? { type: 'revealed' } : { type: 'keep' });
    }
  });
});

describe('what a restore is about to do', () => {
  const record = fresh();

  it('says a phone with nothing on it is getting its first wallet', () => {
    expect(restoreEffect(null, 'xmr')).toMatch(/holds no spending keys/);
    expect(restoreEffect(null, 'btc')).toMatch(/holds no spending keys/);
  });

  it('promises the other chain is left alone, which is what withRestored does', () => {
    /* The sentence has to be true, and the thing that makes it true is
     * `withRestored`. This is the copy half; `keyvault.test.ts` holds the
     * behavior half. */
    const bitcoinOnly: HotRecord = { ...record, xmrSeed: null };
    const note = restoreEffect(bitcoinOnly, 'xmr');
    expect(note).toMatch(/adds a Monero wallet/);
    expect(note).toMatch(/Bitcoin wallet already on this phone is left alone/);
  });

  it('warns plainly when a restore replaces a wallet that is already there', () => {
    /* The only place this app overwrites key material, so it is the only place
     * that gets a sentence about words being gone. */
    const note = restoreEffect(record, 'xmr');
    expect(note).toMatch(/replaces the Monero wallet/);
    expect(note).toMatch(/leaves the Bitcoin one alone/);
    expect(note).toMatch(/they are gone/);
  });

  it('does not promise to spare a chain that is not there', () => {
    const moneroOnly: HotRecord = { ...record, btcMnemonic: null };
    const note = restoreEffect(moneroOnly, 'xmr');
    expect(note).toMatch(/replaces the Monero wallet/);
    expect(note).not.toMatch(/Bitcoin/);
  });

  it('names the chain being restored in every sentence it produces', () => {
    /* A person who pasted the wrong phrase needs the sentence to disagree with
     * what they expected, and a sentence that says "a wallet" agrees with
     * everything. */
    const shapes: (HotRecord | null)[] = [
      null,
      record,
      { ...record, xmrSeed: null },
      { ...record, btcMnemonic: null },
    ];
    for (const existing of shapes) {
      expect(restoreEffect(existing, 'xmr')).toMatch(/Monero/);
      expect(restoreEffect(existing, 'btc')).toMatch(/Bitcoin/);
    }
  });
});

/*
 * The screens.
 *
 * Everything above is the module. What follows holds the two screens to the
 * rules that do not survive as comments, and all of it strips comments before
 * looking, because this repository has now had five guards fire on the prose
 * explaining the rule they enforce.
 */

/** Comments removed, so a guard never fires on its own documentation. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the screens that show and take a phrase', () => {
  const backup = readFileSync('src/screens/Backup.tsx', 'utf8');
  const restore = readFileSync('src/screens/Restore.tsx', 'utf8');
  const security = readFileSync('src/screens/Vault.tsx', 'utf8');
  const app = readFileSync('App.tsx', 'utf8');

  it('found the screens, so a pass means something', () => {
    expect(backup).toMatch(/CreateWalletScreen/);
    expect(restore).toMatch(/RestoreScreen/);
  });

  it('never puts the words on the pasteboard', () => {
    /* The omission somebody will try to fix, and the reason it is an omission:
     * the general pasteboard on iOS is readable by every app that comes to the
     * foreground and is offered to a person's other devices over Handoff. A
     * copy button here is a seed phrase in an unknown number of places. */
    const code = codeOnly(backup);
    for (const forbidden of ['Clipboard', 'setStringAsync', 'setString']) {
      expect(code, `Backup.tsx reaches for ${forbidden}`).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  it('does not let a word be selected, because selection offers Copy', () => {
    /* Every other `Mono` in the app is selectable on purpose: an address a
     * person cannot select is one they retype by hand. The words are the one
     * exception, and it has to be explicit at every call site in the grid. */
    const grid = /function WordGrid[\s\S]*?\n}/.exec(backup)?.[0] ?? '';
    expect(grid, 'WordGrid not found').toBeTruthy();
    const monos = grid.match(/<Mono\b[^>]*/g) ?? [];
    expect(monos.length).toBeGreaterThan(0);
    for (const mono of monos) {
      expect(mono, `a Mono in the grid is selectable: ${mono}`).toMatch(/selectable=\{false\}/);
    }
  });

  it('does not draw a concealed word at all', () => {
    /* The divergence from the vault, which blurs. A blur is a view treatment
     * over a string that is still in the view tree, still in a screenshot, and
     * still in whatever the system captures when the app is backgrounded. The
     * grid has to choose the word on `shown` rather than style it. */
    const grid = codeOnly(/function WordGrid[\s\S]*?\n}/.exec(backup)?.[0] ?? '');
    expect(grid).toMatch(/shown \? word :/);
    expect(grid, 'a blur would leave the word in the tree').not.toMatch(/\bblur\b/i);
  });

  it('reaches the keychain only through the gate that requires the words to have been shown', () => {
    /* The ordering, checked at the one place it could be bypassed. The screen
     * may call `keepHot` exactly once, and `mayKeep` has to stand in front of
     * it. A second unguarded call is how this rule dies. */
    const code = codeOnly(backup);
    expect(code).toMatch(/mayKeep\(creation\)/);
    expect((code.match(/keepHot\(/g) ?? []).length, 'more than one path to the keychain').toBe(1);
    expect(code).toMatch(/if \(!mayKeep\(creation\)\) return;/);
  });

  it('draws its entropy from the platform rather than from Math.random', () => {
    const code = codeOnly(backup);
    expect(code).toMatch(/crypto\.getRandomValues/);
    expect(code, 'Math.random is not a source of key material').not.toMatch(/Math\.random/);
  });

  it('generates nothing on a phone that already holds a wallet', () => {
    /* `saveHot` keeps exactly one record and overwriting is what it does, so
     * the refusal is the screen's job. The check has to come before the draw:
     * a version that generates first and refuses second is one edit away from
     * saving what it generated. */
    const guard = codeOnly(/export function CreateWalletScreen[\s\S]*?\n}/.exec(backup)?.[0] ?? '');
    expect(guard, 'CreateWalletScreen not found').toBeTruthy();
    expect(guard).toMatch(/hot !== null/);
    expect(guard, 'the guard screen must not draw entropy').not.toMatch(/drawEntropy/);
  });

  it('folds a restored phrase through withRestored rather than building a record', () => {
    /* The rule that a restore never discards the other chain lives in
     * `withRestored`. A screen that assembled a record itself would be a
     * second place for it to be got wrong, and the wrong version is a wipe
     * wearing the word restore. */
    const code = codeOnly(restore);
    expect(code).toMatch(/withRestored\(hot, reading/);
    expect(code, 'the screen must not assemble a record itself').not.toMatch(/xmrSeed:/);
    expect(code, 'the screen must not assemble a record itself').not.toMatch(/btcMnemonic:/);
  });

  it('never corrects a word on its way in', () => {
    /* A phrase with a typo has to fail loudly. Nudging a word to the nearest
     * one in the list is how somebody restores an empty wallet and is told it
     * worked. The field turns off every system feature that would do it. */
    const code = codeOnly(restore);
    expect(code).toMatch(/autoCorrect=\{false\}/);
    expect(code).toMatch(/spellCheck=\{false\}/);
    expect(code).toMatch(/autoCapitalize="none"/);
    expect(code).toMatch(/autoComplete="off"/);
  });

  it('says what a restore will do before it does it', () => {
    expect(codeOnly(restore)).toMatch(/restoreEffect\(hot, reading\.chain\)/);
  });

  it('stops claiming no key has ever been generated on this phone', () => {
    /* This screen's strongest sentence was true until there was a key store,
     * and a security screen that keeps printing a claim the app has outgrown
     * is the worst copy in the product. It is conditional on what is actually
     * stored now. */
    const code = codeOnly(security);
    expect(code, 'the unconditional claim is back').not.toMatch(/never been generated/);
    expect(code).toMatch(/hot === null \?/);
    expect(code).toMatch(/SOME ON THIS PHONE/);
  });

  it('still promises a vault account is watch-only, with a seed in the keychain', () => {
    /* The one sentence that must survive the whole feature. `canSignHere` is
     * what makes it true; this is the screen saying so in the presence of a
     * hot seed, which is exactly when somebody would doubt it. */
    expect(codeOnly(security)).toMatch(/WATCH-ONLY, ALWAYS/);
  });

  it('is reachable, so none of the above is a screen nobody can open', () => {
    for (const route of ['CreateWallet', 'Backup', 'Restore']) {
      expect(codeOnly(app), `${route} is not in the navigator`).toMatch(
        new RegExp(`name="${route}"`),
      );
      expect(codeOnly(security), `nothing navigates to ${route}`).toMatch(
        new RegExp(`navigate\\('${route}'\\)`),
      );
    }
  });
});

describe('the watch-only half a hot record can produce', () => {
  /* A wallet that can sign but has no addresses is not a wallet. Until
   * `watchOnlyFrom` existed, a record made by these screens was listed, backed
   * up, restorable and signable, and never watched.
   *
   * The property that matters is that the watching keys watch the *same*
   * wallet the words restore. Watch keys for a different account would show a
   * balance that is not yours and a receiving address that sends money
   * somewhere you cannot spend from. */

  it('derives an account key for the same Bitcoin wallet the words open', () => {
    const record = fresh();
    const watch = watchOnlyFrom(record);
    expect(watch.zpub).toMatch(/^zpub/);

    const watched = openWatch(watch.zpub!);
    expect(watched.ok).toBe(true);
    const signing = openBitcoin(record)!;
    /* Two independent routes to the same first address: one from the seed, one
     * from the account key derived off it. */
    expect(addressAt(watched.wallet!, 0, 0).address).toBe(addressAt(signing, 0, 0).address);
    closeBitcoin(signing);
  });

  it('derives an address and view key for the same Monero wallet', () => {
    const record = fresh();
    const watch = watchOnlyFrom(record);
    expect(watch.xmr).not.toBeNull();

    const signing = openMonero(record)!;
    expect(watch.xmr!.address).toBe(signing.address);
    expect(watch.xmr!.view).toBe(revealSecretHex(signing.viewSecret));
    wipeWallet(signing);
  });

  it('gives back a view key, which cannot spend, and never a spend key', () => {
    /* The whole point of the shape. What comes out is exactly what a vault
     * exports across the airgap, so deriving it here widens nothing. */
    const record = fresh();
    const watch = watchOnlyFrom(record);
    const signing = openMonero(record)!;
    expect(watch.xmr!.view).not.toBe(revealSecretHex(signing.spendSecret));
    wipeWallet(signing);
    expect(JSON.stringify(watch)).not.toContain(record.xmrSeed!);
  });

  it('says null for a chain the record does not hold', () => {
    const record = fresh();
    expect(watchOnlyFrom({ ...record, btcMnemonic: null }).zpub).toBeNull();
    expect(watchOnlyFrom({ ...record, xmrSeed: null }).xmr).toBeNull();
  });

  it('is what the store actually watches through, in the same precedence', () => {
    /* The guard against the screen and the app disagreeing. `watchedSources`
     * tells the accounts screen which account each chain is read through, and
     * it is only true if `store.tsx` resolves its keys the same way. If one
     * side changes, the screen starts describing a wallet the app is not
     * running, and an unwatched balance goes back to being silently absent. */
    const store = readFileSync('src/state/store.tsx', 'utf8');
    expect(store).toMatch(/watchOnlyFrom\(hot\)/);
    expect(store).toMatch(/pairing\?\.btc\?\.zpub \?\? hotWatch\?\.zpub/);
    expect(store).toMatch(/pairing\?\.xmr[\s\S]{0,120}hotWatch\?\.xmr/);
  });
});
