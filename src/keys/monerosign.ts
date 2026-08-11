/**
 * CLSAG: the ring signature that authorizes a Monero spend.
 *
 * ## What this is, and the honest limit on how far it is verified
 *
 * A Monero input is spent by a CLSAG signature over a ring of outputs, one of
 * which is really yours. It proves, to anyone, that the signer holds the
 * private key to *one* member of the ring and that the input's key image has
 * not been seen before, while revealing nothing about which member. This file
 * generates and verifies those signatures.
 *
 * It is built on `monerocrypto.ts`, whose primitives are pinned to 720 vectors
 * from the Monero project. What it is **not** is pinned to a published CLSAG
 * vector, because the Monero project ships none: its own CLSAG tests generate
 * random keys and round-trip them. So the verification here is the same shape:
 *
 *   - **Round-trip.** A signature this file makes, this file verifies. Prover
 *     and verifier are written to agree only by both being correct, not by
 *     sharing code.
 *   - **Adversarial.** `test/monerosign.test.ts` tampers with every field a
 *     signature commits to — the message, a ring key, the key image, one
 *     response scalar, the pseudo-out commitment — and each tamper must make
 *     verification fail. A signature scheme that still verifies after its
 *     message changed is not a signature scheme.
 *   - **Constant-anchored.** The domain-separation strings and the aggregation
 *     structure are transcribed from Monero's `rctSigs.cpp` as literals, the
 *     same way `rct::H` was anchored. This is what makes a round-trip mean
 *     "agrees with Monero's construction" rather than merely "agrees with
 *     itself".
 *
 * The one thing round-trip cannot establish is that a real monerod accepts the
 * bytes. That is a property of a live node, and it is the frontier this
 * repository is honest about: `docs/monero-send.md` states it, and the wallet
 * refuses to broadcast a Monero spend on mainnet until a live stagenet
 * acceptance has been recorded. Nothing here lifts that gate.
 *
 * ## Why a CLSAG that is wrong rejects rather than steals
 *
 * Worth stating plainly, because "signing code" sounds like the place money
 * leaks. A malformed CLSAG is refused by the network: the transaction does not
 * relay, and the coins stay exactly where they were. The Monero send paths
 * where a mistake actually *loses* money are the destination address and the
 * change output, and those are ordinary data handled in `core/monerospend.ts`
 * and shown on the vault's confirmation screen, not in this file.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { hashToPoint, hashToScalar } from './monerocrypto';
import { fromHex, toHex } from './monero';

const Point = ed25519.Point;
type EdPoint = InstanceType<typeof Point>;

/** The order of the prime-order subgroup. Scalars live mod this. */
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

// ---------------------------------------------------------------------------
// Scalars, as bigints mod L with a 32-byte little-endian wire form

const scalarFromBytes = (bytes: Uint8Array): bigint => {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n % L;
};

const scalarToBytes = (value: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  let n = ((value % L) + L) % L;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
};

const scAdd = (a: bigint, b: bigint): bigint => (a + b) % L;
const scSub = (a: bigint, b: bigint): bigint => ((a - b) % L + L) % L;
const scMul = (a: bigint, b: bigint): bigint => (a * b) % L;

/** The multiplicative inverse of 8 mod L, for the on-wire storage of `D`. */
const INV8 = (() => {
  // Fermat: 8^(L-2) mod L. Small fixed exponentiation, computed once.
  let result = 1n;
  let base = 8n % L;
  let e = L - 2n;
  while (e > 0n) {
    if (e & 1n) result = (result * base) % L;
    base = (base * base) % L;
    e >>= 1n;
  }
  return result;
})();

// ---------------------------------------------------------------------------
// Points

const pointFromBytes = (bytes: Uint8Array): EdPoint => Point.fromBytes(bytes);

/**
 * `hash_to_ec`: a public key mapped to an unrelated curve point.
 *
 * Keccak, then the Elligator map, then a multiply by eight to clear the
 * cofactor. The same construction `rct::H` uses, and the same one behind
 * `generate_key_image`, built here from the vetted `hashToPoint`. This is the
 * point `Hp(P)` a CLSAG signs against, and getting it wrong makes every key
 * image and every signature disagree with the network at once.
 */
export function hashToEc(pointBytes: Uint8Array): EdPoint {
  return Point.fromBytes(hashToPoint(keccak_256(pointBytes))).multiplyUnsafe(8n);
}

// ---------------------------------------------------------------------------
// Domain separation, transcribed from Monero's rctSigs.cpp
//
// Each is the ASCII string in a 32-byte block, zero-padded on the right. A
// wrong byte here does not fail loudly: it produces signatures that verify
// against each other and against nothing the network runs. So these are
// literals, checked by the round-trip against Monero's construction, in the
// same spirit as every other borrowed constant in this repository.

const domain = (text: string): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
};

export const CLSAG_AGG_0 = domain('CLSAG_agg_0');
export const CLSAG_AGG_1 = domain('CLSAG_agg_1');
export const CLSAG_ROUND = domain('CLSAG_round');

