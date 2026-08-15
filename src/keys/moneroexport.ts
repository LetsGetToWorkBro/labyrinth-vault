/**
 * The Monero key-image export blob: the file every other Monero wallet reads.
 *
 * ## What this is for
 *
 * A watch-only Monero wallet can see money arrive and cannot see it leave. Only
 * the spend key can compute a key image, and only a key image tells you an
 * output is gone. So the pairing between a cold signer and a watching wallet
 * has exactly one payload that makes the balance correct, and this is it.
 *
 * The vault already computes key images and hands them back on its own wire
 * (src/keys/keyimages.ts). This file is the same information in the shape Cake,
 * Feather and monero-cli already import, which is the difference between
 * pairing with our companion and pairing with the wallet somebody has.
 *
 * ## The format, from wallet2.cpp:13895
 *
 *     "Monero key image export\x03"     24 bytes, plaintext, never encrypted
 *     iv                                 8
 *     chacha20(plaintext, chachaKey, iv)
 *     signature                         64
 *
 * and the plaintext under that:
 *
 *     offset               4    little-endian uint32, index of the first
 *                               output this export covers
 *     spend public key    32
 *     view public key     32
 *     then per output:
 *       key image         32
 *       ring signature    64    over a ring of one, message = the key image
 *
 * Fixed-width concatenation throughout. No varints, no Boost, no length
 * prefixes, and no count either: the number of images is the remaining length
 * divided by 96, which is why a truncated blob has to be refused rather than
 * read as far as it goes.
 *
 * ## The three keys involved, which are easy to confuse
 *
 * - The **chacha key** is `cn_slow_hash(view secret key)`, CryptoNight, not a
 *   KDF anybody would design. It is the format. `chachaKeyFor` below is the
 *   seam it comes through, and vendor/cryptonight is the implementation.
 * - The **outer signature** is over `cn_fast_hash(iv || ciphertext)` and is
 *   made with the **view** secret key. It authenticates the blob.
 * - The **per-image signatures** are made with each output's **ephemeral**
 *   secret key and prove the exporter could have spent that output. They are
 *   what stops a watching wallet being fed somebody else's key images.
 *
 * ## What this file does not do
 *
 * It does not decide anything. It does not choose which outputs to export, it
 * does not draw randomness, and it does not know what a balance is. It takes
 * key images that were computed elsewhere and lays them out. Every refusal
 * here is about shape.
 */

import { chacha20orig } from '@noble/ciphers/chacha.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  checkSignature,
  generateRingSignatureOfOne,
  generateSignature,
  legacySignatureBytes,
  type LegacySignature,
} from './monerosign';

/**
 * `KEY_IMAGE_EXPORT_FILE_MAGIC`, wallet2.cpp:130, split into its two halves.
 *
 * Upstream writes it as one C string, `"Monero key image export\003"`, and the
 * trailing byte is a format version rather than part of the name. It is spelled
 * out here instead of hidden inside a literal: an unescaped 0x03 in source is
 * invisible in a diff, invisible in a review, and one careless editor pass from
 * disappearing without a single test noticing, because every test that uses the
 * constant would move with it.
 */
export const KEY_IMAGE_MAGIC = 'Monero key image export';
export const KEY_IMAGE_VERSION_BYTE = 0x03;

const MAGIC_BYTES = (() => {
  const out = new Uint8Array(KEY_IMAGE_MAGIC.length + 1);
  for (let i = 0; i < KEY_IMAGE_MAGIC.length; i++) out[i] = KEY_IMAGE_MAGIC.charCodeAt(i);
  out[KEY_IMAGE_MAGIC.length] = KEY_IMAGE_VERSION_BYTE;
  return out;
})();

/** What an importer skips before the IV: the name and the version byte. */
export const MAGIC_LENGTH = MAGIC_BYTES.length;

export const IV_BYTES = 8;
export const SIGNATURE_BYTES = 64;
export const KEY_IMAGE_BYTES = 32;
/** One record: the image and the signature that proves it was ours to make. */
export const RECORD_BYTES = KEY_IMAGE_BYTES + SIGNATURE_BYTES;
/** offset, spend public key, view public key. */
export const HEADER_BYTES = 4 + 32 + 32;

/**
 * A ceiling on how many outputs one blob may claim.
 *
 * The same number `MAX_OUTPUTS` in keyimages.ts uses, for the same reason: a
 * blob states its size by its length, so a hostile one cannot ask for an
 * allocation, but it can ask this to verify thousands of signatures. Refusing
 * early is cheaper than discovering it slowly.
 */
export const MAX_IMAGES = 2000;

