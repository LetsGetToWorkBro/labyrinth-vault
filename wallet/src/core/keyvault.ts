/**
 * The wallet's own keys, for the accounts it spends from itself.
 *
 * ## What changed, and what did not
 *
 * This wallet was watch-only from the first commit, and the sentence "it holds
 * no key" was the product. That sentence is now conditional, and this file is
 * the condition. It has to be read as a security document rather than as
 * storage plumbing, because that is what it is.
 *
 * What did **not** change: an account paired from a vault stays watch-only and
 * cannot be signed here, ever. The two kinds of account live side by side and
 * `Held.source` is the difference. A vault account that could be spent from
 * this side would make the airgap a decoration, so `signerFor` refuses one and
 * `test/keyvault.test.ts` fails if that refusal is ever removed.
 *
 * ## The threat model, stated because the vault's is different
 *
 * The vault assumes the device is taken and studied. That is why its seed sits
 * under Argon2id at 64 MiB and three passes, and why an unlock there is
 * allowed to cost a measurable number of seconds.
 *
 * This wallet is a networked application that a person opens several times a
 * day, and its realistic loss is a phone taken while unlocked. Argon2id does
 * nothing against that, and it cannot be run here anyway at parameters worth
 * having: the vault measured one derivation at roughly 57 seconds interpreted
 * on a server CPU, and this app has no native module for it. A minute per
 * unlock is not a wallet, and lowering the parameters to make it fast is a
 * weak seal on a seed, which is worse than an honest one.
 *
 * So the seed is held by the platform keychain with
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, which means the Secure Enclave, the device
 * passcode, and no copy riding a backup onto the next phone. That is the same
 * bar `keychainStore.ts` already set for the pairing, and it is what a hot
 * wallet's threat model actually asks for.
 *
 * **This is a real reduction against the vault and it is not hidden.** A seed
 * here is protected by the device, not by something you know. Anything worth
 * more than a phone belongs on the other half.
 *
 * ## Why this file has no native import
 *
 * Same split as `persist.ts` against `fileStore.ts`: the storage is an
 * interface, so every decision below runs under Node in the tests while the
 * code the app runs is this code. A key store whose logic can only be
 * exercised on a device is a key store nobody tests.
 */

import {
  restoreHeight,
  revealSecretHex,
  seedFromMnemonic,
  walletFromSeed,
  wipeWallet,
  type Network,
} from '@vault/keys/monero';
import {
  checkMnemonic,
  closeWallet,
  mnemonicFromStoredEntropy,
  openFromMnemonic,
  type BtcWallet,
} from '@vault/keys/bitcoin';
import type { Store } from '../state/persist';

/** Where an account's keys are, which decides what may be done with it. */
export type Source =
  /** Paired from a vault. Watch-only here, forever. */
  | 'vault'
  /** This wallet holds the seed and can sign. */
  | 'hot';

export const KEYVAULT_SCHEMA = 1;

/**
 * What sits in the keychain.
 *
 * One record, not one per chain: the two chains come from one secret so that a
 * person writes down one backup. Splitting them would double what there is to
 * lose and halve the chance either half is written down.
 *
 * The Monero seed and the Bitcoin phrase are stored rather than derived from
 * one another, because they are different standards and inventing a mapping
 * between them would produce a wallet no other software can restore. Both are
 * generated together and backed up together; that is the only relationship.
 */
export interface HotRecord {
  v: number;
  /** 64 hex characters, or null for a wallet holding no Monero keys. */
  xmrSeed: string | null;
  /** Twelve BIP39 words, or null for a wallet holding no Bitcoin keys. */
  btcMnemonic: string | null;
  /** Which Monero network this seed is for. */
  network: Network;
  /**
   * When this wallet was made, in **milliseconds**.
   *
   * Named `createdAt` and not `birth`, and the difference is not cosmetic.
   * Every other `birth` in this codebase is a Monero **block height**:
   * `pairing.ts`, `persist.ts`, `moneroscan.ts` and `findcoins.ts` all mean
   * blocks by it, and two of them bound the value at a hundred million to say
   * so. A field of the same name and the same `number` type meaning
   * milliseconds sat next to those for exactly one commit, and in that commit
   * it was passed straight into a scan as a height: the wallet would have
   * started scanning at block 1,760,000,000,000, found nothing, and reported
   * zero for an account with money in it.
   *
   * `Draft.createdAt` already meant milliseconds. This name joins that
   * convention so the units are legible at every call site rather than in a
   * comment somebody has to go and find. `watchOnlyFrom` is where it becomes a
   * height.
   */
  createdAt: number;
}

export type ReadResult =
  | { ok: true; record: HotRecord }
  | { ok: false; problem: string };

