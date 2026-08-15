/**
 * wallet2's file formats: recognizing them, and saying which ones this build
 * can open.
 *
 * ## What this is for
 *
 * Monero's own cold-signing flow moves files, not QR codes. The online wallet
 * writes `unsigned_monero_tx`, the offline one signs it into
 * `signed_monero_tx`, and the same machinery carries key images and output
 * exports in both directions. Each of those files starts with a magic string,
 * and everything after it is encrypted.
 *
 * Recognizing one is worth doing on its own, because the two ways of being
 * vague are both bad:
 *
 *   - saying "that is not a transaction" to a file that plainly *is* one
 *     tells somebody their file is broken when their file is fine, and the
 *     obvious next move is to go and re-export it, or try a different wallet,
 *     or conclude the app is broken;
 *   - pretending to read it, or partially reading it, would be worse still.
 *
 * So every entry below carries `readable`: whether this build can open the
 * container and describe what is inside it, or whether naming the file is the
 * whole of what it can honestly offer. `docs/monero-signing.md` is the long
 * version.
 *
 * ## What changed, and what did not
 *
 * One entry is `readable` now. `Monero unsigned tx set` opens: the ChaCha20
 * key comes from `crypto::cn_slow_hash` over the view secret key — CryptoNight
 * variant 0, vendored as C in `vendor/cryptonight` and wired through
 * `moneroexport.ts` — and the plaintext is a `binary_archive`, read by
 * `monerounsigned.ts`. Those two layers were the reason this header used to
 * say no to everything, and both are built.
 *
 * **Readable is not signable, and this is the distinction the whole module
 * turns on.** `signable` is false for every container here, by design rather
 * than by omission. What a `tx_construction_data` contains is the *sending*
 * wallet's account of its own transaction; nothing in the file is evidence for
 * anything in it. Signing needs each destination re-derived from the vault's
 * own keys before a person is asked to approve, which is what
 * `monerobuild.ts` does on this project's own wire. A screen that offered a
 * signature over a file's self-description would be the exact failure this
 * vault exists to refuse.
 *
 * ## Two corrections this header has already needed
 *
 * Kept, because both were load-bearing mistakes and the record is worth more
 * than the tidiness. Citations are to `monero/src/wallet/wallet2.cpp` on
 * release-v0.18.
 *
 *   1. **The plaintext is not Boost.** This used to describe the payload as a
 *      C++ object graph produced by Boost.Serialization rather than any
 *      documented wire format. False for every format the current wallet
 *      writes. `save_tx`
 *      and `sign_tx` build it with `binary_archive<true>` (wallet2.cpp:7703,
 *      :8016) and the output export likewise (:14905): varints, fixed-width
 *      little-endian integers, explicit container counts. Boost appears only
 *      on the deprecated `\003`/`\004` read paths that modern wallets refuse
 *      to load by default. The false version pointed at a Boost
 *      portable-archive reader, which nothing here needs and which is far
 *      harder than the thing actually required.
 *
 *      The key image export uses no archive at all. It is fixed-width
 *      concatenation written by hand — a little-endian `uint32` offset, the
 *      account's two public keys, then 96 bytes per record
 *      (wallet2.cpp:13933-13946).
 *
 *   2. **CLSAG and Bulletproofs+ were described as absent** after they had
 *      shipped — `clsagSign`/`clsagVerify` in `monerosign.ts`,
 *      `proveBulletproofPlus`/`verifyBulletproofPlus` in `bulletproofplus.ts`,
 *      anchored to real on-chain proofs. Claiming a gap that had closed is the
 *      same defect as claiming a capability that does not exist, pointing the
 *      other way, and it is why `readable` is a field on the data rather than
 *      a sentence in a comment.
 *
 * The primitives underneath all of it — the derivations, the key image — are
 * in `monerocrypto.ts` and are checked against 720 of the Monero project's own
 * vectors.
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
  /**
   * Whether this build can open the container and describe what is inside.
   *
   * A property of the file format, not of the file: a `readable` container
   * can still fail to open, because it belongs to another wallet or because
   * it is damaged. That answer comes from the reader, not from here.
   */
  readable: boolean;
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
    /* Not a missing reader: this vault does not do multisig at all, in either
     * currency, and reading the container would be the first thing that made
     * it look as though it might. */
    readable: false,
  },
  {
    kind: 'unsigned-tx-set',
    magic: 'Monero unsigned tx set',
    version: 5,
    what: 'a Monero unsigned transaction set',
    purpose: 'read what the sending wallet says the payment is',
    readable: true,
  },
  {
    kind: 'signed-tx-set',
    magic: 'Monero signed tx set',
    version: 5,
    what: 'a Monero signed transaction set',
    purpose: 'hand it back to the online wallet to broadcast',
    /* A finished transaction, which is a thing to broadcast rather than a
     * thing to read on a signer. Nothing this device does needs it. */
    readable: false,
  },
  {
    kind: 'key-image-export',
    magic: 'Monero key image export',
    version: 3,
    what: 'a Monero key image export',
    purpose: 'tell the watching wallet which outputs are already spent',
    /* This vault *writes* this one — see `exportKeyImageBlob` — and has a
     * reader for it in `readKeyImageBlob`, used to prove the writer against
     * Monero's own bytes. Nothing on a signing device wants to import
     * somebody else's key images, so no screen offers it. */
    readable: false,
  },
  {
    kind: 'multisig-export',
    magic: 'Monero multisig export',
    version: 1,
    what: 'a Monero multisig export',
    purpose: 'exchange multisig information with the other signers',
    readable: false,
  },
  {
    kind: 'output-export',
    magic: 'Monero output export',
    version: 4,
    what: 'a Monero output export',
    purpose: 'let the watching wallet see which outputs you own',
    readable: false,
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
   * Whether this build can open it and describe what is inside.
   *
   * True for the unsigned transaction set and false for the rest. A caller
   * that ignores this and reads anyway gets a refusal from the reader rather
   * than a wrong answer, but the point of the flag is to let a screen offer
   * the right thing before it tries.
   */
  readable: boolean;
  /**
   * Whether the vault will produce a signature over it. False for every one
   * of these, in this build and by design, and typed as a boolean rather than
   * omitted so that a caller cannot forget to ask.
   *
   * `readable && !signable` is the whole shape of what this vault does with
   * Monero's files: it can tell you what one says, and what one says is the
   * sending wallet's own account of itself. See the module header.
   */
  signable: boolean;
  /** What the vault will not do with it, in words fit for a screen. */
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
      readable: entry.readable,
      /* Not a field with a `false` waiting to be flipped. Nothing this vault
       * could learn about Monero's file formats would make one of them
       * signable, because the obstacle is not a format: a construction plan
       * is what the *sender* says, and a signature has to be over what the
       * vault re-derived. See the module header. */
      signable: false,
      refusal: entry.readable
        ? `This is ${entry.what}. The vault can open it and tell you what the sending ` +
          'wallet says the payment is. It will not sign it: everything in the file is ' +
          "that wallet's own account of its own transaction, and a signature has to be " +
          "over destinations this device derived from its own keys. Nothing was signed."
        : `This is ${entry.what}. The vault recognizes the header, and this build has no ` +
          'reader for what follows it, so naming the file is the whole of what it can ' +
          'honestly offer. Nothing was signed and nothing was changed.',
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
export function knownContainers(): {
  kind: ContainerKind;
  magic: string;
  purpose: string;
  readable: boolean;
}[] {
  return MAGICS.map(({ kind, magic, purpose, readable }) => ({ kind, magic, purpose, readable }));
}
