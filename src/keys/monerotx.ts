/**
 * wallet2's file formats: recognizing them, and refusing them by name.
 *
 * ## What this is for
 *
 * Monero's own cold-signing flow moves files, not QR codes. The online wallet
 * writes `unsigned_monero_tx`, the offline one signs it into
 * `signed_monero_tx`, and the same machinery carries key images and output
 * exports in both directions. Each of those files starts with a magic string,
 * and everything after it is encrypted.
 *
 * This vault cannot open any of them yet. That is a fact worth being precise
 * about rather than vague, because the two ways of being vague are both bad:
 *
 *   - saying "that is not a transaction" to a file that plainly *is* one
 *     tells somebody their file is broken when their file is fine, and the
 *     obvious next move is to go and re-export it, or try a different wallet,
 *     or conclude the app is broken;
 *   - pretending to read it, or partially reading it, would be worse still.
 *
 * So this module does the one thing it can do honestly: it identifies the
 * file, says exactly what it is, and says exactly which missing piece stops
 * the vault going further. `docs/monero-signing.md` is the long version.
 *
 * ## Why it stops here
 *
 * Three layers sit between these bytes and a wallet2-compatible answer, and
 * they have to be built in order. This list was wrong for a while and the way
 * it was wrong mattered, so it is now written from the source rather than from
 * recollection: the citations below are to
 * `monero/src/wallet/wallet2.cpp` on release-v0.18.
 *
 *   1. **CryptoNight.** The container's ChaCha20 key comes from
 *      `crypto::cn_slow_hash`, Monero's old proof-of-work hash, over the view
 *      secret key. Implementing it means a 2 MB scratchpad, an AES round
 *      function, and four more hash functions (Blake, Groestl, JH, Skein) that
 *      pick the final result between them. Until that exists the file cannot
 *      even be decrypted. This one is as advertised, and it is the reason the
 *      envelope is not a weekend's work.
 *   2. **Monero's own `binary_archive`, which is *not* Boost.** This comment
 *      used to say the plaintext was "a C++ object graph serialized by
 *      Boost.Serialization, not a documented wire format". That is false for
 *      every format the current wallet writes. `save_tx` and `sign_tx` build
 *      the payload with `binary_archive<true>` (wallet2.cpp:7703, :8016), the
 *      output export likewise (:14905), and all three are Monero's own
 *      serializer: varints, fixed-width little-endian integers, explicit
 *      container counts. Boost appears only on the deprecated `\003`/`\004`
 *      read paths that modern wallets refuse to load by default.
 *
 *      The key image export uses no archive at all. It is fixed-width
 *      concatenation written by hand — a little-endian `uint32` offset, the
 *      account's two public keys, then 96 bytes per record
 *      (wallet2.cpp:13933-13946).
 *
 *      The correction is worth this much space because the false version sent
 *      the reader towards writing a Boost portable-archive reader, which
 *      nothing here needs and which is far harder than the thing that is
 *      actually required.
 *   3. **The `unsigned_tx_set` struct graph.** Construction data, sources,
 *      ring members, destinations, subaddress indices. This is the layer that
 *      dominates the work, and it is design rather than line count: our
 *      in-memory shapes and wallet2's are not the same shapes.
 *
 * What is no longer on this list: **CLSAG and Bulletproofs+.** They used to be
 * item four, described there as absent. Both now ship with
 * provers and verifiers — `clsagSign`/`clsagVerify` in `monerosign.ts`,
 * `proveBulletproofPlus`/`verifyBulletproofPlus` in `bulletproofplus.ts` —
 * anchored to real on-chain proofs. The file claimed a gap that had been
 * closed, which is the same defect as claiming a capability that does not
 * exist, pointing the other way.
 *
 * The primitives underneath all of that — the derivations, the key image — are
 * in `monerocrypto.ts` and are checked against 720 of the Monero project's own
 * vectors. That is the floor being laid. The layers above it are not being
 * guessed at, because a signing device that guesses is worse than one that
 * says no.
 */

/** Which wallet2 file this is. */
export type ContainerKind =
  | 'unsigned-tx-set'
  | 'signed-tx-set'
  | 'multisig-unsigned-tx-set'
  | 'key-image-export'
  | 'multisig-export'
  | 'output-export';

interface Magic {
  kind: ContainerKind;
  /** The readable part of the literal in wallet2.cpp. */
  magic: string;
  /** The version byte that follows it in the build these were read from. */
  version: number;
  /** What it is, in the words somebody would use for it. */
  what: string;
  /** What it would let the vault do, if the vault could open it. */
  purpose: string;
}