/**
 * Read a stored record, refusing anything that is not exactly one.
 *
 * Every field is checked rather than trusted. The keychain is not a hostile
 * input in the way a QR code is, but a record written by an older build is a
 * real thing that happens, and a wallet that half-reads one derives addresses
 * from a seed that is not the seed and then reports a balance of zero for
 * money that is there.
 */
export function parseHotRecord(text: string | null): ReadResult {
  if (text === null) return { ok: false, problem: 'No spending keys are stored on this device.' };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'The stored keys are not readable. Restore from your backup.' };
  }
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, problem: 'The stored keys are not readable. Restore from your backup.' };
  }

  const record = raw as Record<string, unknown>;
  if (record['v'] !== KEYVAULT_SCHEMA) {
    return {
      ok: false,
      problem: `These keys were written by a different version of this app (${String(record['v'])}). Restore from your backup.`,
    };
  }

  /* Each half is optional and at least one must be present. Somebody
   * restoring a twenty-five word phrase out of Feather has a Monero wallet and
   * no Bitcoin one, and a record that insisted on both would have had to
   * invent a Bitcoin seed to hold their Monero. Inventing key material to
   * satisfy a shape is how a wallet ends up with an account nobody backed up. */
  const rawXmr = record['xmrSeed'];
  if (rawXmr !== null && rawXmr !== undefined && (typeof rawXmr !== 'string' || !/^[0-9a-f]{64}$/.test(rawXmr))) {
    return { ok: false, problem: 'The stored Monero seed is not 32 bytes of hex.' };
  }
  const xmrSeed = typeof rawXmr === 'string' ? rawXmr : null;

  const rawBtc = record['btcMnemonic'];
  if (rawBtc !== null && rawBtc !== undefined) {
    if (typeof rawBtc !== 'string') {
      return { ok: false, problem: 'The stored Bitcoin phrase is missing.' };
    }
    const phrase = checkMnemonic(rawBtc);
    if (!phrase.ok) {
      return { ok: false, problem: `The stored Bitcoin phrase is not valid: ${phrase.problem ?? 'unknown'}` };
    }
  }
  const btcMnemonic = typeof rawBtc === 'string' ? rawBtc : null;

  if (xmrSeed === null && btcMnemonic === null) {
    return { ok: false, problem: 'These keys hold neither a Monero nor a Bitcoin wallet.' };
  }

  const network = record['network'];
  if (network !== 'mainnet' && network !== 'stagenet' && network !== 'testnet') {
    return { ok: false, problem: 'The stored keys do not say which network they are for.' };
  }

  const createdAt = record['createdAt'];
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) {
    return { ok: false, problem: 'The stored keys have no usable creation time.' };
  }

  return { ok: true, record: { v: KEYVAULT_SCHEMA, xmrSeed, btcMnemonic, network, createdAt } };
}

/** The text to hand the keychain. Separate from writing it, so it is testable. */
export function encodeHotRecord(record: HotRecord): string {
  return JSON.stringify({ ...record, v: KEYVAULT_SCHEMA });
}

/**
 * Make a record from entropy the caller supplies.
 *
 * The randomness is a parameter rather than drawn here, for the reason every
 * other key path in this project takes it as one: a function that draws its
 * own entropy cannot be tested against a known answer, and a wallet whose key
 * generation has never been checked against a fixed input is a wallet nobody
 * has checked at all.
 *
 * 32 bytes for Monero, 16 for Bitcoin. Sixteen is a twelve-word phrase, which
 * is the length BIP84's own vector uses and the length a person will actually
 * copy onto paper. Twenty-four words is more entropy than the 128-bit security
 * of the curve underneath it, so it buys nothing and costs a backup people
 * skip.
 */
export function makeHotRecord(
  xmrEntropy: Uint8Array,
  btcEntropy: Uint8Array,
  network: Network,
  when: number,
): { ok: true; record: HotRecord } | { ok: false; problem: string } {
  if (xmrEntropy.length !== 32) {
    return { ok: false, problem: 'Monero needs exactly 32 bytes of entropy.' };
  }
  if (btcEntropy.length !== 16) {
    return { ok: false, problem: 'Bitcoin needs exactly 16 bytes of entropy.' };
  }

  /* Through `walletFromSeed` rather than storing the raw bytes, because it
   * reduces the seed and the twenty-five words encode the *reduced* key. A
   * record holding unreduced entropy would print a phrase that restores to a
   * different wallet than the address beside it, which is the exact silent
   * failure `monero.ts` documents at length. */
  const wallet = walletFromSeed(xmrEntropy, network);
  const xmrSeed = revealSecretHex(wallet.spendSecret);
  wipeWallet(wallet);

  const btcMnemonic = mnemonicFromStoredEntropy(btcEntropy);
  const phrase = checkMnemonic(btcMnemonic);
  if (!phrase.ok) {
    return { ok: false, problem: `Generated a Bitcoin phrase that does not check out: ${phrase.problem ?? 'unknown'}` };
  }

  return { ok: true, record: { v: KEYVAULT_SCHEMA, xmrSeed, btcMnemonic, network, createdAt: when } };
}

