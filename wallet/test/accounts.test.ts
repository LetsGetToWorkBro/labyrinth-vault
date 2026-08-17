/*
 * The accounts list.
 *
 * Small module, and the tests are mostly about one property: a vault account
 * stays unsignable here even on a phone that is simultaneously holding a seed
 * for a different wallet. That is the case the whole file exists to make
 * expressible, and it is the case that did not exist before, because until
 * there were two sources there was nothing to confuse.
 *
 * The rest holds the empty state honest. It used to be a fixture behind a
 * warning chip, which is the finding this replaces, and the way that comes
 * back is somebody deciding an empty list looks unfinished.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { NOTHING_WATCHED, accountsFrom, anySignsHere, signingNote, watchingNothing } from '../src/core/accounts';
import { selected } from '../src/core/watchers';
import { makeHotRecord, type HotRecord } from '../src/core/keyvault';
import type { Pairing } from '../src/core/pairing';

const XMR_ENTROPY = Uint8Array.from({ length: 32 }, (_, i) => (i * 29 + 17) & 0xff);
const BTC_ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => (i * 41 + 23) & 0xff);

function hot(): HotRecord {
  const made = makeHotRecord(XMR_ENTROPY, BTC_ENTROPY, 'mainnet', 1_700_000_000_000);
  if (!made.ok) throw new Error(made.problem);
  return made.record;
}

/* Shaped like a real pairing rather than reaching for `acceptAccount`, which
 * would need a payload. The fields these tests read are the ones the list
 * reads, and `pairing.test.ts` is where the acceptance is proved. */
function paired(over: Partial<Pairing> = {}): Pairing {
  return {
    btc: { zpub: 'zpub-stand-in', first: 'bc1q-stand-in' },
    xmr: { address: '4-stand-in', view: 'ff'.repeat(32), birth: 3_100_000 },
    label: 'VAULT · iPhone 11',
    pairedAt: 1_699_000_000_000,
    ...over,
  };
}

describe('what the wallet is watching', () => {
  it('is empty when nothing has been paired and nothing has been made', () => {
    const accounts = accountsFrom(null, null);
    expect(accounts).toEqual([]);
    expect(watchingNothing(accounts)).toBe(true);
    expect(anySignsHere(accounts)).toBe(false);
  });

  it('has a sentence for the empty case that names both ways out', () => {
    /* The finding this module replaces: an empty wallet used to show a
     * stranger's balance behind a chip reading DEMO DATA. An empty state that
     * only says "nothing here" is the other failure, so the sentence has to
     * carry both routes. */
    expect(NOTHING_WATCHED).toMatch(/No accounts yet/);
    expect(NOTHING_WATCHED).toMatch(/vault/i);
    expect(NOTHING_WATCHED).toMatch(/this phone/i);
  });

  it('makes one row from a pairing, not one per chain', () => {
    /* Two rows for one vault would tell somebody who paired once that they had
     * done it twice, and would put two FORGET controls on screen for one
     * device. */
    const accounts = accountsFrom(paired(), null);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.chains).toEqual(['BTC', 'XMR']);
    expect(accounts[0]!.label).toBe('VAULT · iPhone 11');
  });

  it('names only the chains a pairing actually carries', () => {
    const btcOnly = accountsFrom(paired({ xmr: null }), null);
    expect(btcOnly[0]!.chains).toEqual(['BTC']);
    const xmrOnly = accountsFrom(paired({ btc: null }), null);
    expect(xmrOnly[0]!.chains).toEqual(['XMR']);
  });

  it('drops a pairing that carries no chain rather than showing an empty row', () => {
    /* Cannot arrive from `acceptAccount`, can arrive from a keychain record
     * written by an older build, which is untrusted input in the same way a
     * scan is. */
    expect(accountsFrom(paired({ btc: null, xmr: null }), null)).toEqual([]);
  });

  it('names only the chains a hot record actually holds', () => {
    /* Somebody who restored twenty-five words out of Feather has a Monero
     * wallet and no Bitcoin one, and the row has to say so rather than offer a
     * chain that is not there. */
    const record = hot();
    expect(accountsFrom(null, { ...record, btcMnemonic: null })[0]!.chains).toEqual(['XMR']);
    expect(accountsFrom(null, { ...record, xmrSeed: null })[0]!.chains).toEqual(['BTC']);
    expect(accountsFrom(null, record)[0]!.chains).toEqual(['BTC', 'XMR']);
  });
});

