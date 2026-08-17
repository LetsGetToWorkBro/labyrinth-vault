/*
 * Rebuilding a vault from the two phrases it showed at setup.
 *
 * ## What this closes
 *
 * The vault could show recovery words and never take them back. The passphrase
 * screen says, of a forgotten passphrase, "there is no reset: forgetting it
 * means recovering from the words on paper", and there was no route, no screen
 * and no bridge method that accepted a phrase. The words restore both wallets
 * into Sparrow or Cake, so nobody's money was ever at risk; what was missing
 * was any way back to an *airgap*, which is the thing the product is for. A
 * lost vault phone meant hot keys in other software, or a new vault and an
 * on-chain move.
 *
 * ## The test that matters, and why it is first
 *
 * A restore that produces a vault which opens is worthless. A restore that
 * produces the vault *those words came from* is the whole feature, and the
 * difference between them is invisible until somebody looks at an empty
 * balance. So the identity check leads: create a vault, read its words, seal a
 * new one from them under a different passphrase, and compare the account keys.
 * Everything else here is a refusal.
 *
 * ## The derivation is a stand-in, deliberately
 *
 * Same seam and the same argument as `reseal.test.ts`: `runInNewContext` gives
 * the bundle no JIT, so one real Argon2id pass takes about ninety seconds here.
 * The derivation is not what is under test and is pinned against the Argon2
 * reference in `primitives.test.ts`; what is under test is whether the words
 * rebuild the keys.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const BUNDLE = 'ios/LabyrinthVault/Resources/vault.bundle.js';

type Api = Record<string, (...args: unknown[]) => string>;

const cheapKdf = (passphrase: number[], salt: number[], t: number, m: number, p: number, dkLen: number) => {
  const out: number[] = [];
  for (let i = 0; i < dkLen; i++) {
    let h = 0x811c9dc5 ^ (i * 2654435761) ^ (t * 31) ^ (m * 17) ^ (p * 7);
    for (const b of passphrase) h = Math.imul(h ^ b, 16777619) >>> 0;
    for (const b of salt) h = Math.imul(h ^ b, 16777619) >>> 0;
    out.push(h & 0xff);
  }
  return out;
};

const load = (): Api => {
  const context: Record<string, unknown> = { __labyrinthArgon2id: cheapKdf };
  runInNewContext(readFileSync(BUNDLE, 'utf8'), context);
  const api = context.LabyrinthVault as Api;
  /* "mismatch" means the seam is live and the function behind it is a
   * stand-in. "engine" would mean the stand-in was never adopted and these
   * tests are ninety seconds a vault, which is the regression to catch. */
  expect(JSON.parse(api.version!()).kdf).toBe('mismatch');
  return api;
};

const call = (api: Api, name: string, ...args: unknown[]) => JSON.parse(api[name]!(...args));
const bytes = (text: string) => Array.from(new TextEncoder().encode(text));
const hexOf = (n: number, seed: number) =>
  Array.from({ length: n }, (_, i) => ((i * seed + 11) & 0xff).toString(16).padStart(2, '0')).join('');

const MADE_WITH = 'the passphrase this vault was made with';
const ON_THE_NEW_PHONE = 'a different passphrase, on the phone that replaced it';

/** The randomness `create` wants: the secret plus the seal. */
const CREATE_RANDOM = hexOf(88, 37);
/** The randomness `restore` wants: the seal alone, because the secret is on
 *  paper. Getting this wrong is the first thing a caller does. */
const SEAL_RANDOM = hexOf(40, 13);

interface Words {
  bitcoin: string;
  monero: string;
}