/**
 * Open the Bitcoin half. The caller closes it.
 *
 * Returned rather than held, because a wallet object holds key material and
 * this module has no lifecycle to hang it off. Whoever opens one is the one
 * who knows when the signing is over.
 */
export function openBitcoin(record: HotRecord): BtcWallet | null {
  if (record.btcMnemonic === null) return null;
  return openFromMnemonic(record.btcMnemonic);
}

/** Close the Bitcoin half. Named beside `openBitcoin` so the pair is visible. */
export function closeBitcoin(wallet: BtcWallet): void {
  closeWallet(wallet);
}

/** Open the Monero half. The caller wipes it. */
export function openMonero(record: HotRecord) {
  if (record.xmrSeed === null) return null;
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = parseInt(record.xmrSeed.slice(i * 2, i * 2 + 2), 16);
  const wallet = walletFromSeed(seed, record.network);
  seed.fill(0);
  return wallet;
}

/**
 * The watch-only half of a hot record, derived on demand.
 *
 * A wallet that can sign but has no addresses is not a wallet. Until this
 * existed, a record made by the backup screens was listed, backed up,
 * restorable and signable, and never *watched*: `store.tsx` read its account
 * key and its Monero view key from the vault pairing alone, so a hot account
 * had no balance, no receiving address, and no way to build a payment for the
 * signer to sign. The keys were on the phone and the wallet could not see them.
 *
 * What comes back is exactly what a vault exports across the airgap: an account
 * key and a view key. Neither can spend. Deriving them from a seed we already
 * hold is not a widening of what this device knows, it is the same watching
 * capability arriving by a shorter route.
 *
 * Both wallets are opened, read, and closed here. The caller gets strings.
 *
 * ## The unit that has to be converted here and not at the call site
 *
 * `HotRecord.birth` is **milliseconds**, because that is what a creation time
 * is. A Monero scan start is a **block height**. Those are different numbers by
 * six orders of magnitude, and passing one where the other is expected does not
 * throw: it produces a scan that starts at block 1,760,000,000,000, finds
 * nothing, and reports a balance of zero for a wallet with money in it. That is
 * the exact failure `withRestored` refuses to risk by starting a restored
 * wallet at zero, arriving by a different door.
 *
 * So the conversion happens here, once, and what comes out is a height. A
 * record with no creation time, which is every restored one, converts to zero,
 * which means scan from the beginning: slow and correct, rather than fast and
 * silently short.
 */
export interface WatchOnly {
  /** The BIP84 account key, or null when this record holds no Bitcoin. */
  zpub: string | null;
  /** Address, private view key, and a scan start **in blocks**. */
  xmr: { address: string; view: string; birth: number } | null;
}

export function watchOnlyFrom(record: HotRecord): WatchOnly {
  let zpub: string | null = null;
  const btc = openBitcoin(record);
  if (btc !== null) {
    zpub = btc.zpub;
    closeBitcoin(btc);
  }

  let xmr: { address: string; view: string; birth: number } | null = null;
  const monero = openMonero(record);
  if (monero !== null) {
    xmr = {
      address: monero.address,
      view: revealSecretHex(monero.viewSecret),
      /* Milliseconds in, blocks out. `restoreHeight` also backs off by a week,
       * which matters for a wallet made moments ago: an estimate that lands a
       * few blocks late misses the first payment into it. Zero milliseconds is
       * before genesis and converts to zero, so a restored record keeps
       * scanning from the beginning. */
      birth: restoreHeight(record.createdAt),
    };
    wipeWallet(monero);
  }

  return { zpub, xmr };
}

/**
 * Whether an account may be signed for on this device.
 *
 * The whole reason this file names a `Source`. A vault account is watch-only
 * here even when a hot record happens to exist, because the two are unrelated
 * accounts and signing one with the other's keys would produce a valid
 * transaction that spends nothing and confuses everybody, or worse, appears to
 * work against an address a person believes is airgapped.
 */
export function canSignHere(source: Source): boolean {
  return source === 'hot';
}

/**
 * Read what is stored, through whatever `Store` the caller has.
 *
 * `keychainStore()` in the app, `memoryStore()` in the tests, same code.
 */
export async function loadHot(store: Store): Promise<ReadResult> {
  return parseHotRecord(await store.read());
}

/** Write a record. Overwrites, because there is exactly one. */
export async function saveHot(store: Store, record: HotRecord): Promise<void> {
  await store.write(encodeHotRecord(record));
}

/**
 * Forget the spending keys.
 *
 * Named `forget` rather than `delete` because that is what it does and what it
 * does not: the coins stay on the chain, and the backup still restores them.
 * A screen that says "delete wallet" invites somebody to believe they have
 * destroyed something they have not.
 */
