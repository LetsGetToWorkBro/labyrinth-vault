/*
 * The wallet's own keys.
 *
 * Two different things are under test and only one of them is ordinary.
 *
 * The ordinary half is the record: it round-trips, it refuses anything that is
 * not exactly a record, and generation from fixed entropy produces a fixed
 * answer. That last one is the reason `makeHotRecord` takes its randomness as
 * a parameter at all. A key generator that draws its own entropy has never
 * been checked against a known result, which means it has never been checked.
 *
 * The other half is the rule that keeps the airgap meaningful: a vault account
 * is watch-only on this device forever, whatever else is stored. That rule is
 * one boolean, and one boolean is exactly the kind of thing a refactor
 * simplifies away.
 */

import { describe, expect, it } from 'vitest';
import { memoryStore } from '../src/state/persist';
import {
  KEYVAULT_SCHEMA,
  canSignHere,
  closeBitcoin,
  encodeHotRecord,
  forgetHot,
  loadHot,
  makeHotRecord,
  openBitcoin,
  openMonero,
  parseHotRecord,
  saveHot,
  type HotRecord,
} from '../src/core/keyvault';
import { revealMnemonic, revealSecretHex, wipeWallet } from '@vault/keys/monero';
import { addressAt } from '@vault/keys/bitcoin';

/* Fixed, so every answer below is reproducible. Not from a CSPRNG on purpose:
 * a test whose input changes per run cannot assert an address.
 *
 * Varied rather than a repeated byte, and that is not decoration. The first
 * version filled 32 bytes with 0x07, which reduces to a seed of `0707...07`.
 * That hex contains no letters, so the case-sensitivity assertion below
 * uppercased a string that had no case to change and passed against a parser
 * that had never been asked the question. A degenerate fixture is a test that
 * reports on itself. */
const XMR_ENTROPY = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);
const BTC_ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => (i * 53 + 29) & 0xff);
const WHEN = 1_700_000_000_000;

function fresh(): HotRecord {
  const made = makeHotRecord(XMR_ENTROPY, BTC_ENTROPY, 'mainnet', WHEN);
  if (!made.ok) throw new Error(made.problem);
  return made.record;
}

describe('a vault account can never be signed for here', () => {
  it('refuses a vault account and allows a hot one', () => {
    expect(canSignHere('vault')).toBe(false);
    expect(canSignHere('hot')).toBe(true);
  });

  it('is the only thing that decides, so no other state can override it', () => {
    /* The failure this guards: a later "if we happen to hold a seed, sign with
     * it" convenience. That would produce a signature against an account a
     * person believes is airgapped, which is the one promise the product
     * makes. `canSignHere` takes the source and nothing else, and this test
     * fails the moment it takes anything else. */
    expect(canSignHere.length).toBe(1);
  });
});

describe('generating keys', () => {
  it('is reproducible from the entropy it was given', () => {
    const a = fresh();
    const b = fresh();
    expect(a).toEqual(b);
  });

  it('stores the reduced Monero key, so the words match the address', () => {
    /* The silent failure `monero.ts` documents: a phrase written from raw
     * entropy restores to a different wallet than the address printed beside
     * it. Storing the reduced key is what prevents it, and reduction is
     * idempotent, so re-deriving from the stored value must land in the same
     * place. */
    const record = fresh();
    const first = openMonero(record);
    const address = first.address;
    const words = revealMnemonic(first);
    const seedHex = revealSecretHex(first.spendSecret);
    wipeWallet(first);

    expect(seedHex).toBe(record.xmrSeed);
    expect(words).toHaveLength(25);

    const again = openMonero({ ...record, xmrSeed: seedHex });
    expect(again.address).toBe(address);
    wipeWallet(again);
  });

  it('gives Bitcoin twelve words that open to a usable account', () => {
    const record = fresh();
    expect(record.btcMnemonic.split(/\s+/)).toHaveLength(12);
    const wallet = openBitcoin(record);
    const first = addressAt(wallet, 0, 0);
    expect(first.address).toMatch(/^bc1q/);
    /* Deterministic, so a restore lands on the same first address. */
    const twice = openBitcoin(record);
    expect(addressAt(twice, 0, 0).address).toBe(first.address);
    closeBitcoin(wallet);
    closeBitcoin(twice);
  });

  it('refuses entropy of the wrong length rather than padding it', () => {
    expect(makeHotRecord(new Uint8Array(31), BTC_ENTROPY, 'mainnet', WHEN).ok).toBe(false);
    expect(makeHotRecord(new Uint8Array(33), BTC_ENTROPY, 'mainnet', WHEN).ok).toBe(false);
    expect(makeHotRecord(XMR_ENTROPY, new Uint8Array(12), 'mainnet', WHEN).ok).toBe(false);
    expect(makeHotRecord(XMR_ENTROPY, new Uint8Array(32), 'mainnet', WHEN).ok).toBe(false);
  });

  it('carries the network, so a stagenet seed cannot be read as mainnet', () => {
    const main = makeHotRecord(XMR_ENTROPY, BTC_ENTROPY, 'mainnet', WHEN);
    const stage = makeHotRecord(XMR_ENTROPY, BTC_ENTROPY, 'stagenet', WHEN);
    expect(main.ok && stage.ok).toBe(true);
    if (!main.ok || !stage.ok) return;
    const a = openMonero(main.record);
    const b = openMonero(stage.record);
    expect(a.address).not.toBe(b.address);
    wipeWallet(a);
    wipeWallet(b);
  });
});

