/**
 * The whole vault, as one object a native app can call.
 *
 * The screens are SwiftUI. The reader, the key handling and the wire are the
 * TypeScript in this repository, which is the part with the tests and the
 * cross-implementation vectors. Something has to join them, and the choice is
 * between porting the audited logic into Swift — two implementations of every
 * derivation, one of them untested — or running the tested one.
 *
 * So it runs. iOS ships JavaScriptCore in the operating system: a synchronous
 * interpreter with no network stack, no DOM, and no ability to reach anything
 * this file does not hand it. The app bundles the compiled JavaScript, loads
 * it into a `JSContext`, and calls the functions below. There is exactly one
 * implementation of what a transaction says, and it is the one under test.
 *
 * ## The rules this boundary is built on
 *
 * **Strings across, always.** Every argument and every return value is a
 * string, usually JSON. `bigint` does not survive a bridge, `Uint8Array`
 * arrives as something unpredictable, and a boundary that silently coerces is
 * a boundary that will one day coerce an amount. Hex in, JSON out, nothing
 * clever.
 *
 * **Nothing throws.** A signing device that crashes when handed a bad frame is
 * a device somebody can deny service to with a sticker. Every entry point
 * returns `{ok: false, problem}` instead, and the outermost wrapper catches
 * anything unforeseen so a JavaScript exception can never cross into Swift.
 *
 * **Secrets stay this side.** Keys are made here, used here and wiped here.
 * The bridge hands out addresses, descriptions and signatures. It has no
 * function that returns a private key, and the only one that returns a
 * recovery phrase is named for what it does and exists for the screen that
 * asks somebody to write it down.
 *
 * **The session is explicit.** `unlock` opens a wallet, `lock` wipes it. There
 * is no lazily-reopening accessor: if the app has locked and asks to sign, it
 * gets a refusal, because that is what locking is for.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { encodeParts, type PayloadKind } from '../airgap/envelope';
import { Scanner } from '../airgap/scanner';
import { bitcoinAccount, encodeAccount, moneroAccount } from '../keys/account';
import {
  checkBtcAddress,
  checkExtendedKey,
  checkMnemonic,
  closeWallet,
  mnemonicFromStoredEntropy,
  openFromMnemonic,
  type BtcWallet,
} from '../keys/bitcoin';
import {
  parseAddress,
  revealMnemonic,
  walletFromSeed,
  wipeWallet,
  type Wallet as MoneroWallet,
} from '../keys/monero';
import { MONERO_UNSUPPORTED, readContainer, readContainerText } from '../keys/monerotx';
import { describePsbt, signPsbt, type PsbtSummary } from '../keys/psbt';
import { calibrateKdf, looksSealed, seal, unseal, type KdfParams } from '../keys/seal';
import { wipe } from '../keys/wipe';
import { allChecksPass, selfTest } from '../selftest';
import { toWire } from './summary';

// ---------------------------------------------------------------------------
// Bytes and hex, the only two things that cross

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array | null {
  const clean = String(hex ?? '').trim();
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

interface Failure {
  ok: false;
  problem: string;
  /** A machine-readable name for the refusal, when there is one. */
  code?: string;
}

function fail(problem: string): string {
  return JSON.stringify({ ok: false, problem } satisfies Failure);
}

/**
 * A refusal the screen can recognise rather than only print.
 *
 * Most failures here are one-off sentences and stay that way. A few name a
 * condition the app has a dedicated screen for, and those carry a code, in the
 * same spirit as the fatal warning codes in psbt.ts: the words can be
 * rewritten, the code is the contract.
 */
function failCoded(code: string, problem: string): string {
  return JSON.stringify({ ok: false, code, problem } satisfies Failure);
}

/**
 * Is this one of Monero's own wallet files?
 *
 * Asked of the text and of the bytes it decodes to, because either could be
 * how it arrived. Returns the refusal to send back, or null when it is not a
 * Monero file and the caller should carry on.
 *
 * The vault refuses these, and the point of recognising them is that the
 * refusal is true: "this is a Monero unsigned transaction set and this build
 * cannot open it" sends somebody to the right place, and "that is not a
 * transaction" sends them to re-export a file that was never wrong.
 */
