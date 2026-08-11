/**
 * The sealed vault: what a secret looks like at rest.
 *
 * The design rule says nothing at rest is unencrypted. On iOS the seed will
 * live in the Keychain behind the Secure Enclave, and that is good and not
 * enough on its own: keychains have been dumped from jailbroken and confiscated
 * phones, backups leak, and "the platform handles it" is exactly the sentence
 * this project exists to avoid. So the seed is sealed with a passphrase
 * *before* it touches any store, and the store only ever sees ciphertext.
 *
 * The construction is deliberately boring, because at-rest encryption is a
 * solved problem and novelty here is a defect:
 *
 *   passphrase --Argon2id--> key --XChaCha20-Poly1305--> sealed blob
 *
 * **Argon2id** (RFC 9106) because passphrases are guessable and the defense is
 * making each guess expensive in *memory*, which is the one resource a GPU
 * farm cannot fake cheaply. Parameters are stored in the header and default to
 * RFC 9106's second recommendation, 64 MiB with t=3. Both primitives here are
 * checked in the tests against implementations that share no code with ours:
 * Argon2id against the reference C implementation, the AEAD against libsodium.
 *
 * That default is not cheap in JavaScript, and this file used to claim it was.
 * Measured: `npm run bench:kdf` on a modern server CPU with a JIT takes about
 * 1.5 seconds for one derivation. JavaScriptCore inside an iOS app has no JIT
 * — the entitlement is Apple's, not ours — so on the decade-old phone this is
 * for, expect substantially worse. See docs/native-primitives.md, which is
 * about what to do with that number rather than about hiding it.
 *
 * The important half is that it is a *latency* problem and not a strength
 * problem: `calibrateKdf` starts at this default and only ever walks upward,
 * so a slow device gets a slow unlock, never a weaker vault.
 *
 * **XChaCha20-Poly1305** because its 24-byte nonce is big enough to draw at
 * random without birthday arithmetic, and because it is authenticated: a
 * sealed blob that has been tampered with does not decrypt into garbage, it
 * refuses to decrypt at all.
 *
 * **The whole header is authenticated** as associated data. The KDF
 * parameters, the version, the salt and the nonce are covered by the same tag
 * as the ciphertext, so a file whose header has been edited — say, to weaken
 * the KDF — fails the tag check rather than being obeyed.
 *
 * Two consequences of the AEAD that are features, stated so nobody "fixes"
 * them:
 *
 *   - A wrong passphrase and a corrupted file are indistinguishable on
 *     purpose. Both fail the tag. Telling an attacker which of the two they
 *     have is a gift with no matching benefit to the owner.
 *   - There is no recovery path. The passphrase or nothing; that is what the
 *     seed phrase written on paper is for.
 *
 * What this does not defend: a compromised vault device that captures the
 * passphrase as it is typed. Nothing at rest can; that is the airgap's job.
 *
 * ## The passphrase is bytes, not a string
 *
 * Everything else in this project that holds a secret holds a `Uint8Array`,
 * because a JavaScript string cannot be overwritten. The passphrase used to be
 * the exception, and it is the worst possible thing to make an exception of:
 * it is the one secret a person types, the one that opens everything else, and
 * it was living as an immutable string in two heaps at once — Swift's and
 * JavaScriptCore's — with no way to zero either.
 *
 * So these functions take bytes. `passphraseToBytes` is the one place a string
 * becomes them, it is named for what it does, and what it returns is the
 * caller's to wipe.
 *
 * The NFKD normalisation that used to be hidden inside `deriveKey` lives there
 * too, in the open, because it is a cross-language contract now: the app does
 * the same normalisation in Swift before it sends bytes across the bridge, and
 * `test/fixtures/primitives.json` pins the exact bytes for the inputs where
 * two implementations could plausibly disagree. Getting that wrong does not
 * fail loudly — it produces a vault that opens on the phone that sealed it and
 * nowhere else.
 */

import { argon2id } from '@noble/hashes/argon2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { wipe } from './wipe';

/** Bumped only if the layout changes in a way an old reader would misread. */
export const SEAL_VERSION = 1;

/** "LVS" + version. A sealed blob is recognisable without being readable. */
const MAGIC = [0x4c, 0x56, 0x53];

const SALT_BYTES = 16;
const NONCE_BYTES = 24;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const HEADER_BYTES = 4 + 1 + 4 + 1 + SALT_BYTES + NONCE_BYTES; // magic+ver, t, m, p, salt, nonce