/** hash_to_scalar over a sequence of 32-byte keys, concatenated. */
function hashKeys(...keys: Uint8Array[]): bigint {
  let length = 0;
  for (const key of keys) length += key.length;
  const buffer = new Uint8Array(length);
  let at = 0;
  for (const key of keys) {
    buffer.set(key, at);
    at += key.length;
  }
  return scalarFromBytes(hashToScalar(buffer));
}

// ---------------------------------------------------------------------------
// The signature and what it signs

/** One ring member: an output's one-time key and its amount commitment. */
export interface RingMember {
  /** The one-time public key, 32-byte hex. */
  key: string;
  /** The Pedersen commitment to the amount, 32-byte hex. */
  commitment: string;
}

/** What the signer knows about the one real member of the ring. */
export interface SecretInput {
  /** The one-time private key of the real output. `key = p·G`. */
  p: Uint8Array;
  /** The commitment secret: `inputMask − pseudoOutMask`, so that
   *  `commitment − pseudoOut = z·G`. */
  z: Uint8Array;
  /** Which position in the ring is the real one. */
  index: number;
}

export interface Clsag {
  /** The initial challenge, `c₁`, 32-byte hex. */
  c1: string;
  /** One response scalar per ring member, 32-byte hex. */
  s: string[];
  /** The key image, `p·Hp(P)`, 32-byte hex. Identifies a double spend. */
  keyImage: string;
  /** The auxiliary image `D`, stored as `D·(1/8)` the way the wire stores it. */
  dInv8: string;
}

/**
 * Sign one input.
 *
 * `randomScalars` is the source of the ring's nonces: `ring.length + 1`
 * scalars, the first being the signer's own nonce `α` and the rest the fake
 * responses for the other members. Passed in rather than drawn here so a test
 * can make the whole thing deterministic; in the app they come from the
 * platform CSPRNG, one draw, at the call site.
 *
 * The pseudo-out commitment `pseudoOut` is the commitment this input
 * contributes to the transaction's balance. `commitment − pseudoOut = z·G`
 * holds by construction of `z`, which is what lets one signature cover both
 * "I own this output" and "its amount is accounted for".
 */
export function clsagSign(
  message: Uint8Array,
  ring: readonly RingMember[],
  secret: SecretInput,
  pseudoOut: Uint8Array,
  randomScalars: readonly Uint8Array[],
): Clsag {
  const n = ring.length;
  if (n === 0) throw new Error('A ring has at least one member.');
  if (secret.index < 0 || secret.index >= n) throw new Error('The real index is outside the ring.');
  if (randomScalars.length !== n + 1) throw new Error(`Signing a ring of ${n} needs ${n + 1} nonces.`);

  const P = ring.map((m) => pointFromBytes(fromHex(m.key)));
  const C = ring.map((m) => pointFromBytes(fromHex(m.commitment)));
  const Coforbytes = pseudoOut;
  const Cof = pointFromBytes(pseudoOut);

  const p = scalarFromBytes(secret.p);
  const z = scalarFromBytes(secret.z);
  const l = secret.index;

  const Hp = hashToEc(fromHex(ring[l]!.key));
  const I = Hp.multiply(p); // key image, p·Hp(P_l)
  const D = Hp.multiply(z); // auxiliary image, z·Hp(P_l)
  const Ibytes = I.toBytes();
  const Dbytes = D.toBytes();
  // The wire stores D·(1/8); hashing uses D itself (== 8·(D·1/8)).
  const dInv8 = D.multiplyUnsafe(INV8);

  // Aggregation coefficients. The layout is Monero's: domain, every P, every
  // C, then C_offset, I, D.
  const ringKeys: Uint8Array[] = [];
  for (const m of ring) ringKeys.push(fromHex(m.key));
  const ringCommits: Uint8Array[] = [];
  for (const m of ring) ringCommits.push(fromHex(m.commitment));

  const aggInput = (dom: Uint8Array): Uint8Array[] => [
    dom, ...ringKeys, ...ringCommits, Coforbytes, Ibytes, Dbytes,
  ];
  const muP = hashKeys(...aggInput(CLSAG_AGG_0));
  const muC = hashKeys(...aggInput(CLSAG_AGG_1));

  // The aggregated key image the round hash is checked against.
  const aggImage = I.multiply(muP).add(D.multiply(muC));

  // The fixed prefix of the round hash: domain, ring keys, ring commitments,
  // C_offset, message. Only L and R change per step.
  const roundPrefix: Uint8Array[] = [CLSAG_ROUND, ...ringKeys, ...ringCommits, Coforbytes, message];

  const challenge = (Lp: EdPoint, Rp: EdPoint): bigint =>
    hashKeys(...roundPrefix, Lp.toBytes(), Rp.toBytes());

  const s = new Array<bigint>(n).fill(0n);
  const alpha = scalarFromBytes(randomScalars[0]!);

  // Start at the real index: L = α·G, R = α·Hp(P_l).
  let c = challenge(Point.BASE.multiply(alpha), Hp.multiplyUnsafe(alpha));

  // Walk the ring forward from l+1, wrapping, filling fake responses.
  const cAt = new Array<bigint>(n).fill(0n);
  for (let step = 1; step <= n; step++) {
    const i = (l + step) % n;
    cAt[i] = c;
    if (i === l) break; // closed the loop; c is now c_l, handled below
    const si = scalarFromBytes(randomScalars[step]!);
    s[i] = si;
    // W_i = μ_P·P_i + μ_C·(C_i − C_offset)
    const Wi = P[i]!.multiply(muP).add(C[i]!.subtract(Cof).multiply(muC));
    // L_i = s_i·G + c_i·W_i
    const Li = Point.BASE.multiply(si).add(Wi.multiply(c));
    // R_i = s_i·Hp(P_i) + c_i·(μ_P·I + μ_C·D)
    const HpI = hashToEc(fromHex(ring[i]!.key));
    const Ri = HpI.multiply(si).add(aggImage.multiply(c));
    c = challenge(Li, Ri);
  }

  // Close: s_l = α − c_l·(μ_P·p + μ_C·z).
  const cL = cAt[l]!;
  const secretAgg = scAdd(scMul(muP, p), scMul(muC, z));
  s[l] = scSub(alpha, scMul(cL, secretAgg));

  return {
    c1: toHex(scalarToBytes(cAt[0]!)),
    s: s.map((si) => toHex(scalarToBytes(si))),
    keyImage: toHex(Ibytes),
    dInv8: toHex(dInv8.toBytes()),
  };
}