describe('restoring a vault from its words', () => {
  let api: Api;
  let sealed: string;
  let words: Words;
  let zpub: string;
  let xmrAddress: string;

  beforeEach(() => {
    api = load();
    const made = call(api, 'create', CREATE_RANDOM, bytes(MADE_WITH));
    expect(made.ok, made.problem).toBe(true);
    sealed = made.sealed;

    const opened = call(api, 'unlock', sealed, bytes(MADE_WITH));
    expect(opened.ok, opened.problem).toBe(true);
    zpub = opened.btcAccount.zpub;
    xmrAddress = opened.xmrAddress;

    const backup = call(api, 'revealBackup');
    expect(backup.ok, backup.problem).toBe(true);
    words = { bitcoin: backup.bitcoin.join(' '), monero: backup.monero.join(' ') };
    expect(words.bitcoin.split(' ')).toHaveLength(12);
    expect(words.monero.split(' ')).toHaveLength(25);

    /* Locked, because the phone this is being restored onto has no session and
     * a test that restored out of an open one would prove nothing about the
     * case this exists for. */
    call(api, 'lock');
  });

  it('rebuilds the same vault, which is the entire point', () => {
    const back = call(api, 'restore', words.bitcoin, words.monero, bytes(ON_THE_NEW_PHONE), SEAL_RANDOM);
    expect(back.ok, back.problem).toBe(true);

    const opened = call(api, 'unlock', back.sealed, bytes(ON_THE_NEW_PHONE));
    expect(opened.ok, opened.problem).toBe(true);
    /* The account key is the identity. A restore that produced a *different*
     * vault would open, look healthy, and watch addresses nobody has ever been
     * paid at. */
    expect(opened.btcAccount.zpub).toBe(zpub);
    expect(opened.xmrAddress).toBe(xmrAddress);
  });

  it('shows the same words back, so the paper is still the backup', () => {
    const back = call(api, 'restore', words.bitcoin, words.monero, bytes(ON_THE_NEW_PHONE), SEAL_RANDOM);
    call(api, 'unlock', back.sealed, bytes(ON_THE_NEW_PHONE));
    const again = call(api, 'revealBackup');

    expect(again.bitcoin.join(' ')).toBe(words.bitcoin);
    expect(again.monero.join(' ')).toBe(words.monero);
  });

  it('is a new blob under a new passphrase, not a copy of the old one', () => {
    const back = call(api, 'restore', words.bitcoin, words.monero, bytes(ON_THE_NEW_PHONE), SEAL_RANDOM);
    expect(back.sealed).not.toBe(sealed);
    /* The old passphrase is gone with the old phone. If it still opened this,
     * the restore had reused a salt or a key it had no business having. */
    expect(call(api, 'unlock', back.sealed, bytes(MADE_WITH)).ok).toBe(false);
  });

  it('reads whitespace and case the way a person types them', () => {
    /* Twelve words retyped from paper arrive with a double space in them and,
     * on a phone that capitalizes the first letter of a field, a capital.
     * Both are the same phrase and refusing them is refusing the person. */
    const messy = `  ${words.bitcoin.replace(' ', '  ').toUpperCase()}\n`;
    const back = call(api, 'restore', messy, words.monero, bytes(ON_THE_NEW_PHONE), SEAL_RANDOM);
    expect(back.ok, back.problem).toBe(true);
    expect(call(api, 'unlock', back.sealed, bytes(ON_THE_NEW_PHONE)).btcAccount.zpub).toBe(zpub);
  });

  it('is not an unlock, so it cannot be a way into a session', () => {
    call(api, 'restore', words.bitcoin, words.monero, bytes(ON_THE_NEW_PHONE), SEAL_RANDOM);
    expect(call(api, 'unlocked').unlocked).toBe(false);
  });

  it('hands back a sealed blob and nothing else', () => {
    /* The same rule the whole bridge lives under: what crosses is ciphertext.
     * This function has both phrases and the plaintext secret in scope, which
     * is exactly why it is worth checking that neither leaves. */
    const back = call(api, 'restore', words.bitcoin, words.monero, bytes(ON_THE_NEW_PHONE), SEAL_RANDOM);
    expect(Object.keys(back).sort()).toEqual(['ok', 'sealed']);
    expect(back.sealed).not.toContain(words.bitcoin.split(' ')[0]);
  });
});