describe('a vault account is watch-only here even beside a hot one', () => {
  it('holds both at once, as two rows with two sources', () => {
    const accounts = accountsFrom(paired(), hot());
    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.source)).toEqual(['vault', 'hot']);
  });

  it('refuses to let a seed on this phone make the vault account signable', () => {
    /* The property this module exists for. A phone holding a seed for one
     * wallet must not treat that as permission to sign for an account that is
     * watched from a vault: they are unrelated wallets, and a signature
     * against the vault's account produced here would be a signature against
     * an account somebody believes is offline. */
    const accounts = accountsFrom(paired(), hot());
    const vault = accounts.find((a) => a.source === 'vault')!;
    const phone = accounts.find((a) => a.source === 'hot')!;
    expect(vault.signsHere).toBe(false);
    expect(phone.signsHere).toBe(true);
    expect(anySignsHere(accounts)).toBe(true);
  });

  it('reads signability from canSignHere rather than from its own opinion', () => {
    /* If the airgap rule ever changes, it changes in one place and this list
     * follows. A row computing its own answer is a second implementation of
     * the one rule the product rests on. */
    const source = readFileSync('src/core/accounts.ts', 'utf8');
    expect(source).toMatch(/signsHere: canSignHere\('vault'\)/);
    expect(source).toMatch(/signsHere: canSignHere\('hot'\)/);
    expect(source, 'a literal here would be a second implementation').not.toMatch(
      /signsHere: (true|false)/,
    );
  });

  it('says where each one signs, in the affirmative', () => {
    /* "WATCH-ONLY" alone is the wrong half of the sentence: it says what this
     * wallet cannot do without saying that something else can, which reads as
     * a limitation rather than as the design. */
    const accounts = accountsFrom(paired(), hot());
    expect(signingNote(accounts[0]!)).toBe('SIGNS ON YOUR VAULT');
    expect(signingNote(accounts[1]!)).toBe('SIGNS ON THIS PHONE');
  });

  it('puts the vault first, whatever order things arrived in', () => {
    /* Most protected first, which reads as a recommendation without printing
     * one, and stable so a hot wallet made later does not push a vault down a
     * screen somebody has learned the shape of. */
    const later = { ...hot(), createdAt: 0 };
    expect(accountsFrom(paired(), later).map((a) => a.id)).toEqual(['vault', 'hot']);
  });
});

describe('every account is watched, and one of them is being looked at', () => {
  /* This replaced a precedence. A pairing used to beat a hot record for the
   * single account key the watcher held, and the accounts screen printed a
   * sentence on whichever one lost. There is a watcher per account now, so
   * nothing loses and the sentence is gone. What is left to decide is which
   * account the interface is *about*, which is a different question with a
   * visible answer. */

  it('has no selection when there is nothing to select', () => {
    expect(selected([], null)).toBeNull();
  });

  it('honors a selection that exists', () => {
    expect(selected(['vault', 'hot'], 'hot')).toBe('hot');
  });

  it('falls back to the first when the wanted account is gone', () => {
    /* Forgetting the account somebody was looking at must not leave a screen
     * rendering a balance for a wallet that no longer exists. `accountsFrom`
     * orders vault first, so the fallback is the one with the stronger
     * protection rather than wherever an index happened to point. */
    expect(selected(['vault'], 'hot')).toBe('vault');
    expect(selected(['hot'], 'vault')).toBe('hot');
  });

  it('keeps the wish rather than the resolution, so an account can come back', () => {
    /* `selected` is a function of what exists and what was wanted, not a
     * stored index. Wanting an account that is missing and then having it
     * again lands somebody back where they were. */
    expect(selected(['vault'], 'hot')).toBe('vault');
    expect(selected(['vault', 'hot'], 'hot')).toBe('hot');
  });

  it('gives both kinds of account a row, which is what the watchers key off', () => {
    const ids = accountsFrom(paired(), hot()).map((account) => account.id);
    expect(ids).toEqual(['vault', 'hot']);
    /* And every one of them resolves to itself, so no account is unreachable
     * through the selection. */
    for (const id of ids) expect(selected(ids, id)).toBe(id);
  });
});