describe('reading what is stored', () => {
  it('round-trips a record it wrote', () => {
    const record = fresh();
    const read = parseHotRecord(encodeHotRecord(record));
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.record).toEqual(record);
  });

  it('says so plainly when nothing is stored', () => {
    const read = parseHotRecord(null);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problem).toMatch(/No spending keys/);
  });

  it('refuses a record from another schema rather than guessing', () => {
    const record = fresh();
    const older = JSON.stringify({ ...record, v: KEYVAULT_SCHEMA + 1 });
    const read = parseHotRecord(older);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problem).toMatch(/different version/);
  });

  it('refuses every mangled field, one at a time', () => {
    const record = fresh();
    const broken: Record<string, unknown>[] = [
      { ...record, xmrSeed: record.xmrSeed.slice(0, 62) },
      /* Valid hex, wrong case. Spelled out rather than derived from the
       * record, so this case cannot go vacuous again if the fixture changes. */
      { ...record, xmrSeed: 'ABCDEF01'.repeat(8) },
      { ...record, xmrSeed: 'zz'.repeat(32) },
      { ...record, btcMnemonic: 'not a phrase at all' },
      { ...record, btcMnemonic: 123 },
      { ...record, network: 'regtest' },
      { ...record, network: undefined },
      { ...record, birth: -1 },
      { ...record, birth: Number.NaN },
      { ...record, birth: 'yesterday' },
    ];
    for (const bad of broken) {
      const read = parseHotRecord(JSON.stringify(bad));
      expect(read.ok, `accepted ${JSON.stringify(bad).slice(0, 60)}`).toBe(false);
    }
  });

  it('refuses text that is not a record at all', () => {
    for (const text of ['', 'null', '[]', '"a string"', '42', '{', 'undefined']) {
      expect(parseHotRecord(text).ok, `accepted ${text}`).toBe(false);
    }
  });

  it('never lets a refusal read as an empty wallet', () => {
    /* A wallet that reports "no keys" for a record it merely failed to parse
     * sends somebody to restore from a backup they may not have, for keys that
     * are still there. The sentences have to differ. */
    const absent = parseHotRecord(null);
    const mangled = parseHotRecord('{"v":1,"xmrSeed":"nope"}');
    expect(absent.ok || mangled.ok).toBe(false);
    if (!absent.ok && !mangled.ok) expect(absent.problem).not.toBe(mangled.problem);
  });
});

describe('the store round trip', () => {
  it('saves, loads and forgets through whatever store it is given', async () => {
    const store = memoryStore();
    const record = fresh();

    expect((await loadHot(store)).ok).toBe(false);

    await saveHot(store, record);
    const read = await loadHot(store);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.record.xmrSeed).toBe(record.xmrSeed);

    await forgetHot(store);
    expect((await loadHot(store)).ok).toBe(false);
  });

  it('keeps exactly one record, so a second save replaces the first', async () => {
    const store = memoryStore();
    const first = fresh();
    const second = makeHotRecord(new Uint8Array(32).fill(3), new Uint8Array(16).fill(4), 'mainnet', WHEN);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    await saveHot(store, first);
    await saveHot(store, second.record);
    const read = await loadHot(store);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.record.xmrSeed).toBe(second.record.xmrSeed);
  });
});
