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
 * **Strings across, with one deliberate exception.** Every argument and every
 * return value is a string, usually JSON. `bigint` does not survive a bridge,
 * `Uint8Array` arrives as something unpredictable, and a boundary that
 * silently coerces is a boundary that will one day coerce an amount. Hex in,
 * JSON out, nothing clever.
 *
 * The exception is the passphrase, which crosses as an array of byte values,
 * because a JavaScript string cannot be overwritten and the passphrase is the
 * one secret a person types. See `passphraseFromWire` below for the whole
 * argument. A string in that position is refused rather than encoded, so the
 * exception cannot decay back into the rule.
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
import { keccak_256 } from '@noble/hashes/sha3.js';
import { encodeParts, type PayloadKind } from '../airgap/envelope';
import { Scanner } from '../airgap/scanner';
import { UR_PSBT, UR_PSBT_MODERN, UrEncoder } from '../airgap/ur';
import { bip84Account } from '../airgap/registry';
import { cborEncode } from '../airgap/cbor';
import { base43Frame } from '../airgap/base43';
import { setNativeCnSlowHash, nativeCnSlowHashInstalled } from '../keys/moneroexport';
import { bip84Descriptors } from '../keys/descriptor';
import { BBQR_TYPES, bbqrEncode } from '../airgap/bbqr';
import { bitcoinAccount, encodeAccount, moneroAccount } from '../keys/account';
import { computeKeyImages, encodeKeyImageReply, parseKeyImageRequest } from '../keys/keyimages';
import {
  encodeSignedTx,
  parseUnsignedSet,
  signMoneroSpend,
  signingRandomCount,
  type VaultUnsignedSet,
} from '../keys/monerobuild';
import {
  checkBtcAddress,
  checkExtendedKey,
  checkMnemonic,
  closeWallet,
  mnemonicFromStoredEntropy,
  openFromMnemonic,
  ZPUB_VERSIONS,
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
import { demoUnsignedPsbt, describePsbt, signPsbt, type PsbtSummary } from '../keys/psbt';
import {
  calibrateKdf,
  looksSealed,
  nativeArgon2idInstalled,
  seal,
  setNativeArgon2id,
  unseal,
  type KdfParams,
} from '../keys/seal';
import { wipe } from '../keys/wipe';
import { allChecksPass, selfTest } from '../selftest';
import { moneroToWire, toWire } from './summary';

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

/**
 * A passphrase, arriving as bytes rather than as text.
 *
 * This is the one argument on this bridge that is deliberately not a string,
 * and the exception is the point. Everything else here crosses as text because
 * text is the only thing a JavaScriptCore boundary carries predictably — but a
 * JavaScript string cannot be overwritten, so a passphrase that crossed as one
 * would exist, unwipeable, in Swift's heap and JSC's heap at the same time,
 * for as long as either collector felt like keeping it.
 *
 * So Swift sends an array of byte values. JSC turns that into an ordinary
 * JavaScript array of numbers, this function copies it into a `Uint8Array`,
 * and the caller wipes it. Nothing secret is ever a string on this side.
 *
 * A string is refused rather than accepted-and-encoded. Accepting one would
 * make the unwipeable path the convenient path, which is how the rule would
 * quietly stop being true.
 *
 * Returns null when the argument is not what the contract says, so the caller
 * refuses rather than sealing under something unintended.
 */
function passphraseFromWire(value: unknown): Uint8Array | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const byte = value[i];
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      wipe(out);
      return null;
    }
    out[i] = byte;
  }
  return out;
}

const PASSPHRASE_CONTRACT =
  'The passphrase must be sent as bytes, not as text. See passphraseToBytes in src/keys/seal.ts.';

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
 * A refusal the screen can recognize rather than only print.
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
 * The vault refuses these, and the point of recognizing them is that the
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

/**
 * Which contract this bundle speaks, so a stale bundle is caught, not run.
 *
 * 2: passphrases cross as bytes, not as text. An app built against 1 would
 * send a string, this side would refuse it, and every unlock would fail with a
 * message about the contract — which is the right failure, but the version
 * check catches it at launch instead of at the worst moment.
 *
 * 3: `moneroKeyImages` exists. An app built against 3 would call a function a
 * bundle built at 2 does not have, and the failure would be "undefined is not
 * a function" surfacing mid-flow on the key image screen; the version check
 * turns that into a sentence at launch.
 */
