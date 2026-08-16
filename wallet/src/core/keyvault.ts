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

import { walletFromSeed, revealSecretHex, wipeWallet, type Network } from '@vault/keys/monero';
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
  /** 64 hex characters. The Monero spend seed. */
  xmrSeed: string;
  /** Twelve BIP39 words. The Bitcoin account. */
  btcMnemonic: string;
  /** Which Monero network this seed is for. */
  network: Network;
  /** Milliseconds. Where a Monero scan may start, since a new wallet has no past. */
  birth: number;
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

  const xmrSeed = record['xmrSeed'];
  if (typeof xmrSeed !== 'string' || !/^[0-9a-f]{64}$/.test(xmrSeed)) {
    return { ok: false, problem: 'The stored Monero seed is not 32 bytes of hex.' };
  }

  const btcMnemonic = record['btcMnemonic'];
  if (typeof btcMnemonic !== 'string') {
    return { ok: false, problem: 'The stored Bitcoin phrase is missing.' };
  }
  const phrase = checkMnemonic(btcMnemonic);
  if (!phrase.ok) {
    return { ok: false, problem: `The stored Bitcoin phrase is not valid: ${phrase.problem ?? 'unknown'}` };
  }

  const network = record['network'];
  if (network !== 'mainnet' && network !== 'stagenet' && network !== 'testnet') {
    return { ok: false, problem: 'The stored keys do not say which network they are for.' };
  }

  const birth = record['birth'];
  if (typeof birth !== 'number' || !Number.isFinite(birth) || birth < 0) {
    return { ok: false, problem: 'The stored keys have no usable creation time.' };
  }

  return { ok: true, record: { v: KEYVAULT_SCHEMA, xmrSeed, btcMnemonic, network, birth } };
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

  return { ok: true, record: { v: KEYVAULT_SCHEMA, xmrSeed, btcMnemonic, network, birth: when } };
}

/**
 * Open the Bitcoin half. The caller closes it.
 *
 * Returned rather than held, because a wallet object holds key material and
 * this module has no lifecycle to hang it off. Whoever opens one is the one
 * who knows when the signing is over.
 */
export function openBitcoin(record: HotRecord): BtcWallet {
  return openFromMnemonic(record.btcMnemonic);
}

/** Close the Bitcoin half. Named beside `openBitcoin` so the pair is visible. */
export function closeBitcoin(wallet: BtcWallet): void {
  closeWallet(wallet);
}

/** Open the Monero half. The caller wipes it. */
export function openMonero(record: HotRecord) {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = parseInt(record.xmrSeed.slice(i * 2, i * 2 + 2), 16);
  const wallet = walletFromSeed(seed, record.network);
  seed.fill(0);
  return wallet;
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
