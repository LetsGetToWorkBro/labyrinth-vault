/**
 * Output descriptors: the one string that pairs this vault with almost
 * anything.
 *
 * ## Why, when there is already a zpub and a `ur:crypto-account`
 *
 * A zpub says which keys. It does not say which script type, which derivation
 * path they came from, or which master seed they belong to — all three of
 * which a watch-only wallet has to guess. Guessing wrong produces a wallet
 * full of addresses nobody can spend from, and the guess is invisible until
 * somebody is owed money at one of them.
 *
 * A descriptor says all of it in one line:
 *
 *     wpkh([1a2b3c4d/84h/0h/0h]xpub6C.../0/*)#hcxjggj9
 *      │     │        │         │       │      └ BIP-380 checksum
 *      │     │        │         │       └ receive chain; /1/* is change
 *      │     │        │         └ the account key
 *      │     │        └ where it was derived
 *      │     └ the master fingerprint, so a wallet can tell whose it is
 *      └ pay-to-witness-public-key-hash: native segwit, bc1q
 *
 * Sparrow, Nunchuk, BlueWallet, Bitcoin Core and Electrum all import that.
 * `ur:crypto-account` carries the same facts for the wallets that scan it, and
 * this is the form for everything else: pasted, typed, or shown as a QR that
 * needs no registry support at all.
 *
 * ## The checksum is not decoration
 *
 * BIP-380's checksum is designed to catch the errors people actually make with
 * these strings: a substituted character, a transposition, a truncated paste.
 * A descriptor without one is accepted by some wallets and rejected by others,
 * and a descriptor with a *wrong* one is rejected by all of them, so it is
 * generated here rather than left off. `test/descriptor.test.ts` checks every
 * one this file produces against Electrum's own `DescriptorChecksum`.
 *
 * ## Single-signature only, deliberately
 *
 * Everything here is `wpkh(...)`: one key, one signature. This vault does not
 * do multisig, and the descriptor grammar is where that would first appear as
 * a half-truth — `wsh(sortedmulti(2,...))` is a one-line change to write and a
 * very large change to actually support, because multisig means verifying
 * change against a script rather than a key. So there is no code here that
 * could emit one, and `test/app-wiring.test.ts` keeps it that way.
 */

import { HDKey } from '@scure/bip32';

/**
 * BIP-380's input alphabet, in its order. The index of a character is its
 * value, so the order is the specification and not a preference.
 */
const INPUT_CHARSET =
  "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";

/** The bech32 alphabet, which is what the eight checksum characters come from. */
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/**
 * The BCH generator, as bigints because these do not fit in a JavaScript
 * number: 0xf5dee51989 is 40 bits and the safe integer range for the bitwise
 * operators is 32. Getting that wrong produces a checksum that looks
 * plausible, differs from everybody else's, and makes every wallet reject the
 * descriptor.
 */
const GENERATOR = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];

function polymod(symbols: readonly number[]): bigint {
  let chk = 1n;
  for (const value of symbols) {
    const top = chk >> 35n;
    chk = ((chk & 0x7ffffffffn) << 5n) ^ BigInt(value);
    for (let i = 0; i < 5; i++) {
      if ((top >> BigInt(i)) & 1n) chk ^= GENERATOR[i]!;
    }
  }
  return chk;
}

/**
 * Expand a descriptor into the symbols the checksum runs over.
 *
 * Each character contributes its low five bits directly and its high bits in
 * groups of three, which is what lets the code detect a transposition across
 * the whole string rather than only nearby ones.
 *
 * Returns null for a character outside the alphabet rather than skipping it: a
 * descriptor with a stray character is not a descriptor, and computing a
 * checksum over the rest would produce a string that passes its own check and
 * describes something else.
 */
function expand(descriptor: string): number[] | null {
  const symbols: number[] = [];
  const groups: number[] = [];
  for (const char of descriptor) {
    const value = INPUT_CHARSET.indexOf(char);
    if (value < 0) return null;
    symbols.push(value & 31);
    groups.push(value >> 5);
    if (groups.length === 3) {
      symbols.push(groups[0]! * 9 + groups[1]! * 3 + groups[2]!);
      groups.length = 0;
    }
  }
  if (groups.length === 1) symbols.push(groups[0]!);
  else if (groups.length === 2) symbols.push(groups[0]! * 3 + groups[1]!);
  return symbols;
}

/** The eight-character checksum for a descriptor, or null if it is not one. */
export function descriptorChecksum(descriptor: string): string | null {
  const symbols = expand(descriptor);
  if (!symbols) return null;
  const checksum = polymod([...symbols, 0, 0, 0, 0, 0, 0, 0, 0]) ^ 1n;
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += CHECKSUM_CHARSET[Number((checksum >> (5n * BigInt(7 - i))) & 31n)];
  }
  return out;
}