/**
 * The magic strings, from `src/wallet/wallet2.cpp`.
 *
 * Each literal there ends in an escape — `"Monero unsigned tx set\005"` — and
 * that byte is a version, not decoration: Monero bumps it when the structure
 * behind the magic changes. It is deliberately *not* part of what is matched
 * here. This build refuses every one of these files anyway, so matching only
 * the readable part means a file from a newer Monero still gets named
 * correctly instead of being reported as unrecognised bytes, which would send
 * somebody off to debug a file that is perfectly good.
 *
 * The version that was actually seen is reported alongside, so the day this
 * module can open one of these, the mismatch is already in front of it.
 */
const MAGICS: Magic[] = ([
  {
    kind: 'multisig-unsigned-tx-set',
    magic: 'Monero multisig unsigned tx set',
    version: 1,
    what: 'a Monero multisig unsigned transaction set',
    purpose: 'sign as one of several required signers',
  },
  {
    kind: 'unsigned-tx-set',
    magic: 'Monero unsigned tx set',
    version: 5,
    what: 'a Monero unsigned transaction set',
    purpose: 'read the payment and sign it',
  },
  {
    kind: 'signed-tx-set',
    magic: 'Monero signed tx set',
    version: 5,
    what: 'a Monero signed transaction set',
    purpose: 'hand it back to the online wallet to broadcast',
  },
  {
    kind: 'key-image-export',
    magic: 'Monero key image export',
    version: 3,
    what: 'a Monero key image export',
    purpose: 'tell the watching wallet which outputs are already spent',
  },
  {
    kind: 'multisig-export',
    magic: 'Monero multisig export',
    version: 1,
    what: 'a Monero multisig export',
    purpose: 'exchange multisig information with the other signers',
  },
  {
    kind: 'output-export',
    magic: 'Monero output export',
    version: 4,
    what: 'a Monero output export',
    purpose: 'let the watching wallet see which outputs you own',
  },
] as Magic[])
  /* Longest first. "Monero multisig unsigned tx set" and "Monero
   * unsigned tx set" do not overlap today, but the family of names is
   * close enough that matching in length order is the cheap way to make sure
   * a future addition cannot be shadowed by a shorter sibling. */
  .sort((a, b) => b.magic.length - a.magic.length);

export interface Container {
  kind: ContainerKind;
  /** Plain words for the file, for a screen. */
  what: string;
  /** How many bytes follow the magic and its version byte. */
  bodyLength: number;
  /** The version byte in this file, or null if the file stops at the magic. */
  version: number | null;
  /** The version this build read the format from. */
  expectedVersion: number;
  /**
   * Whether the vault can act on it. Always false in this build, and typed as
   * a boolean rather than omitted so that the day it is not false, every
   * caller is already asking.
   */
  usable: boolean;
  /** Why not, in words that name the actual missing piece. */
  refusal: string;
}

/** The one code this module raises, for the app to switch on. */
export const MONERO_UNSUPPORTED = 'monero-file-unsupported';

function startsWith(bytes: Uint8Array, magic: string): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Identify a wallet2 file, or return null if these bytes are not one.
 *
 * Returning null is not a judgement about the bytes — a PSBT lands here and
 * leaves as null, which is correct. It only means "not one of Monero's".
 */
export function readContainer(bytes: Uint8Array): Container | null {
  if (!(bytes instanceof Uint8Array)) return null;
  for (const entry of MAGICS) {
    if (!startsWith(bytes, entry.magic)) continue;
    const version = bytes.length > entry.magic.length ? bytes[entry.magic.length]! : null;
    return {
      kind: entry.kind,
      what: entry.what,
      bodyLength: Math.max(0, bytes.length - entry.magic.length - 1),
      version,
      expectedVersion: entry.version,
      usable: false,
      refusal:
        `This is ${entry.what}. The vault can tell you that much and no more: ` +
        'everything after the header is encrypted with a key derived by CryptoNight, ' +
        'which this build does not implement. Monero transactions cannot be signed here yet. ' +
        'Nothing was signed and nothing was changed.',
    };
  }
  return null;
}

/**
 * The same question asked of text rather than bytes.
 *
 * These files are binary but their first line is not, so a person can paste
 * one into a field, or a scanner can hand back something that starts with
 * readable words. Answering there too means the honest message appears
 * wherever the file appears.
 */
export function readContainerText(text: string): Container | null {
  const value = String(text ?? '');
  if (!value.startsWith('Monero ')) return null;
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0xff;
  return readContainer(bytes);
}

/** Every magic this build knows, for tests and for documentation. */
export function knownContainers(): { kind: ContainerKind; magic: string; purpose: string }[] {
  return MAGICS.map(({ kind, magic, purpose }) => ({ kind, magic, purpose }));
}