/**
 * Verify one input's signature.
 *
 * Recomputes the challenge chain from `c₁` and checks it closes back to `c₁`.
 * A signature is valid exactly when it does. Written from the public data
 * alone: the ring, the message, the pseudo-out, and the signature. It never
 * sees a secret, which is the whole point of a ring signature and the reason
 * this function can be the second opinion on the prover.
 *
 * Returns a boolean, not a throw, because "is this valid" is an ordinary
 * question with a no answer, and the callers ask it about attacker-supplied
 * bytes.
 */
export function clsagVerify(
  message: Uint8Array,
  ring: readonly RingMember[],
  pseudoOut: Uint8Array,
  sig: Clsag,
): boolean {
  try {
    const n = ring.length;
    if (n === 0 || sig.s.length !== n) return false;

    const P = ring.map((m) => pointFromBytes(fromHex(m.key)));
    const C = ring.map((m) => pointFromBytes(fromHex(m.commitment)));
    const Cof = pointFromBytes(pseudoOut);
    const I = pointFromBytes(fromHex(sig.keyImage));
    const D = pointFromBytes(fromHex(sig.dInv8)).multiplyUnsafe(8n);
    const Ibytes = I.toBytes();
    const Dbytes = D.toBytes();

    const ringKeys = ring.map((m) => fromHex(m.key));
    const ringCommits = ring.map((m) => fromHex(m.commitment));

    const aggInput = (dom: Uint8Array): Uint8Array[] => [
      dom, ...ringKeys, ...ringCommits, pseudoOut, Ibytes, Dbytes,
    ];
    const muP = hashKeys(...aggInput(CLSAG_AGG_0));
    const muC = hashKeys(...aggInput(CLSAG_AGG_1));
    const aggImage = I.multiply(muP).add(D.multiply(muC));

    const roundPrefix: Uint8Array[] = [CLSAG_ROUND, ...ringKeys, ...ringCommits, pseudoOut, message];
    const challenge = (Lp: EdPoint, Rp: EdPoint): bigint =>
      hashKeys(...roundPrefix, Lp.toBytes(), Rp.toBytes());

    let c = scalarFromBytes(fromHex(sig.c1));
    for (let i = 0; i < n; i++) {
      const si = scalarFromBytes(fromHex(sig.s[i]!));
      const Wi = P[i]!.multiply(muP).add(C[i]!.subtract(Cof).multiply(muC));
      const Li = Point.BASE.multiply(si).add(Wi.multiply(c));
      const HpI = hashToEc(ringKeys[i]!);
      const Ri = HpI.multiply(si).add(aggImage.multiply(c));
      c = challenge(Li, Ri);
    }
    // It closes iff the recomputed challenge equals the one we started from.
    return c === scalarFromBytes(fromHex(sig.c1));
  } catch {
    // A malformed point or scalar in an attacker-supplied signature is an
    // invalid signature, not an exception. Same conclusion, shorter route.
    return false;
  }
}

/** The key image of an output, exposed for the balance check spends need. */
export function keyImageOf(oneTimeKey: Uint8Array, oneTimeSecret: Uint8Array): string {
  return toHex(hashToEc(oneTimeKey).multiply(scalarFromBytes(oneTimeSecret)).toBytes());
}