// ---------------------------------------------------------------------------
// The CryptoNight seam
//
// `cn_slow_hash` is not in this bundle and cannot be. It is 2 MiB of
// pseudo-random reads with AES in the loop, it has four test vectors and no
// specification outside Monero's own source, and docs/native-primitives.md
// argues at length that a second implementation of it would be checked by
// nothing. It is vendored as C at vendor/cryptonight and reaches this file the
// same way Argon2id does: a function the host installs before the bundle is
// evaluated.
//
// The difference from Argon2id, and it matters: there is no JavaScript
// fallback here. Argon2id has one, so a missing native function costs speed.
// This has none, so a missing native function has to be a refusal. Producing a
// blob under a wrong key would make a file that looks right, imports cleanly
// into nothing, and tells its owner their balance is wrong.

export type NativeCnSlowHash = (data: Uint8Array) => Uint8Array;

let nativeCnSlowHash: NativeCnSlowHash | null = null;

/** Called once by the bridge when the host has installed the real thing. */
export function setNativeCnSlowHash(fn: NativeCnSlowHash | null): void {
  nativeCnSlowHash = fn;
}

export function nativeCnSlowHashInstalled(): boolean {
  return nativeCnSlowHash !== null;
}

/**
 * `crypto::generate_chacha_key(view secret, 32, key, kdf_rounds)`.
 *
 * @param rounds `m_kdf_rounds`, which is one in every wallet this will meet.
 *   Present because the field exists: a wallet opened with `--kdf-rounds`
 *   would otherwise be silently mis-decrypted rather than visibly wrong.
 */
export function chachaKeyFor(viewSecret: Uint8Array, rounds = 1): Uint8Array {
  if (viewSecret.length !== 32) throw new Error('A view secret key is 32 bytes.');
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10_000) {
    throw new Error(`Refusing ${rounds} key derivation rounds.`);
  }
  if (!nativeCnSlowHash) {
    throw new Error(
      'This build has no CryptoNight, so a Monero key-image export cannot be encrypted the way other wallets read it.',
    );
  }
  let digest = nativeCnSlowHash(viewSecret);
  if (digest.length !== 32) throw new Error('The native CryptoNight returned the wrong length.');
  for (let n = 1; n < rounds; n++) {
    digest = nativeCnSlowHash(digest);
    if (digest.length !== 32) throw new Error('The native CryptoNight returned the wrong length.');
  }
  return digest;
}

// ---------------------------------------------------------------------------
// Writing

export interface ExportOutput {
  /** The output's one-time public key, `P`. */
  oneTimeKey: Uint8Array;
  /** Its ephemeral secret, `x`, which only the spend key can produce. */
  oneTimeSecret: Uint8Array;
  /** `x·Hp(P)`, computed elsewhere and passed in rather than recomputed. */
  keyImage: Uint8Array;
}

export interface ExportRequest {
  viewSecret: Uint8Array;
  spendPublic: Uint8Array;
  /** Index of the first output covered, `ski.first` in wallet2. */
  offset: number;
  outputs: readonly ExportOutput[];
  /**
   * One nonce per output, plus one for the outer signature, in that order.
   *
   * Never drawn here. Same rule as `clsagSign`: Monero picks these at random,
   * so the only way a second implementation can be compared to the first is to
   * hand both the same values, and the only way randomness stays auditable is
   * to keep it in one place.
   */
  nonces: readonly Uint8Array[];
  /** `m_kdf_rounds`. One, in every wallet that exists in practice. */
  kdfRounds?: number;
  /** The 8-byte ChaCha IV. Monero draws it at random; the caller owns that. */
  iv: Uint8Array;
}

/** The plaintext of the blob, before it is encrypted. Exported to be tested. */
export function keyImagePlaintext(request: ExportRequest, viewPublic: Uint8Array): Uint8Array {
  const { offset, outputs, spendPublic } = request;
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffffffff) {
    throw new Error('The offset is a 32-bit unsigned integer.');
  }
  if (spendPublic.length !== 32) throw new Error('A spend public key is 32 bytes.');
  if (outputs.length > MAX_IMAGES) throw new Error(`Refusing to export more than ${MAX_IMAGES} key images.`);

  const out = new Uint8Array(HEADER_BYTES + outputs.length * RECORD_BYTES);
  /* Little-endian, written a byte at a time exactly as wallet2 does. A
   * DataView would be the same bytes; this way the code and the source it was
   * read from line up. */
  out[0] = offset & 0xff;
  out[1] = (offset >>> 8) & 0xff;
  out[2] = (offset >>> 16) & 0xff;
  out[3] = (offset >>> 24) & 0xff;
  out.set(spendPublic, 4);
  out.set(viewPublic, 36);

  let at = HEADER_BYTES;
  for (const [i, output] of outputs.entries()) {
    if (output.keyImage.length !== 32) throw new Error(`Key image ${i} is not 32 bytes.`);
    const nonce = request.nonces[i];
    if (!nonce) throw new Error(`Signing ${outputs.length} key images needs ${outputs.length + 1} nonces.`);
    const sig: LegacySignature = generateRingSignatureOfOne(
      output.keyImage,
      output.oneTimeKey,
      output.oneTimeSecret,
      nonce,
    );
    out.set(output.keyImage, at);
    out.set(legacySignatureBytes(sig), at + KEY_IMAGE_BYTES);
    at += RECORD_BYTES;
  }
  return out;
}