export interface KdfParams {
  /** Passes over the memory. */
  t: number;
  /** Memory in KiB. 65536 is 64 MiB. */
  m: number;
  /** Lanes. Kept at 1: JavaScript runs them sequentially, so raising it costs
   *  the owner time without costing an attacker anything. */
  p: number;
}

/**
 * RFC 9106's second recommendation. Slow is the feature: the person unseals a
 * few times a day, the attacker wants to try millions. What it costs on this
 * engine is measured rather than asserted — see the header comment and
 * `scripts/bench-kdf.mjs`.
 */
export const DEFAULT_KDF: KdfParams = { t: 3, m: 65536, p: 1 };

/**
 * Floors and ceilings on what this build will run.
 *
 * The floors are for our own callers: the header is authenticated, so a forged
 * weak header cannot pass the tag, but a buggy caller could genuinely seal
 * with t=1, m=64 and produce a vault that brute-forces over a weekend. Refuse.
 *
 * The ceilings are for hostile files. Argon2id allocates what the header asks
 * for *before* any authentication can happen, so a scanned blob claiming 4 GiB
 * would be a denial-of-service on the phone that merely tried to open it.
 */
export const KDF_LIMITS = {
  minT: 1,
  maxT: 64,
  minM: 8192, // 8 MiB
  maxM: 524288, // 512 MiB
  minP: 1,
  maxP: 4,
};

function paramsAcceptable(params: KdfParams): boolean {
  return (
    Number.isInteger(params.t) &&
    Number.isInteger(params.m) &&
    Number.isInteger(params.p) &&
    params.t >= KDF_LIMITS.minT &&
    params.t <= KDF_LIMITS.maxT &&
    params.m >= KDF_LIMITS.minM &&
    params.m <= KDF_LIMITS.maxM &&
    params.p >= KDF_LIMITS.minP &&
    params.p <= KDF_LIMITS.maxP
  );
}

/**
 * The one place a typed passphrase becomes bytes.
 *
 * NFKD, the same normalisation BIP39 applies to its passphrases, so a
 * passphrase that seals on this phone opens on any other device regardless of
 * how its keyboard composed the characters. Then UTF-8.
 *
 * Two things about calling this. The string that goes in cannot be wiped —
 * that is the property being worked around, not solved — so the useful move is
 * to call it as close to the keyboard as possible and pass bytes from there
 * on. And the bytes that come out are the caller's to wipe: this function does
 * not know when they have finished being useful.
 *
 * Exported rather than private because it is a contract the Swift side has to
 * match, and a contract nobody can name is a contract nobody can check.
 */
export function passphraseToBytes(passphrase: string): Uint8Array {
  return new TextEncoder().encode(String(passphrase ?? '').normalize('NFKD'));
}

function deriveKey(passphrase: Uint8Array, salt: Uint8Array, params: KdfParams): Uint8Array {
  return argon2id(passphrase, salt, { t: params.t, m: params.m, p: params.p, dkLen: KEY_BYTES });
}

export interface SealResult {
  ok: boolean;
  problem?: string;
  sealed?: Uint8Array;
}

/**
 * Seal a secret under a passphrase.
 *
 * @param random Exactly SALT+NONCE bytes of fresh randomness from the
 *   platform's CSPRNG. An argument, not an ambient reach for a global, for the
 *   same reason as everywhere else in this project: where the randomness came
 *   from should be answerable at the call site. Nonces must never repeat under
 *   the same key; drawing both salt and nonce fresh per seal makes the key
 *   itself fresh per seal, which retires the question.
 */
export function seal(
  secret: Uint8Array,
  passphrase: Uint8Array,
  random: Uint8Array,
  params: KdfParams = DEFAULT_KDF,
): SealResult {
  if (secret.length === 0) return { ok: false, problem: 'There is nothing to seal.' };
  if (passphrase.length === 0) {
    /* An empty passphrase seals, technically, and protects against nothing. A
     * caller that wants device-only protection should generate a random
     * passphrase and keep it in the platform keystore, which makes the
     * decision explicit instead of an empty string nobody meant. */
    return { ok: false, problem: 'A vault needs a passphrase. For device-only protection, generate a random one and keep it in the keystore.' };
  }
  if (random.length !== SALT_BYTES + NONCE_BYTES) {
    return { ok: false, problem: `Sealing needs exactly ${SALT_BYTES + NONCE_BYTES} fresh random bytes.` };
  }
  if (!paramsAcceptable(params)) {
    return { ok: false, problem: 'Those KDF parameters are outside what this build will run.' };
  }

  const header = new Uint8Array(HEADER_BYTES);
  header[0] = MAGIC[0]!;
  header[1] = MAGIC[1]!;
  header[2] = MAGIC[2]!;
  header[3] = SEAL_VERSION;
  header[4] = params.t;
  new DataView(header.buffer).setUint32(5, params.m, false);
  header[9] = params.p;
  header.set(random.subarray(0, SALT_BYTES), 10);
  header.set(random.subarray(SALT_BYTES), 10 + SALT_BYTES);

  const salt = header.subarray(10, 10 + SALT_BYTES);
  const nonce = header.subarray(10 + SALT_BYTES);

  const key = deriveKey(passphrase, salt, params);
  try {
    const ciphertext = xchacha20poly1305(key, nonce, header).encrypt(secret);
    const sealed = new Uint8Array(header.length + ciphertext.length);
    sealed.set(header, 0);
    sealed.set(ciphertext, header.length);
    return { ok: true, sealed };
  } finally {
    wipe(key);
  }
}