export async function forgetHot(store: Store): Promise<void> {
  await store.clear();
}

// ---------------------------------------------------------------- restoring

/** What a pasted phrase turned out to be. */
export type Restored =
  | { ok: true; chain: 'xmr'; xmrSeed: string; words: number }
  | { ok: true; chain: 'btc'; btcMnemonic: string; words: number }
  | { ok: false; problem: string };

/**
 * Read a phrase somebody typed or pasted, and say which chain it is.
 *
 * The word count decides, and it almost decides unambiguously: Monero's list
 * is twenty-five words and BIP39's is twelve, fifteen, eighteen, twenty-one or
 * twenty-four. No count means both, so there is no picker asking somebody to
 * classify their own backup.
 *
 * The "almost" is twenty-four, and it is the case worth handling rather than
 * the case worth ignoring. A Monero phrase with one word dropped is twenty-
 * four words, which is a valid BIP39 length, so it takes the Bitcoin branch
 * and fails a Bitcoin checksum. A person who fumbled their Monero backup then
 * reads a sentence about Bitcoin. So a twenty-four word phrase that fails
 * names both possibilities, because the wallet cannot tell which one it is
 * and the person can.
 *
 * Whitespace is collapsed and case is folded before anything else, because a
 * phrase arrives from a screenshot, a password manager, or a piece of paper
 * read aloud, and none of those preserve spacing. What is *not* done is any
 * correction of the words themselves: a phrase with a typo must fail, loudly,
 * naming the count it found, rather than being nudged into a valid phrase for
 * a different wallet.
 *
 * The counts are named in the refusals on purpose. "Not a valid phrase" sends
 * somebody to check twenty-five words one at a time; "found 24 words, Monero
 * uses 25" sends them to look for the one they dropped.
 */
export function readPhrase(text: string): Restored {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);

  if (words.length === 0) return { ok: false, problem: 'Nothing to read yet.' };

  if (words.length === 25) {
    const back = seedFromMnemonic(words);
    if (back.seed === null) {
      return { ok: false, problem: back.problem ?? 'That is not a valid Monero phrase.' };
    }
    return { ok: true, chain: 'xmr', xmrSeed: revealSecretHex(back.seed), words: 25 };
  }

  if ([12, 15, 18, 21, 24].includes(words.length)) {
    const joined = words.join(' ');
    const check = checkMnemonic(joined);
    if (!check.ok) {
      if (words.length === 24) {
        return {
          ok: false,
          problem:
            'Found 24 words. That is a Bitcoin length, and these fail a Bitcoin checksum, so ' +
            'either one word is mistyped or this is a Monero phrase with one of its 25 missing.',
        };
      }
      return { ok: false, problem: check.problem ?? 'That is not a valid Bitcoin phrase.' };
    }
    return { ok: true, chain: 'btc', btcMnemonic: check.words ?? joined, words: words.length };
  }

  /* Neither length. Naming the two that would have worked is the whole value
   * of this branch: somebody who pasted 24 words meant Monero and dropped one,
   * or meant Bitcoin and has a valid 24-word phrase that took the branch
   * above. Either way the count is the clue. */
  return {
    ok: false,
    problem:
      `Found ${words.length} words. A Monero phrase is 25 and a Bitcoin phrase is 12 or 24, ` +
      'so this is missing some or has picked up something that is not a word.',
  };
}

/**
 * Fold a restored phrase into a record, keeping whatever was already there.
 *
 * Restoring one chain must never quietly discard the other. Somebody who has
 * a Bitcoin wallet on this device and then restores a Monero phrase ends up
 * holding both, and the Bitcoin half is untouched: it is not this operation's
 * business, and losing it here would be a wipe wearing the word "restore".
 */
export function withRestored(
  existing: HotRecord | null,
  restored: Restored,
  network: Network,
  when: number,
): { ok: true; record: HotRecord } | { ok: false; problem: string } {
  if (!restored.ok) return { ok: false, problem: restored.problem };

  const base: HotRecord = existing ?? {
    v: KEYVAULT_SCHEMA,
    xmrSeed: null,
    btcMnemonic: null,
    network,
    /* A restored wallet has a past, and nobody typing a phrase knows when it
     * was made. Zero converts to block zero, which means scan from the
     * beginning: slow and correct, where guessing a recent point would be fast
     * and would silently miss every coin received before it. */
    createdAt: 0,
  };

  const record: HotRecord =
    restored.chain === 'xmr'
      ? { ...base, xmrSeed: restored.xmrSeed, createdAt: existing ? base.createdAt : 0 }
      : { ...base, btcMnemonic: restored.btcMnemonic, createdAt: existing ? base.createdAt : when };

  return { ok: true, record };
}