/**
 * The complete file, magic and all, ready to be written or animated.
 *
 * The magic stays outside the encryption. That is wallet2's choice and it is
 * the reason an importing wallet can tell what a file is before it has a key
 * to try, which is also why this cannot pretend to hide what it is.
 */
export function exportKeyImageBlob(request: ExportRequest): Uint8Array {
  const { viewSecret, outputs, nonces, iv } = request;
  if (viewSecret.length !== 32) throw new Error('A view secret key is 32 bytes.');
  if (iv.length !== IV_BYTES) throw new Error(`The IV is ${IV_BYTES} bytes.`);
  if (nonces.length !== outputs.length + 1) {
    throw new Error(`Exporting ${outputs.length} key images needs ${outputs.length + 1} nonces.`);
  }

  const viewPublic = ed25519.Point.BASE.multiply(scalar(viewSecret)).toBytes();
  const chachaKey = chachaKeyFor(viewSecret, request.kdfRounds ?? 1);

  const plaintext = keyImagePlaintext(request, viewPublic);
  const ciphertext = chacha20orig(chachaKey, iv, plaintext);

  /* iv || ciphertext, then the signature over the hash of exactly that. The
   * signature covers the IV as well as the body, so a flipped IV is caught. */
  const body = new Uint8Array(IV_BYTES + ciphertext.length);
  body.set(iv, 0);
  body.set(ciphertext, IV_BYTES);

  const outer = generateSignature(
    keccak_256(body),
    viewPublic,
    viewSecret,
    nonces[outputs.length]!,
  );

  const file = new Uint8Array(MAGIC_BYTES.length + body.length + SIGNATURE_BYTES);
  file.set(MAGIC_BYTES, 0);
  file.set(body, MAGIC_BYTES.length);
  file.set(legacySignatureBytes(outer), MAGIC_BYTES.length + body.length);
  return file;
}

const scalar = (bytes: Uint8Array): bigint => {
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n % L;
};

/** Why an envelope did not open. Kept apart because they mean different
 *  things to whoever is holding the file. */
export type EnvelopeRefusal =
  /** Too short, or not the shape of an envelope at all. */
  | 'malformed'
  /** The signature does not check against this vault's view public key. */
  | 'not-this-wallet'
  /** No CryptoNight, so the ChaCha20 key cannot be derived. */
  | 'no-cryptonight';

export interface EnvelopeResult {
  ok: boolean;
  plaintext?: Uint8Array;
  reason?: EnvelopeRefusal;
  /** A sentence a screen can show. Present whenever `ok` is false. */
  problem?: string;
}

/**
 * Undo `wallet2::encrypt_with_view_secret_key`, and check that it was written
 * by something holding this vault's view secret key.
 *
 * The same envelope wraps the key-image export and the unsigned transaction
 * set, which is why this is a function rather than two copies: an 8-byte IV, a
 * ChaCha20 body under the CryptoNight-derived key, and a 64-byte signature
 * over `cn_fast_hash(iv || ciphertext)`.
 *
 * ## The signature is checked now, and it was not before
 *
 * This function used to say the signature was "not verified", that checking it
 * needed `check_signature`, and that a verifier here would have "nothing to
 * check it against". Accurate when written; it stopped being accurate when
 * `oracle/` was committed. The harness signs with Monero's own
 * `crypto::generate_signature` and the fixtures carry the result, so
 * `checkSignature` in `monerosign.ts` is held to Monero's bytes and to every
 * single-byte mutation of them.
 *
 * What the check buys, stated exactly. ChaCha20 carries no authentication tag,
 * so decryption cannot fail: a wrong key yields the wrong plaintext rather
 * than an error, and every guard downstream was really a question about
 * whether the result looked plausible. A file not written under this view
 * secret is now rejected before it is decrypted at all.
 *
 * What it does **not** buy: any claim that the contents are true. The
 * signature says a wallet holding your view key wrote this. A watch-only
 * companion holds your view key, because that is what one is for, and a
 * compromised companion holds it too. What a `tx_construction_data` says about
 * where money goes is still that wallet's own account of itself.
 *
 * ## Order, which is deliberate
 *
 * Signature first, decryption second. Verifying needs no CryptoNight, so a
 * build without it can still tell somebody the file belongs to another wallet
 * instead of reporting the one failure it always has. It is also far the
 * cheaper of the two, and the only one of them that can reject.
 *
 * Never throws.
 */