/** A descriptor with its checksum appended, or null if it cannot have one. */
export function withChecksum(descriptor: string): string | null {
  const checksum = descriptorChecksum(descriptor);
  return checksum === null ? null : `${descriptor}#${checksum}`;
}

/**
 * Check a descriptor that arrived with a checksum already on it.
 *
 * Not used on the export path, where this file is the author. It is here
 * because a descriptor is exactly the kind of string somebody will one day
 * want to paste *into* the vault, and the moment that exists it must be
 * checked rather than trusted.
 */
export function checksumIsValid(descriptor: string): boolean {
  const at = descriptor.lastIndexOf('#');
  if (at < 0 || at !== descriptor.length - 9) return false;
  const body = descriptor.slice(0, at);
  const given = descriptor.slice(at + 1);
  const want = descriptorChecksum(body);
  return want !== null && want === given;
}

// ---------------------------------------------------------------------------
// This vault's own descriptors

/** Standard BIP-32 version bytes, which is what a descriptor's key uses. */
const XPUB_VERSIONS = { private: 0x0488ade4, public: 0x0488b21e };

/**
 * The account key as an `xpub`, whatever clothes it arrived in.
 *
 * The vault holds its account key as a `zpub`, because SLIP-132 version bytes
 * are what a BIP84 wallet shows and what its companion expects. A descriptor
 * wants the plain `xpub`: the script type is already stated by the `wpkh(...)`
 * wrapper, so a zpub inside one is saying the same thing twice, and Bitcoin
 * Core rejects it outright.
 *
 * The two strings are the same key. Only the four version bytes differ, and
 * this re-serializes rather than converting, so there is no byte-editing of a
 * base58 payload to get wrong.
 */
export function accountXpub(zpub: string, zpubVersions: { private: number; public: number }): string | null {
  try {
    const node = HDKey.fromExtendedKey(zpub, zpubVersions);
    /* An extended key that parsed always has both of these; the types say
     * otherwise because the same class also models a bare private node. A
     * refusal rather than a non-null assertion, because this runs on a string
     * that could have come from anywhere. */
    const { chainCode, publicKey } = node;
    if (!chainCode || !publicKey) return null;

    const restated = new HDKey({
      versions: XPUB_VERSIONS,
      depth: node.depth,
      parentFingerprint: node.parentFingerprint,
      index: node.index,
      chainCode,
      publicKey,
    });
    return restated.publicExtendedKey;
  } catch {
    return null;
  }
}

export interface DescriptorSet {
  /** `/0/*`, the addresses somebody is given. */
  receive: string;
  /** `/1/*`, the addresses change comes back to. */
  change: string;
  /**
   * Both chains in one string, `/<0;1>/*`.
   *
   * Sparrow, Nunchuk and Bitcoin Core 26 and later take this and it is one
   * scan instead of two. Older wallets do not, which is why it is offered
   * beside the pair rather than instead of it.
   */
  combined: string;
}

/**
 * The descriptors for this vault's BIP84 account.
 *
 * @param masterFingerprint the *master's* fingerprint, not the account's. A
 *   descriptor's key origin identifies the seed, so that a wallet can
 *   recognise the same seed behind a different account later. Passing the
 *   account's fingerprint produces a descriptor that works until somebody
 *   tries to match two of them.
 *
 * Returns null for a watch-only wallet, which has no master to fingerprint and
 * therefore cannot state a key origin. A descriptor with the origin left out
 * is legal and is a worse thing to hand somebody than nothing: it silently
 * drops the fact that makes two accounts recognisable as one seed.
 */
export function bip84Descriptors(
  zpub: string,
  zpubVersions: { private: number; public: number },
  masterFingerprint: number | undefined,
  accountPath = '84h/0h/0h',
): DescriptorSet | null {
  if (masterFingerprint === undefined) return null;
  const xpub = accountXpub(zpub, zpubVersions);
  if (!xpub) return null;

  /* Eight lower-case hex characters, big-endian. `>>> 0` because a fingerprint
   * with its top bit set is a negative number in JavaScript's signed
   * bit-twiddling, and `(-1).toString(16)` is not eight characters of hex. */
  const origin = (masterFingerprint >>> 0).toString(16).padStart(8, '0');
  const prefix = `wpkh([${origin}/${accountPath}]${xpub}`;

  const receive = withChecksum(`${prefix}/0/*)`);
  const change = withChecksum(`${prefix}/1/*)`);
  const combined = withChecksum(`${prefix}/<0;1>/*)`);
  if (!receive || !change || !combined) return null;
  return { receive, change, combined };
}
