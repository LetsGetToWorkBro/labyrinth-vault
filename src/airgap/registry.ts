/**
 * The BC-UR registry types a watch-only wallet needs to hear.
 *
 * Sparrow, Electrum and the hardware-signer companions pair by scanning
 * `ur:crypto-account`: a master fingerprint and a list of output descriptors,
 * each one an extended public key with its derivation path. Until this file
 * existed the vault could only offer its own LV1 `ACCOUNT` frames, which
 * nothing but the Labyrinth wallet reads, so pairing with anybody else meant
 * reading a zpub off the glass and typing it.
 *
 * ## Why this can be trusted, given that nobody here owns Sparrow
 *
 * Because it is checked against the specification's own bytes rather than
 * against our decoder. `test/registry.test.ts` encodes the worked example from
 * BCR-2020-007 and compares to the hex the paper prints, and does the same for
 * the `crypto-account` in BCR-2020-015. A round trip through code in this
 * repository would prove only that we are consistently wrong, which is the
 * failure mode the UR encoder's own comment warns about: frames that look
 * right and that Sparrow will not read.
 *
 * ## What is deliberately not here
 *
 * Reading any of it. These types exist to be emitted; the scanner accepts
 * `crypto-psbt` and this project's own envelope and nothing else, and
 * `cborDecode` still refuses maps and tags outright. A signing device that
 * learns to parse a registry it never needs is offering a parser to whoever is
 * holding the other screen.
 */

import { cborWrite, type CborWritable } from './cbor';

/* Tags from the registry. The numbers are the whole of the compatibility:
 * a wrong one is not a corrupt payload, it is a different type that a reader
 * will either reject or, worse, misinterpret. */
const TAG_HDKEY = 303;
const TAG_KEYPATH = 304;
const TAG_OUTPUT = 308;
/** `wpkh(...)`, which is what BIP84 means. */
const TAG_WITNESS_PUBLIC_KEY_HASH = 404;

/** One level of a derivation path. */
export interface PathComponent {
  index: number;
  hardened: boolean;
}

export interface HdKeyParts {
  /** The 33-byte compressed public key. */
  keyData: Uint8Array;
  /** The 32-byte chain code. */
  chainCode: Uint8Array;
  /** Where this key sits, and under which master. */
  origin: { components: PathComponent[]; sourceFingerprint?: number };
  /** BIP32 fingerprint of this key's parent. */
  parentFingerprint?: number;
}

/**
 * `crypto-keypath`: the components, then whose master they are relative to.
 *
 * Components are a flat array of index and hardened flag, so 84'/0'/0' is
 * `[84, true, 0, true, 0, true]` rather than a list of pairs.
 */
function keypath(components: PathComponent[], sourceFingerprint?: number): CborWritable {
  const flat: CborWritable = [];
  for (const part of components) {
    flat.push(part.index);
    flat.push(part.hardened);
  }
  const map: Array<[number, CborWritable]> = [[1, flat]];
  if (sourceFingerprint !== undefined) map.push([2, sourceFingerprint]);
  return { tag: TAG_KEYPATH, value: { map } };
}

/** `crypto-hdkey`, the derived-key form: key data, chain code, and origin. */
export function hdKey(parts: HdKeyParts): CborWritable {
  const map: Array<[number, CborWritable]> = [
    [3, parts.keyData],
    [4, parts.chainCode],
    [6, keypath(parts.origin.components, parts.origin.sourceFingerprint)],
  ];
  if (parts.parentFingerprint !== undefined) map.push([8, parts.parentFingerprint]);
  return { tag: TAG_HDKEY, value: { map } };
}

/** `crypto-output` for a native segwit key: `wpkh(hdkey)`. */
export function witnessPublicKeyHashOutput(key: CborWritable): CborWritable {
  return { tag: TAG_OUTPUT, value: { tag: TAG_WITNESS_PUBLIC_KEY_HASH, value: key } };
}

/**
 * `crypto-account`: which seed, and what to watch under it.
 *
 * The fingerprint is the *master's*, not the account key's. A wallet uses it
 * to recognise the same seed behind a different account later, so getting it
 * from the wrong depth produces something that imports and then fails to
 * match anything.
 */
export function cryptoAccount(masterFingerprint: number, outputs: CborWritable[]): Uint8Array {
  return cborWrite({ map: [[1, masterFingerprint], [2, outputs]] });
}

/** The BIP84 account this vault exports, as the bytes of a `crypto-account`. */
export function bip84Account(args: {
  masterFingerprint: number;
  keyData: Uint8Array;
  chainCode: Uint8Array;
  parentFingerprint: number;
  /** Defaults to 84'/0'/0', the path this wallet uses. */
  components?: PathComponent[];
}): Uint8Array {
  const components = args.components ?? [
    { index: 84, hardened: true },
    { index: 0, hardened: true },
    { index: 0, hardened: true },
  ];
  const key = hdKey({
    keyData: args.keyData,
    chainCode: args.chainCode,
    origin: { components, sourceFingerprint: args.masterFingerprint },
    parentFingerprint: args.parentFingerprint,
  });
  return cryptoAccount(args.masterFingerprint, [witnessPublicKeyHashOutput(key)]);
}
