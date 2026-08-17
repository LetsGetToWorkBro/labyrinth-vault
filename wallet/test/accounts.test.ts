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
import {
  NOTHING_WATCHED,
  accountsFrom,
  anySignsHere,
  signingNote,
  watchingNothing,
} from '../src/core/accounts';
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
    const later = { ...hot(), birth: 0 };
    expect(accountsFrom(paired(), later).map((a) => a.id)).toEqual(['vault', 'hot']);
  });
});