/*
 * The screen.
 *
 * Comments stripped before every check, for the reason this repository keeps
 * relearning: a guard that fires on the prose explaining its own rule teaches
 * people to delete the prose.
 */

/** Comments removed, so a guard never fires on its own documentation. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the accounts screen', () => {
  const screen = readFileSync('src/screens/Accounts.tsx', 'utf8');
  const home = readFileSync('src/screens/Home.tsx', 'utf8');
  const app = readFileSync('App.tsx', 'utf8');

  it('exists and is reachable', () => {
    expect(codeOnly(app)).toMatch(/name="Accounts"/);
    expect(codeOnly(home)).toMatch(/navigate\('Accounts'\)/);
  });

  it('says where every account signs, through the one function that words it', () => {
    /* Not "watch-only", which says what this wallet cannot do without saying
     * that something else can. One wording, one place. */
    const code = codeOnly(screen);
    expect(code).toMatch(/signingNote\(account\)/);
    expect(code, 'a row must not word this itself').not.toMatch(/WATCH-ONLY/);
  });

  it('never decides signability in the screen', () => {
    /* The rule lives in `canSignHere` and reaches the row through
     * `account.signsHere`. A screen comparing sources itself would be a second
     * implementation of the one rule the product rests on. */
    const code = codeOnly(screen);
    expect(code, 'the screen is deciding for itself').not.toMatch(/canSignHere/);
  });

  it('offers only the kind of account that is missing', () => {
    /* Two levers where one is inert is a screen asking somebody to work out
     * which of them applies to them. */
    const code = codeOnly(screen);
    expect(code).toMatch(/accounts\.some\(\(account\) => account\.source === 'vault'\) \? null/);
    expect(code).toMatch(/accounts\.some\(\(account\) => account\.source === 'hot'\) \? null/);
  });

  it('has the empty state, and gets its sentence from the module', () => {
    const code = codeOnly(screen);
    expect(code).toMatch(/watchingNothing\(accounts\)/);
    expect(code).toMatch(/\{NOTHING_WATCHED\}/);
    expect(code, 'the sentence must not be retyped in the screen').not.toMatch(/No accounts yet/);
  });

  it('names the account on the screen that hands out an address', () => {
    /* An address belongs to exactly one account, and money sent to it lands
     * there and nowhere else. Somebody who means to fund the wallet on this
     * phone and pastes the vault's address has put money somewhere they cannot
     * spend from without the other device. Same argument as the coin picker
     * naming its chain on every row: the thing that decides where money ends
     * up goes on the glass, not behind a tap. */
    const receive = codeOnly(readFileSync('src/screens/Receive.tsx', 'utf8'));
    expect(receive).toMatch(/store\.accounts\.find\(\(entry\) => entry\.id === store\.selectedAccount\)/);
    expect(receive).toMatch(/RECEIVE INTO/);
    expect(receive).toMatch(/signingNote\(account\)/);
  });

  it('leaves the home screen with no way to render a balance it does not have', () => {
    /* The finding, checked at the screen that used to carry it. */
    const code = codeOnly(home);
    expect(code, 'the fixture chip is back').not.toMatch(/DEMO DATA/);
    expect(code).toMatch(/if \(watchingNothing\(accounts\)\)/);
  });
});