export function openViewSecretEnvelope(
  body: Uint8Array,
  viewSecret: Uint8Array,
  kdfRounds = 1,
): EnvelopeResult {
  if (viewSecret.length !== 32 || body.length < IV_BYTES + SIGNATURE_BYTES) {
    return {
      ok: false,
      reason: 'malformed',
      problem: 'That is too short to be a Monero wallet file.',
    };
  }
  const signed = body.subarray(0, body.length - SIGNATURE_BYTES);
  const signature = body.subarray(body.length - SIGNATURE_BYTES);

  const viewPublic = ed25519.Point.BASE.multiply(scalar(viewSecret)).toBytes();
  if (!checkSignature(keccak_256(signed), viewPublic, signature)) {
    return {
      ok: false,
      reason: 'not-this-wallet',
      problem:
        'That file carries a signature, and it is not one this vault could have made. It ' +
        'belongs to a different wallet, or it was damaged on the way here.',
    };
  }

  const iv = signed.subarray(0, IV_BYTES);
  const ciphertext = signed.subarray(IV_BYTES);
  try {
    return {
      ok: true,
      plaintext: chacha20orig(chachaKeyFor(viewSecret, kdfRounds), iv, ciphertext),
    };
  } catch {
    return {
      ok: false,
      reason: 'no-cryptonight',
      problem:
        "That file is this wallet's, and this build cannot open it: the key to its contents " +
        'comes from CryptoNight, which did not load.',
    };
  }
}

// ---------------------------------------------------------------------------
// Reading

export interface ImportedKeyImages {
  offset: number;
  spendPublic: Uint8Array;
  viewPublic: Uint8Array;
  images: { keyImage: Uint8Array; signature: Uint8Array }[];
}

/**
 * Read a blob back, given the view secret key that made it.
 *
 * Returns null on anything malformed rather than throwing or partially
 * reading. This is the path a file or a camera reaches, so every branch that
 * could yield a plausible-but-wrong answer has to yield nothing instead.
 *
 * The outer signature **is** verified now, by `openViewSecretEnvelope`, which
 * is also where the argument for what that does and does not prove lives. The
 * plaintext check below is kept anyway rather than replaced: it is a different
 * question (does this decrypt to the right *shape*, under the key we think),
 * it costs one scalar multiplication, and two independent reasons to refuse a
 * blob is the right number for a file that decides what a balance says.
 */
export function readKeyImageBlob(file: Uint8Array, viewSecret: Uint8Array, kdfRounds = 1): ImportedKeyImages | null {
  if (viewSecret.length !== 32) return null;
  const least = MAGIC_BYTES.length + IV_BYTES + HEADER_BYTES + SIGNATURE_BYTES;
  if (file.length < least) return null;

  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (file[i] !== MAGIC_BYTES[i]) return null;
  }

  const ciphertext = file.subarray(MAGIC_BYTES.length + IV_BYTES, file.length - SIGNATURE_BYTES);
  if (ciphertext.length < HEADER_BYTES) return null;

  const bodyLength = ciphertext.length - HEADER_BYTES;
  if (bodyLength % RECORD_BYTES !== 0) return null;
  const count = bodyLength / RECORD_BYTES;
  if (count > MAX_IMAGES) return null;

  const opened = openViewSecretEnvelope(file.subarray(MAGIC_BYTES.length), viewSecret, kdfRounds);
  if (!opened.ok || !opened.plaintext) return null;
  const plaintext = opened.plaintext;

  const offset =
    plaintext[0]! | (plaintext[1]! << 8) | (plaintext[2]! << 16) | (plaintext[3]! * 0x1000000);
  const spendPublic = plaintext.slice(4, 36);
  const viewPublic = plaintext.slice(36, 68);

  /* The second, independent check that the key was right. A wrong key gives
   * random bytes here, and random bytes are not the view public key this
   * secret produces. */
  const expected = ed25519.Point.BASE.multiply(scalar(viewSecret)).toBytes();
  for (let i = 0; i < 32; i++) {
    if (viewPublic[i] !== expected[i]) return null;
  }

  const images: { keyImage: Uint8Array; signature: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    const at = HEADER_BYTES + i * RECORD_BYTES;
    images.push({
      keyImage: plaintext.slice(at, at + KEY_IMAGE_BYTES),
      signature: plaintext.slice(at + KEY_IMAGE_BYTES, at + RECORD_BYTES),
    });
  }
  return { offset, spendPublic, viewPublic, images };
}