function moneroFileRefusal(text: string, bytes: Uint8Array | null): string | null {
  const found = readContainerText(text) ?? (bytes ? readContainer(bytes) : null);
  return found ? failCoded(MONERO_UNSUPPORTED, found.refusal) : null;
}

function done(payload: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...payload });
}

/**
 * The outermost net.
 *
 * Every exported function is wrapped in this, so an unforeseen exception
 * becomes a refusal the app can render rather than a crash inside
 * JavaScriptCore that takes the screen with it.
 */
function guarded<A extends unknown[]>(name: string, run: (...args: A) => string) {
  return (...args: A): string => {
    try {
      return run(...args);
    } catch (error) {
      return fail(`${name} failed: ${String((error as Error)?.message ?? error)}`);
    }
  };
}

// ---------------------------------------------------------------------------
// The secret, and the session it opens
//
// A vault holds two unrelated secrets, because Bitcoin and Monero have
// unrelated recovery formats and each phrase has to restore in its own
// ecosystem's own software. Deriving one from the other would produce a Monero
// wallet no other Monero wallet could restore, which fails the one requirement
// that matters: if this device is lost, the words on paper have to be enough,
// in software that is not ours.
//
// Sealed, the secret is 48 bytes: 16 of BIP39 entropy, then a 32-byte Monero
// seed. Binary rather than JSON so that unlocking does not materialise a
// recovery phrase as a string on every unlock; the phrases are derived only by
// `revealBackup`, for the screen that asks somebody to write them down.

const BTC_ENTROPY_BYTES = 16;
const XMR_SEED_BYTES = 32;
const SECRET_BYTES = BTC_ENTROPY_BYTES + XMR_SEED_BYTES;
/** salt + nonce, what `seal` requires. */
const SEAL_RANDOM_BYTES = 40;

interface Session {
  btc: BtcWallet;
  xmr: MoneroWallet;
  /** The BIP39 entropy, kept so the phrase can be shown without unsealing
   *  again. Wiped by `lock`. */
  btcEntropy: Uint8Array;
}

let session: Session | null = null;
const scanner = new Scanner();

function openSession(secret: Uint8Array): Session {
  const btcEntropy = secret.slice(0, BTC_ENTROPY_BYTES);
  const xmrSeed = secret.slice(BTC_ENTROPY_BYTES);
  // The phrase is transient: it exists for the length of this call, because
  // openFromMnemonic needs text. It is not stored on the session.
  const phrase = mnemonicFromStoredEntropy(btcEntropy);
  try {
    return { btc: openFromMnemonic(phrase), xmr: walletFromSeed(xmrSeed), btcEntropy };
  } finally {
    wipe(xmrSeed);
  }
}

/**
 * The two secrets, derived from one draw of randomness plus whatever the
 * person contributed.
 *
 * Domain-separated so the Bitcoin entropy and the Monero seed cannot be
 * derived from each other: learning one tells you nothing about the other,
 * which is the property that makes them genuinely two wallets rather than one
 * wearing two hats.
 *
 * Hashing means the contributed bytes can only add. Somebody rolling dice gets
 * real benefit; somebody supplying nothing gets the CSPRNG's bytes hashed,
 * which is still uniformly random. Nothing here needs to be reproducible by
 * other software — the *recovery* path is two standard phrases — so this is
 * generation, not a derivation anybody else has to implement.
 */
function deriveSecret(random: Uint8Array, extra: Uint8Array): Uint8Array {
  const material = new Uint8Array(1 + random.length + extra.length);
  material.set(random, 1);
  material.set(extra, 1 + random.length);

  material[0] = 0x01;
  const btcPart = sha256(material);
  material[0] = 0x02;
  const xmrPart = sha256(material);

  const secret = new Uint8Array(SECRET_BYTES);
  secret.set(btcPart.subarray(0, BTC_ENTROPY_BYTES), 0);
  secret.set(xmrPart, BTC_ENTROPY_BYTES);
  wipe(material, btcPart, xmrPart);
  return secret;
}