describe('what a restore refuses', () => {
  let api: Api;
  let words: Words;

  beforeEach(() => {
    api = load();
    const made = call(api, 'create', CREATE_RANDOM, bytes(MADE_WITH));
    call(api, 'unlock', made.sealed, bytes(MADE_WITH));
    const backup = call(api, 'revealBackup');
    words = { bitcoin: backup.bitcoin.join(' '), monero: backup.monero.join(' ') };
    call(api, 'lock');
  });

  const attempt = (bitcoin: string, monero: string, pass: unknown = bytes(ON_THE_NEW_PHONE), random = SEAL_RANDOM) =>
    call(api, 'restore', bitcoin, monero, pass, random);

  it('names which phrase is wrong, because there are two fields', () => {
    /* "Those words fail their own checksum" in front of two fields sends
     * somebody to re-read both. */
    const swapped = attempt(words.monero, words.bitcoin);
    expect(swapped.ok).toBe(false);
    expect(swapped.problem).toMatch(/^Bitcoin phrase:/);

    const badMonero = attempt(words.bitcoin, words.monero.replace(/\S+$/, 'zebra'));
    expect(badMonero.ok).toBe(false);
    expect(badMonero.problem).toMatch(/^Monero phrase:/);
  });

  it('refuses a mistyped word rather than restoring a different wallet', () => {
    /* A phrase with one word changed is, for most changes, a phrase whose
     * checksum fails. That is the check earning its keep: the alternative is a
     * vault built from bytes nobody has ever been paid at. */
    const typo = words.bitcoin.split(' ');
    typo[3] = typo[3] === 'zebra' ? 'zoo' : 'zebra';
    const back = attempt(typo.join(' '), words.monero);
    expect(back.ok).toBe(false);
    expect(back.problem).toMatch(/checksum/i);
  });

  it('refuses a valid 24-word phrase, which is somebody else\'s wallet', () => {
    /* Twenty-four words pass BIP39 and decode to 32 bytes. A vault's Bitcoin
     * half is 16, fixed by SECRET_BYTES, so this is a real seed for other
     * software and cannot be the one this vault was sealed from. Accepting it
     * would produce a vault that opens and shows different words than were
     * typed. */
    const twentyFour = entropyToMnemonic(
      /* Varied rather than a fill. Thirty-two zero bytes is the published
       * BIP39 vector and also the degenerate fixture this repository keeps
       * finding, and a phrase of one repeated word would not tell a length
       * check from a wordlist check. */
      Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 5) & 0xff),
      wordlist,
    );
    expect(twentyFour.split(' ')).toHaveLength(24);

    const back = attempt(twentyFour, words.monero);
    expect(back.ok).toBe(false);
    /* The length, not the checksum. A phrase that failed its checksum would be
     * refused by the line above this one, and this test would pass without the
     * branch it is about ever running. */
    expect(back.problem).toMatch(/12 words/);
    expect(back.problem).not.toMatch(/checksum/i);
  });

  it('refuses an empty field with a sentence rather than a shrug', () => {
    expect(attempt('', words.monero).problem).toMatch(/^Bitcoin phrase:/);
    expect(attempt(words.bitcoin, '').problem).toMatch(/^Monero phrase:/);
  });

  it('refuses randomness of the wrong length rather than stretching it', () => {
    /* Forty, not eighty-eight. The secret is on paper, so this is the seal's
     * randomness alone, and a caller that passed `create`'s amount is a caller
     * who has not read which function they are calling. */
    for (const bad of [hexOf(39, 5), hexOf(41, 5), hexOf(88, 5), '']) {
      const back = attempt(words.bitcoin, words.monero, bytes(ON_THE_NEW_PHONE), bad);
      expect(back.ok).toBe(false);
      expect(back.problem).toMatch(/randomness/);
    }
  });

  it('refuses a passphrase that arrives as a string', () => {
    /* A string cannot be wiped. Same contract as every other function that
     * takes one, and the convenient path must not quietly become the
     * unwipeable one on the newest function in the file. */
    const back = attempt(words.bitcoin, words.monero, ON_THE_NEW_PHONE);
    expect(back.ok).toBe(false);
  });

  it('answers with JSON rather than throwing, whatever it is handed', () => {
    for (const junk of ['', 'zzzz', '{}', 'ur:nonsense', 'ffff'.repeat(200)]) {
      let raw = '';
      expect(() => {
        raw = api['restore']!(junk, junk, junk, junk);
      }, `restore threw on ${JSON.stringify(junk.slice(0, 12))}`).not.toThrow();
      const parsed = JSON.parse(raw);
      expect(parsed.ok).toBe(false);
      expect(typeof parsed.problem).toBe('string');
    }
  });
});