export interface UnsealResult {
  ok: boolean;
  problem?: string;
  /** The secret. The caller owns it now, and should wipe it when done. */
  secret?: Uint8Array;
  /** The parameters the blob was sealed under, for "re-seal stronger" flows. */
  params?: KdfParams;
}

/** True if these bytes even claim to be a sealed vault, for file pickers. */
export function looksSealed(blob: Uint8Array): boolean {
  return (
    blob.length >= HEADER_BYTES + TAG_BYTES &&
    blob[0] === MAGIC[0] &&
    blob[1] === MAGIC[1] &&
    blob[2] === MAGIC[2]
  );
}

/**
 * Open a sealed blob.
 *
 * One failure message for wrong passphrase and damaged file, by design; see
 * the header comment. The KDF ceilings are enforced *before* deriving, because
 * the allocation happens before the authentication possibly can.
 */
export function unseal(blob: Uint8Array, passphrase: Uint8Array): UnsealResult {
  if (!looksSealed(blob)) return { ok: false, problem: 'That is not a sealed vault.' };
  if (blob[3] !== SEAL_VERSION) {
    return { ok: false, problem: 'That vault was sealed by a newer version of this app.' };
  }

  const params: KdfParams = {
    t: blob[4]!,
    m: new DataView(blob.buffer, blob.byteOffset).getUint32(5, false),
    p: blob[9]!,
  };
  if (!paramsAcceptable(params)) {
    // Hostile or corrupt either way; refusing beats attempting a 4 GiB alloc.
    return { ok: false, problem: 'That vault asks for KDF parameters this build will not run.' };
  }

  const header = blob.subarray(0, HEADER_BYTES);
  const salt = blob.subarray(10, 10 + SALT_BYTES);
  const nonce = blob.subarray(10 + SALT_BYTES, HEADER_BYTES);
  const ciphertext = blob.subarray(HEADER_BYTES);

  const key = deriveKey(passphrase, salt, params);
  try {
    const secret = xchacha20poly1305(key, nonce, header).decrypt(ciphertext);
    return { ok: true, secret, params };
  } catch {
    return {
      ok: false,
      problem: 'That passphrase does not open this vault, or the file is damaged. The two cannot be told apart, on purpose.',
    };
  } finally {
    wipe(key);
  }
}

/**
 * Find KDF parameters that cost about `targetMs` on *this* device.
 *
 * Run once at setup, on the phone itself, because a constant tuned on a
 * laptop is either weak on the laptop or unusable on the phone. Walks memory
 * upward at t=3 until the target is met or the ceiling is hit. The timer is
 * an argument so tests can supply a fake one instead of waiting.
 *
 * **Calibration can only ever strengthen.** The walk starts at the default
 * rather than at the floor, so a device too slow to reach the target still
 * gets the default parameters and simply takes longer to unlock. Starting at
 * the floor would have meant that on a slow phone — exactly the phone this
 * app is for — calling the tuning function produced a *weaker* vault than not
 * calling it, which is the wrong way round for a function whose whole purpose
 * is to make the vault harder to open. Comfort is not worth eight times less
 * memory in front of an attacker who has the file.
 */
export function calibrateKdf(
  targetMs: number,
  timer: () => number,
  runner: (params: KdfParams) => void = (params) => {
    wipe(deriveKey(passphraseToBytes('calibration passphrase'), new Uint8Array(SALT_BYTES), params));
  },
): KdfParams {
  let m = DEFAULT_KDF.m;
  for (;;) {
    const params: KdfParams = { t: DEFAULT_KDF.t, m, p: 1 };
    const before = timer();
    runner(params);
    const elapsed = timer() - before;
    if (elapsed >= targetMs || m >= KDF_LIMITS.maxM) return params;
    m = Math.min(m * 2, KDF_LIMITS.maxM);
  }
}