function requireSession(): Session {
  if (!session) throw new Error('The vault is locked.');
  return session;
}

// ---------------------------------------------------------------------------
// The API
//
// Everything below is what Swift can call. Adding to this list widens what the
// screen layer can do, so it is deliberately short, and
// `test/app-wiring.test.ts` checks that Swift calls nothing that is not here.

/** Which contract this bundle speaks, so a stale bundle is caught, not run. */
export const HOST_VERSION = 1;

export const api = {
  version: guarded('version', () => done({ version: HOST_VERSION })),

  /** The launch gate. Nothing else should be called until this passes. */
  selfTest: guarded('selfTest', () => {
    const checks = selfTest();
    return done({ passed: allChecksPass(checks), checks });
  }),

  /** Tune the key-stretching to this device. Milliseconds in, parameters out. */
  calibrate: guarded('calibrate', (targetMs: number) => {
    const params = calibrateKdf(Math.max(250, Number(targetMs) || 1000), () => Date.now());
    return done({ params });
  }),

  /**
   * Make a new vault secret and seal it. Returns only the sealed blob: the
   * caller stores ciphertext and never sees the secret.
   *
   * @param randomHex `SECRET_BYTES + SEAL_RANDOM_BYTES` from the platform CSPRNG.
   */
  create: guarded('create', (randomHex: string, passphrase: string, extraHex: string) => {
    const random = fromHex(randomHex);
    if (!random || random.length !== SECRET_BYTES + SEAL_RANDOM_BYTES) {
      return fail(`create needs ${SECRET_BYTES + SEAL_RANDOM_BYTES} bytes of randomness.`);
    }
    const extra = fromHex(extraHex ?? '') ?? new Uint8Array(0);
    const secret = deriveSecret(random.subarray(0, SECRET_BYTES), extra);
    const sealed = seal(secret, passphrase, random.subarray(SECRET_BYTES));
    wipe(secret);
    if (!sealed.ok) return fail(sealed.problem ?? 'Could not seal the vault.');
    return done({ sealed: toHex(sealed.sealed!) });
  }),

  /** Open the vault. Everything afterwards depends on this having succeeded. */
  unlock: guarded('unlock', (sealedHex: string, passphrase: string) => {
    const blob = fromHex(sealedHex);
    if (!blob || !looksSealed(blob)) return fail('That is not a sealed vault.');
    const opened = unseal(blob, passphrase);
    if (!opened.ok || !opened.secret) return fail(opened.problem ?? 'The vault did not open.');
    if (opened.secret.length !== SECRET_BYTES) {
      wipe(opened.secret);
      return fail('That vault does not contain what this version expects.');
    }
    lockInternal();
    session = openSession(opened.secret);
    wipe(opened.secret);
    return done({
      btcAccount: bitcoinAccount(session.btc),
      xmrAddress: session.xmr.address,
    });
  }),

  /** Wipe the keys. The public half goes too: locked means locked. */
  lock: guarded('lock', () => {
    lockInternal();
    return done({ locked: true });
  }),

  unlocked: guarded('unlocked', () => done({ unlocked: session !== null })),

  /** The watch-only export, as the frames to animate. */
  exportAccount: guarded('exportAccount', (chain: string) => {
    const open = requireSession();
    const account = chain === 'xmr' ? moneroAccount(open.xmr) : bitcoinAccount(open.btc);
    const frames = encodeParts('ACCOUNT' satisfies PayloadKind, encodeAccount(account));
    return done({ account, frames });
  }),

  /**
   * The recovery words, for the screen that asks somebody to write them down.
   *
   * Named to be conspicuous on both sides of the bridge. What it returns is
   * immutable and permanent for the life of the process.
   */
  revealBackup: guarded('revealBackup', () => {
    const open = requireSession();
    return done({
      bitcoin: mnemonicFromStoredEntropy(open.btcEntropy).split(' '),
      monero: revealMnemonic(open.xmr),
    });
  }),

  /** Offer a scanned QR frame. Returns progress, or the payload when complete. */
  scan: guarded('scan', (text: string) => {
    const value = String(text ?? '');
    /* Before the scanner, because it would answer "not a frame this device
     * recognises" and that is the unhelpful half-truth this check exists to
     * replace. */
    const monero = moneroFileRefusal(value, null);
    if (monero) return monero;
    const progress = scanner.offer(value);
    return done({
      format: progress.format,
      have: progress.have,
      total: progress.total,
      kind: progress.kind,
      problem: progress.problem ?? null,
      payload: progress.payload ? toHex(progress.payload) : null,
    });
  }),

  scanReset: guarded('scanReset', () => {
    scanner.reset();
    return done({ reset: true });
  }),

  /** Read a transaction, in the shape the confirmation screen renders. */
  describe: guarded('describe', (psbtHex: string) => {
    const open = requireSession();
    const psbt = fromHex(psbtHex);
    const monero = moneroFileRefusal(String(psbtHex ?? ''), psbt);
    if (monero) return monero;
    if (!psbt) return fail('That is not a transaction.');
    lastDescribed = describePsbt(psbt, open.btc);
    return done({ summary: toWire(lastDescribed) });
  }),

  /**
   * Sign, given the digest of the summary a person approved.
   *
   * Swift passes back the digest it displayed rather than a whole summary:
   * re-serialising the description through the bridge and back would be a
   * second chance for it to differ from what was read. The summary object
   * itself never leaves this side, so the one `signPsbt` checks is the one
   * `describe` produced.
   */
  sign: guarded('sign', (psbtHex: string, approvedDigest: string) => {
    const open = requireSession();
    const psbt = fromHex(psbtHex);
    if (!psbt) return fail('That is not a transaction.');
    if (!lastDescribed) return fail('Nothing has been described on this device to approve.');
    if (lastDescribed.digest !== String(approvedDigest)) {
      return fail('That approval does not match the transaction that was read. Nothing was signed.');
    }
    const result = signPsbt(psbt, open.btc, lastDescribed);
    if (!result.ok) return fail(result.problem ?? 'It was not signed.');
    return done({
      signed: result.signed,
      psbt: toHex(result.psbt!),
      hex: result.hex ?? null,
      txid: result.txid ?? null,
      frames: result.hex ? encodeParts('TXSIGNED' satisfies PayloadKind, fromHex(result.hex)!) : null,
    });
  }),

  /** Field validation, so the screen and the signer agree about what is valid. */
  checkAddress: guarded('checkAddress', (text: string, chain: string) => {
    if (chain === 'xmr') {
      const parsed = parseAddress(text);
      return done({
        state: parsed.valid ? 'ok' : 'bad',
        note: parsed.valid ? `valid ${parsed.network} ${parsed.kind} address` : parsed.problem,
      });
    }
    return done(checkBtcAddress(text) as unknown as Record<string, unknown>);
  }),

  checkPhrase: guarded('checkPhrase', (text: string) => done(checkMnemonic(text) as unknown as Record<string, unknown>)),

  checkExtendedKey: guarded('checkExtendedKey', (text: string) =>
    done(checkExtendedKey(text) as unknown as Record<string, unknown>),
  ),
};

/** The description the person is currently looking at. Never crosses. */
let lastDescribed: PsbtSummary | null = null;

function lockInternal(): void {
  if (session) {
    closeWallet(session.btc);
    wipeWallet(session.xmr);
    wipe(session.btcEntropy);
  }
  session = null;
  lastDescribed = null;
  scanner.reset();
}

/** For tests, which need a clean slate between cases. */
export function resetHost(): void {
  lockInternal();
}

export type HostApi = typeof api;

/**
 * Publish for JavaScriptCore.
 *
 * `globalThis` rather than a module export because JSC evaluates a script, it
 * does not import one. The Swift side reads this name and nothing else.
 */
(globalThis as unknown as { LabyrinthVault?: HostApi }).LabyrinthVault = api;

export const SEAL_PARAMS_DEFAULT: KdfParams | null = null;