export const HOST_VERSION = 5;

export const api = {
  version: guarded('version', () =>
    done({
      version: HOST_VERSION,
      kdf: nativeArgon2idInstalled() ? 'native' : 'engine',
      /* Reported rather than assumed. Without CryptoNight the vault still
       * signs and still computes key images on its own wire; the one thing
       * it cannot do is write the export file other Monero wallets read, and
       * a screen that offers that button needs to know. */
      cryptonight: nativeCnSlowHashInstalled() ? 'native' : 'absent',
    })),

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
  create: guarded('create', (randomHex: string, passphrase: unknown, extraHex: string) => {
    const random = fromHex(randomHex);
    if (!random || random.length !== SECRET_BYTES + SEAL_RANDOM_BYTES) {
      return fail(`create needs ${SECRET_BYTES + SEAL_RANDOM_BYTES} bytes of randomness.`);
    }
    const pass = passphraseFromWire(passphrase);
    if (!pass) return fail(PASSPHRASE_CONTRACT);
    const extra = fromHex(extraHex ?? '') ?? new Uint8Array(0);
    const secret = deriveSecret(random.subarray(0, SECRET_BYTES), extra);
    try {
      const sealed = seal(secret, pass, random.subarray(SECRET_BYTES));
      if (!sealed.ok) return fail(sealed.problem ?? 'Could not seal the vault.');
      return done({ sealed: toHex(sealed.sealed!) });
    } finally {
      wipe(secret, pass);
    }
  }),

  /**
   * Re-seal an existing vault under a different passphrase.
   *
   * The one operation that needs a vault's secret without wanting a session,
   * and it exists for exactly one caller: the migration that moves a vault
   * sealed under a typed passphrase alone onto the two-layer scheme, where the
   * device's keychain secret participates too.
   *
   * It happens in here rather than in the app because the secret must not
   * cross the bridge to do it. Unsealing and re-sealing both occur inside this
   * function, the plaintext is wiped on every path, and what comes back is a
   * blob. Nothing about the session changes: a vault that was locked stays
   * locked, and one that was open stays open with the keys it already had.
   *
   * The result is proved to open before it is returned. That check costs one
   * extra derivation and buys the only thing worth having here — a caller that
   * is about to overwrite the one copy of somebody's vault gets a blob that
   * has already been shown to work, rather than one that merely came back
   * without an error.
   */
  reseal: guarded('reseal', (sealedHex: string, from: unknown, to: unknown, randomHex: string) => {
    const blob = fromHex(sealedHex);
    if (!blob || !looksSealed(blob)) return fail('That is not a sealed vault.');
    const random = fromHex(randomHex);
    if (!random || random.length !== SEAL_RANDOM_BYTES) {
      return fail(`Re-sealing needs ${SEAL_RANDOM_BYTES} bytes of randomness.`);
    }
    const oldPass = passphraseFromWire(from);
    const newPass = passphraseFromWire(to);
    if (!oldPass || !newPass) {
      wipe(oldPass ?? new Uint8Array(0), newPass ?? new Uint8Array(0));
      return fail(PASSPHRASE_CONTRACT);
    }

    let opened;
    try {
      opened = unseal(blob, oldPass);
    } finally {
      wipe(oldPass);
    }
    if (!opened.ok || !opened.secret) {
      wipe(newPass);
      return fail(opened.problem ?? 'The vault did not open.');
    }

    try {
      const sealed = seal(opened.secret, newPass, random);
      if (!sealed.ok || !sealed.sealed) {
        return fail(sealed.problem ?? 'Could not re-seal the vault.');
      }
      const proof = unseal(sealed.sealed, newPass);
      if (!proof.ok || !proof.secret) {
        return fail('The re-sealed vault did not open, so it was not returned.');
      }
      wipe(proof.secret);
      return done({ sealed: toHex(sealed.sealed) });
    } finally {
      wipe(opened.secret, newPass);
    }
  }),

  /** Open the vault. Everything afterwards depends on this having succeeded. */
  unlock: guarded('unlock', (sealedHex: string, passphrase: unknown) => {
    const blob = fromHex(sealedHex);
    if (!blob || !looksSealed(blob)) return fail('That is not a sealed vault.');
    const pass = passphraseFromWire(passphrase);
    if (!pass) return fail(PASSPHRASE_CONTRACT);
    let opened;
    try {
      opened = unseal(blob, pass);
    } finally {
      wipe(pass);
    }
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

    /* ## The other way to be paired with
     *
     * `frames` is this project's own wire. `urFrames` is `ur:crypto-account`,
     * which is what Sparrow, Keystone, Passport and BlueWallet scan to set up
     * a watch-only wallet. Without it, pairing with anything but the Labyrinth
     * wallet meant reading a zpub off the glass and typing it.
     *
     * Electrum is not on that list, and used to be. It reads no BC-UR at all,
     * so pairing it is still the zpub off the glass — which the export screen
     * does show, under SHOW KEY AS TEXT, and which is not a workaround but the
     * documented way to make an Electrum watch-only wallet. Naming Electrum
     * next to a QR it cannot scan was the actual defect.
     *
     * Bitcoin only, and that is not a gap to be filled later: `crypto-account`
     * describes Bitcoin output descriptors, and Monero has no equivalent in
     * the registry. A Monero export stays on this project's own wire because
     * there is nothing standard to speak.
     *
     * Absent for a watch-only wallet, which has no master to fingerprint. The
     * vault always has the full one; this is the honest shape rather than a
     * zero somebody would later mistake for a real fingerprint. */
    let urFrames: string[] | null = null;
    const btc = open.btc;
    if (chain !== 'xmr' && btc.masterFingerprint !== undefined
        && btc.account.publicKey && btc.account.chainCode) {
      const payload = bip84Account({
        masterFingerprint: btc.masterFingerprint,
        keyData: btc.account.publicKey,
        chainCode: btc.account.chainCode,
        parentFingerprint: btc.account.parentFingerprint,
      });
      urFrames = new UrEncoder('crypto-account', payload).firstPass();
    }

    /* ## The third way to be paired with, and the one that needs no scanner
     *
     * A zpub says which keys and nothing else: not the script type, not the
     * derivation path, not which seed it belongs to. A watch-only wallet has
     * to guess all three, and a wrong guess is a wallet full of addresses
     * nobody can spend from.
     *
     * An output descriptor states all of it in one line, and Sparrow, Nunchuk,
     * BlueWallet, Bitcoin Core and Electrum all import it. It is also the only
     * one of the three pairing forms that works by being read aloud, typed or
     * photographed as a plain QR, which matters for Electrum: it has no BC-UR
     * of any kind, so a descriptor and the zpub are its whole surface.
     *
     * Null for a watch-only vault, which has no master to fingerprint. See
     * bip84Descriptors for why an origin-less descriptor is worse than none. */
    const descriptors =
      chain === 'xmr'
        ? null
        : bip84Descriptors(btc.zpub, ZPUB_VERSIONS, btc.masterFingerprint);

    return done({ account, frames, urFrames, descriptors });
  }),

  /**
   * A deterministic demo vault and a real transaction for it, as the frames a
   * Simulator scans itself. There is no camera in the Simulator, so the whole
   * confirmation flow would have nothing to render; this gives it something
   * genuine. The randomness is fixed, so it is the same vault and the same
   * transaction every run, and it is opened into the session exactly as
   * `unlock` opens a real one, so `describe` and `sign` then behave with no
   * special case. The transaction is unbroadcastable by construction (see
   * `demoUnsignedPsbt`); nothing here can move a coin.
   */
  demoUnsigned: guarded('demoUnsigned', () => {
    const random = new Uint8Array(88);
    for (let i = 0; i < random.length; i++) random[i] = (i * 7 + 11) & 0xff;
    const secret = deriveSecret(random, new Uint8Array(0));
    /* Close whatever was open before taking its place, exactly as `unlock`
     * does. Assigning over `session` would drop a real wallet's private keys
     * without zeroing them — the one thing every other path in this file is
     * careful about — and would leave that session's `lastDescribed` standing
     * behind the demo's keys. Nothing could be signed across the two (the
     * approval carries a walletId and `signPsbt` checks it), but the secrets
     * would still have been abandoned rather than wiped, and "the demo button
     * is the one place we skip the wipe" is not a sentence worth having. */
    lockInternal();
    session = openSession(secret);
    wipe(secret, random);
    const frames = encodeParts('PSBT' satisfies PayloadKind, demoUnsignedPsbt(session.btc));
    return done({ frames });
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
     * recognizes" and that is the unhelpful half-truth this check exists to
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
   * re-serializing the description through the bridge and back would be a
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
    /* ## Four ways home, because the far side is not always ours
     *
     * There is no single QR format for Bitcoin signers. There are three, they
     * do not overlap, and a wallet that reads one usually reads no other. That
     * was established by reading the wallets rather than their documentation,
     * and two of the three were missing here while the app named them on a
     * button.
     *
     * `frames` is this project's own wire and carries the finished
     * transaction, which is what the Labyrinth wallet broadcasts.
     *
     * `urFrames` is `ur:crypto-psbt`, which is what Sparrow, Keystone,
     * Passport and BlueWallet read. Until this existed the vault could
     * *accept* a PSBT from any of them and had no way to hand one back: the
     * encoder in src/airgap/ur.ts was written, tested against the BC-UR
     * vectors, and called by nothing. A round trip with anybody else's wallet
     * was import-only, and would have failed at the last step of the first
     * real test.
     *
     * `electrumFrames` is base43 in one static QR. Electrum reads no BC-UR of
     * any kind — no `crypto-psbt`, no fountain decoder, nothing — and has no
     * animated format at all, so this is null when the PSBT will not fit a
     * single code and the screen has to say so rather than show one nothing
     * can scan. src/airgap/base43.ts.
     *
     * `bbqrFrames` is BBQr, which is what Coldcard animates. Coldcard reads no
     * BC-UR either. Sparrow, Nunchuk and BlueWallet decode BBQr as well, so of
     * the three this one reaches furthest; it is not offered first only
     * because those wallets document UR as the way in. src/airgap/bbqr.ts.
     *
     * It carries `result.psbt`, never `result.hex`. A PSBT is what the type
     * means, and it is also the only one of the two that always exists:
     * finalizing is attempted rather than required, so a transaction with
     * another party's inputs still needs signatures after ours. The old code
     * emitted no frames at all in that case, which made a legitimate
     * part-signed result look like a failure.
     *
     * The CBOR wrapper is part of the type. Leaving it off produces frames
     * that look right and that Sparrow will not read. */
    return done({
      signed: result.signed,
      psbt: toHex(result.psbt!),
      hex: result.hex ?? null,
      txid: result.txid ?? null,
      frames: result.hex ? encodeParts('TXSIGNED' satisfies PayloadKind, fromHex(result.hex)!) : null,
      urFrames: new UrEncoder(UR_PSBT, cborEncode(result.psbt!)).firstPass(),
      /* The same bytes under the registry's newer name.
       *
       * BC-UR renamed its types in 2023, dropping the `crypto-` prefix, and
       * wallets did not move together. Sparrow subscribes to `crypto-psbt`;
       * Cake matches on `ur:psbt/` and nothing else, which was read out of
       * cw_bitcoin/lib/bitcoin_wallet.dart rather than guessed.
       *
       * So both go out. The payload is byte-identical and the label is the
       * whole of the difference, which makes emitting one and not the other a
       * needless way to be incompatible with half the ecosystem. */
      urPsbtFrames: new UrEncoder(UR_PSBT_MODERN, cborEncode(result.psbt!)).firstPass(),
      electrumFrames: base43Frame(result.psbt!),
      bbqrFrames: bbqrEncode(result.psbt!, BBQR_TYPES.psbt),
    });
  }),

  /**
   * Key images for outputs the companion found, as frames to animate back.
   *
   * The one function on this bridge that touches the spend secret outside of
   * signing, and it is shaped the same way: parse and refuse first, then
   * derive, then wipe. Ownership of every output is re-proved from this
   * device's own keys before anything is computed; the reasoning lives with
   * the arithmetic in `keys/keyimages.ts`.
   *
   * The reply says how many were answered and how many refused, so the screen
   * can put a number in front of the person whose money this is about.
   */
  moneroKeyImages: guarded('moneroKeyImages', (payloadHex: string) => {
    const open = requireSession();
    const payload = fromHex(payloadHex);
    if (!payload) return fail('That is not a key image request.');
    const parsed = parseKeyImageRequest(payload);
    if (!parsed.ok) return fail(parsed.problem);
    const reply = computeKeyImages(open.xmr, parsed.request);
    return done({
      answered: reply.images.length,
      refused: reply.refused.length,
      frames: encodeParts('XMRKEYIMAGES' satisfies PayloadKind, encodeKeyImageReply(reply)),
    });
  }),

  /**
   * Read an unsigned Monero set, in the shape the confirmation screen renders.
   *
   * Same two-step contract as the Bitcoin pair: this parses and remembers,
   * `moneroSign` acts only on the digest of what was remembered. The digest is
   * over the payload bytes, so the set a person approves is byte-identical to
   * the set that gets signed, not merely equal-looking.
   */
  moneroDescribe: guarded('moneroDescribe', (payloadHex: string) => {
    const open = requireSession();
    const payload = fromHex(payloadHex);
    if (!payload || payload.length === 0) return fail('That is not an unsigned Monero transaction set.');
    const parsed = parseUnsignedSet(payload);
    if (!parsed.ok) return fail(parsed.problem);
    /* The change-swap defense, Monero edition. `change: true` in the set is a
     * claim, and the signer downstream uses it only for address-math
     * classification — nothing checks it against anything. So it is checked
     * here, against this vault's own address, before a screen ever renders
     * the words "returning to you": a set whose claimed change pays anywhere
     * else has been caught lying, and nothing else it says can be trusted.
     * Same reasoning, same refusal code, as the PSBT reader's. */
    for (const output of parsed.set.outputs) {
      if (output.change && output.address !== open.xmr.address) {
        return failCoded(
          'output-path-mismatch',
          "An output claims to be this wallet's change but pays a different address. Signing refused.",
        );
      }
    }
    const digest = toHex(keccak_256(payload));
    lastMoneroDescribed = { digest, set: parsed.set };
    /* The shape lives in summary.ts beside the Bitcoin one, mirrored field
     * for field by MoneroSummary.swift, with the amounts formatted here — in
     * the one place per chain that knows what a piconero is worth — and the
     * randomness requirement stated by the side that owns the formula. */
    return done({ ...moneroToWire(parsed.set, digest) });
  }),

  /**
   * Sign the described Monero set, given the approved digest and fresh
   * platform entropy.
   *
   * `randomHex` is `signingRandomCount(...) * 32` bytes from the platform
   * CSPRNG in one draw, the same convention as `create`. Every re-derivation,
   * the curve balance, the range proof, and each ring signature are checked
   * inside `signMoneroSpend` before any bytes come back; what returns is the
   * broadcastable transaction as XMRSIGNED frames, plus the id and the key
   * images for the record.
   */
  moneroSign: guarded('moneroSign', (approvedDigest: string, randomHex: string) => {
    const open = requireSession();
    if (!lastMoneroDescribed) return fail('Nothing has been described on this device to approve.');
    if (lastMoneroDescribed.digest !== String(approvedDigest)) {
      return fail('That approval does not match the set that was read. Nothing was signed.');
    }
    const set = lastMoneroDescribed.set;
    const need = signingRandomCount(set.inputs.length, set.ringSize, set.outputs.length);
    const random = fromHex(randomHex);
    if (!random || random.length !== need * 32) {
      return fail(`Signing this set needs exactly ${need * 32} bytes of randomness.`);
    }
    const scalars = Array.from({ length: need }, (_, i) => random.subarray(i * 32, (i + 1) * 32));
    const result = signMoneroSpend(open.xmr, set, scalars);
    if (!result.ok) return fail(result.problem);
    /* One approval buys one signature. */
    lastMoneroDescribed = null;
    return done({
      txid: result.tx.txid,
      network: result.tx.network,
      fee: result.tx.fee,
      keyImages: result.tx.keyImages,
      outputs: result.tx.outputs,
      frames: encodeParts('XMRSIGNED' satisfies PayloadKind, encodeSignedTx(result.tx)),
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

/** The Monero set the person is currently looking at. Never crosses. */
let lastMoneroDescribed: { digest: string; set: VaultUnsignedSet } | null = null;

function lockInternal(): void {
  if (session) {
    closeWallet(session.btc);
    wipeWallet(session.xmr);
    wipe(session.btcEntropy);
  }
  session = null;
  lastDescribed = null;
  lastMoneroDescribed = null;
  scanner.reset();
}

/** For tests, which need a clean slate between cases. */
export function resetHost(): void {
  lockInternal();
  setNativeArgon2id(null);
  setNativeCnSlowHash(null);
  adoptNativeArgon2id();
  adoptNativeCnSlowHash();
}

/**
 * Take the host's Argon2id, if it left one on the global.
 *
 * The name is the whole of the contract between the two languages here, and
 * it is read once at boot rather than looked up per derivation, so that a
 * global appearing later cannot change how an already-running session derives
 * keys.
 *
 * Everything about the shape of what comes back is checked in `seal.ts` at the
 * point of use: a key of the wrong length is discarded and the JavaScript runs
 * instead. This function's only job is to notice the thing exists.
 */
function adoptNativeArgon2id(): void {
  const host = (globalThis as unknown as { __labyrinthArgon2id?: unknown }).__labyrinthArgon2id;
  if (typeof host !== 'function') return;
  const call = host as (
    passphrase: number[],
    salt: number[],
    t: number,
    m: number,
    p: number,
    dkLen: number,
  ) => number[] | null | undefined;

  setNativeArgon2id((passphrase, salt, params, dkLen) => {
    /* Arrays of numbers rather than typed arrays or hex, because that is what
     * survives the JavaScriptCore boundary in both directions without a
     * conversion either side could get wrong — and because a hex string would
     * put the passphrase back in an immutable JS string, which is the exact
     * thing Passphrase.swift and `passphraseFromWire` exist to prevent. */
    const answer = call(
      Array.from(passphrase),
      Array.from(salt),
      params.t,
      params.m,
      params.p,
      dkLen,
    );
    return Array.isArray(answer) ? Uint8Array.from(answer) : null;
  });
}

/**
 * Take the host's CryptoNight, if it left one on the global.
 *
 * Same seam as `adoptNativeArgon2id` and the same reasoning about reading it
 * once at boot, with one difference that changes the consequences: Argon2id
 * has a JavaScript implementation behind it, so a missing native function
 * costs time. This has none. `chachaKeyFor` refuses outright when nothing was
 * installed, because the alternative is a key-image export encrypted under
 * something that is not the key Monero would have used — a file that looks
 * right, imports into no wallet, and reports a wrong balance to whoever
 * trusted it.
 */
function adoptNativeCnSlowHash(): void {
  const host = (globalThis as unknown as { __labyrinthCnSlowHash?: unknown }).__labyrinthCnSlowHash;
  if (typeof host !== 'function') return;
  const call = host as (data: number[]) => number[] | null | undefined;

  setNativeCnSlowHash((data) => {
    /* Arrays of numbers, for the same reason the KDF uses them: it is what
     * crosses the JavaScriptCore boundary without a conversion either side
     * could get wrong. */
    const answer = call(Array.from(data));
    if (!answer || answer.length !== 32) {
      throw new Error('The native CryptoNight did not answer.');
    }
    return Uint8Array.from(answer);
  });
}

/* Boot. Both seams are read here, once, before anything can call in.
 *
 * `resetHost` above re-runs the same pair for tests. Two call sites is one
 * more than ideal and the reason they both exist is that a test needs a clean
 * slate between cases; the cost is that adding a third seam means remembering
 * both, which is what test/bundle.test.ts now checks by asking a freshly
 * loaded bundle whether it adopted anything. */
adoptNativeArgon2id();
adoptNativeCnSlowHash();

export type HostApi = typeof api;

/**
 * Publish for JavaScriptCore.
 *
 * `globalThis` rather than a module export because JSC evaluates a script, it
 * does not import one. The Swift side reads this name and nothing else.
 */
(globalThis as unknown as { LabyrinthVault?: HostApi }).LabyrinthVault = api;

export const SEAL_PARAMS_DEFAULT: KdfParams | null = null;
