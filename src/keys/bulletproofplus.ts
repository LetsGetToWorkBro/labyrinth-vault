/**
 * Bulletproof+ verification, anchored to real proofs from the Monero chain.
 *
 * ## Why this file is different from every other crypto file here
 *
 * Everything else in `keys/` is either pinned to the Monero project's published
 * vectors or, like CLSAG, round-tripped and adversarially tested because no
 * fixed vector exists. Bulletproof+ is the range proof that proves each output
 * amount is in `[0, 2^64)` without revealing it, and it is the single most
 * error-prone piece of Monero's cryptography: hundreds of lines of
 * inner-product argument whose Fiat-Shamir transcript must match the network's
 * to the byte, with the failure mode being silent.
 *
 * Its verification is anchored the strongest way available: **against real,
 * network-accepted proofs pulled from the mainnet chain.** `test/fixtures/`
 * holds Bulletproof+ proofs from actual transactions, with their output
 * commitments. If this verifier accepts a proof the Monero network accepted,
 * and rejects it the moment any field is disturbed, then it agrees with
 * consensus about what a valid range proof is. That is a far stronger claim
 * than round-tripping against a prover of one's own, and it is the same move
 * that anchored `rct::H` to Monero's literal and the scan's amounts to
 * on-chain commitments.
 *
 * The algorithm below is transcribed from `bulletproofs_plus.cc`
 * (`bulletproof_plus_VERIFY`). The constants, the transcript, and the batch
 * multiscalar equation are the reference's, not a reconstruction; the fixtures
 * are what prove the transcription is faithful.
 *
 * ## What this establishes and what it does not
 *
 * A verifier that agrees with consensus on real proofs is what makes a
 * *prover* trustworthy: a proof this file's prover produces, that this
 * consensus-anchored verifier accepts, is a proof the network will accept too.
 * That is the chain that lets `monerospend`/the vault build a real range proof
 * with confidence. What none of it replaces is a live broadcast: the
 * `moneroreadiness` gate stays closed until a transaction built end to end has
 * been relayed and accepted, because assembling the whole transaction is more
 * than its range proof.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { hashToPoint, hashToScalar, RCT_H } from './monerocrypto';
import { fromHex, toHex } from './monero';

const Point = ed25519.Point;
type EdPoint = InstanceType<typeof Point>;

const L = 2n ** 252n + 27742317777372353535851937790883648493n;

// Range proof shape: 64-bit amounts, up to 16 outputs aggregated.
const N = 64;
const LOG_N = 6;
const MAX_M = 16;

// ---------------------------------------------------------------------------
// Scalars mod L

const b2s = (bytes: Uint8Array): bigint => {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n % L;
};
const s2b = (value: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  let n = ((value % L) + L) % L;
  for (let i = 0; i < 32; i++) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
};
const add = (a: bigint, b: bigint): bigint => (a + b) % L;
const sub = (a: bigint, b: bigint): bigint => ((a - b) % L + L) % L;
const mul = (a: bigint, b: bigint): bigint => (a * b) % L;
const muladd = (a: bigint, b: bigint, c: bigint): bigint => (a * b + c) % L;
function inv(a: bigint): bigint {
  // Fermat: a^(L-2) mod L.
  let result = 1n;
  let base = ((a % L) + L) % L;
  let e = L - 2n;
  while (e > 0n) {
    if (e & 1n) result = (result * base) % L;
    base = (base * base) % L;
    e >>= 1n;
  }
  return result;
}
const INV8 = inv(8n);

// ---------------------------------------------------------------------------
// Points and the fixed generators

const H = Point.fromBytes(RCT_H); // rct::H, the second generator
const G = Point.BASE;

/** Monero's varint, for the generator index in `get_exponent`. */
function varint(value: number): Uint8Array {
  const out: number[] = [];
  let n = value;
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return Uint8Array.from(out);
}

const EXP_DOMAIN = new TextEncoder().encode('bulletproof_plus');

/**
 * `get_exponent(H, idx)`: an indexed public generator.
 *
 * The reference keccaks `H ‖ "bulletproof_plus" ‖ varint(idx)` and passes that
 * hash to `rct::hash_to_p3`, which keccaks its argument again before the
 * Elligator map and the cofactor multiply. So the generator is
 * `8 · fromfe(keccak(keccak(H ‖ "bulletproof_plus" ‖ varint(idx))))`: two
 * Keccak rounds, not one, because `hash_to_p3` hashes what it is given.
 * `hashToPoint` here is only the `fromfe` half, so both Keccak rounds and the
 * `multiplyUnsafe(8n)` are done explicitly.
 * `Gi[i] = get_exponent(H, 2i+1)`, `Hi[i] = get_exponent(H, 2i)`.
 */
function getExponent(idx: number): EdPoint {
  const buf = new Uint8Array(RCT_H.length + EXP_DOMAIN.length + 8);
  buf.set(RCT_H, 0);
  buf.set(EXP_DOMAIN, RCT_H.length);
  const v = varint(idx);
  buf.set(v, RCT_H.length + EXP_DOMAIN.length);
  const hashed = keccak_256(keccak_256(buf.subarray(0, RCT_H.length + EXP_DOMAIN.length + v.length)));
  return Point.fromBytes(hashToPoint(hashed)).multiplyUnsafe(8n);
}

const giCache: EdPoint[] = [];
const hiCache: EdPoint[] = [];
function Gi(i: number): EdPoint { return (giCache[i] ??= getExponent(i * 2 + 1)); }
function Hi(i: number): EdPoint { return (hiCache[i] ??= getExponent(i * 2)); }

/**
 * The initial transcript seed: `hash_to_p3` of the keccak of the domain string,
 * encoded. As in `getExponent`, the reference hands `hash_to_p3` an
 * already-keccak'd argument and `hash_to_p3` keccaks it again, so the seed is
 * `8 · fromfe(keccak(keccak("bulletproof_plus_transcript")))` and the bytes are
 * what feed the transcript.
 */
const INITIAL_TRANSCRIPT = Point.fromBytes(
  hashToPoint(keccak_256(keccak_256(new TextEncoder().encode('bulletproof_plus_transcript')))),
).multiplyUnsafe(8n).toBytes();

// ---------------------------------------------------------------------------
// Transcript

/** hash_to_scalar over concatenated 32-byte chunks, the transcript's hash. */
function hashScalar(...chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const c of chunks) length += c.length;
  const buf = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.length; }
  return hashToScalar(buf);
}
/** transcript_update: fold one or two points/scalars into the running hash. */
function tu(transcript: Uint8Array, ...updates: Uint8Array[]): Uint8Array {
  return hashScalar(transcript, ...updates);
}

// ---------------------------------------------------------------------------
// Sum helpers, transcribed from the reference

/** sum_{k=0}^{n-1} x^k, for the y-power aggregate. */
function sumOfScalarPowers(x: bigint, n: number): bigint {
  let res = 1n;
  if (n === 1) return x;
  let m = n + 1;
  let x1 = x;
  const powerOfTwo = (m & (m - 1)) === 0;
  if (powerOfTwo) {
    res = add(res, x1);
    while (m > 2) { x1 = mul(x1, x1); res = muladd(x1, res, res); m = Math.floor(m / 2); }
  } else {
    let prev = x1;
    for (let i = 1; i < m; i++) { if (i > 1) prev = mul(prev, x1); res = add(res, prev); }
  }
  return sub(res, 1n);
}

/** sum of even powers x^2 + x^4 + ... to n terms (n a power of two). */
function sumOfEvenPowers(x: bigint, n: number): bigint {
  let x1 = mul(x, x);
  let res = x1;
  let m = n;
  while (m > 2) { res = muladd(x1, res, res); x1 = mul(x1, x1); m = Math.floor(m / 2); }
  return res;
}

/** 2^64 - 1 as a scalar. */
const TWO_64_MINUS_1 = (() => {
  let two = 2n % L;
  for (let i = 0; i < 6; i++) two = mul(two, two); // 2^64
  return sub(two, 1n);
})();

// ---------------------------------------------------------------------------
// The proof, as it comes off the wire (hex strings)

export interface BulletproofPlus {
  A: string; A1: string; B: string;
  r1: string; s1: string; d1: string;
  L: string[]; R: string[];
}

/**
 * Verify a Bulletproof+ over the given output commitments.
 *
 * `commitments` are the outputs' Pedersen commitments (`outPk` on the wire),
 * as 32-byte hex. Returns true exactly when the proof is a valid range proof
 * for them. Written from the public data only; it never sees an amount or a
 * mask, which is the entire point of a range proof.
 *
 * A single proof is verified with weight 1: the reference's batch weighting
 * scales the whole multiscalar sum, so for one proof any nonzero weight gives
 * the same accept/reject, and 1 makes it deterministic.
 */
export function verifyBulletproofPlus(commitments: readonly string[], proof: BulletproofPlus): boolean {
  try {
    const nV = commitments.length;
    if (nV < 1) return false;
    if (proof.L.length !== proof.R.length || proof.L.length === 0) return false;

    /* The commitment on the wire is `outPk`, which the network stores as `8·V`.
     * So `V8` (the point the multiscalar equation calls `8·V`) is `outPk`
     * itself, and the offset `V` that feeds the transcript is `outPk·inv8`. */
    const commitPoints = commitments.map((c) => Point.fromBytes(fromHex(c)));
    const V8 = commitPoints;
    const Vwire = commitPoints.map((p) => p.multiplyUnsafe(INV8));

    const Awire = fromHex(proof.A), A1wire = fromHex(proof.A1), Bwire = fromHex(proof.B);
    const Lwire = proof.L.map(fromHex), Rwire = proof.R.map(fromHex);

    // Rescale the offset proof elements into the prime-order subgroup.
    const A8 = Point.fromBytes(Awire).multiplyUnsafe(8n);
    const A18 = Point.fromBytes(A1wire).multiplyUnsafe(8n);
    const B8 = Point.fromBytes(Bwire).multiplyUnsafe(8n);
    const L8 = Lwire.map((b) => Point.fromBytes(b).multiplyUnsafe(8n));
    const R8 = Rwire.map((b) => Point.fromBytes(b).multiplyUnsafe(8n));

    const r1 = b2s(fromHex(proof.r1)), s1 = b2s(fromHex(proof.s1)), d1 = b2s(fromHex(proof.d1));

    // --- Reconstruct the Fiat-Shamir challenges ---
    let transcript = INITIAL_TRANSCRIPT;
    transcript = tu(transcript, hashScalar(...Vwire.map((p) => p.toBytes())));
    const y = b2s(tu(transcript, Awire));
    if (y === 0n) return false;
    let t = s2b(y);
    const z = b2s(hashScalar(t));           // transcript = hash_to_scalar(y)
    if (z === 0n) return false;
    t = s2b(z);

    // logM: smallest with 2^logM >= nV
    let logM = 0;
    while ((1 << logM) <= MAX_M && (1 << logM) < nV) logM++;
    if (proof.L.length !== 6 + logM) return false;
    const rounds = logM + LOG_N;
    const M = 1 << logM;
    const MN = M * N;

    const challenges: bigint[] = [];
    for (let j = 0; j < rounds; j++) {
      t = tu(t, Lwire[j]!, Rwire[j]!);
      const c = b2s(t);
      if (c === 0n) return false;
      challenges.push(c);
    }
    const e = b2s(tu(t, A1wire, Bwire));
    if (e === 0n) return false;

    // --- Weighted batch data (weight = 1) ---
    const weight = 1n;
    const eSquared = mul(e, e);
    const zSquared = mul(z, z);
    const yinv = inv(y);
    const challengesInv = challenges.map(inv);

    // y^MN and y^(MN+1)
    let yMN = y;
    for (let m = MN; m > 1; m = Math.floor(m / 2)) yMN = mul(yMN, yMN);
    const yMN1 = mul(yMN, y);

    const terms: { scalar: bigint; point: EdPoint }[] = [];

    // V_j: -e^2 * z^(2(j+1)) * y^(MN+1) * weight
    let vCoeff = mul(mul(sub(0n, eSquared), yMN1), weight);
    for (let j = 0; j < V8.length; j++) {
      vCoeff = mul(vCoeff, zSquared);
      terms.push({ scalar: vCoeff, point: V8[j]! });
    }

    // B: -weight ; A1: -weight*e ; A: -weight*e^2
    let tmp = mul(sub(0n, 1n), weight);
    terms.push({ scalar: tmp, point: B8 });
    tmp = mul(tmp, e);
    terms.push({ scalar: tmp, point: A18 });
    const minusWeightESquared = mul(tmp, e);
    terms.push({ scalar: minusWeightESquared, point: A8 });

    // G: weight*d1
    let gScalar = mul(weight, d1);

    // Windowed vector d[j*N+i] = z^(2(j+1)) * 2^i
    const d = new Array<bigint>(MN).fill(0n);
    d[0] = zSquared;
    for (let i = 1; i < N; i++) d[i] = add(d[i - 1]!, d[i - 1]!);
    for (let j = 1; j < M; j++) for (let i = 0; i < N; i++) d[j * N + i] = mul(d[(j - 1) * N + i]!, zSquared);

    // H scalar
    const sumD = mul(TWO_64_MINUS_1, sumOfEvenPowers(z, 2 * M));
    const sumY = sumOfScalarPowers(y, MN);
    let hInner = mul(sub(zSquared, z), sumY);
    hInner = add(hInner, mul(mul(yMN1, z), sumD));
    hInner = mul(hInner, eSquared);
    hInner = add(hInner, mul(mul(r1, y), s1));
    let hScalar = mul(hInner, weight);

    // challenge product cache
    const cache = new Array<bigint>(1 << rounds).fill(0n);
    cache[0] = challengesInv[0]!;
    cache[1] = challenges[0]!;
    for (let j = 1; j < rounds; j++) {
      const slots = 1 << (j + 1);
      for (let s = slots; s-- > 0; --s) {
        cache[s] = mul(cache[s >> 1]!, challenges[j]!);
        cache[s - 1] = mul(cache[s >> 1]!, challengesInv[j]!);
      }
    }

    // Gi / Hi scalars
    const giScalars = new Array<bigint>(MN).fill(0n);
    const hiScalars = new Array<bigint>(MN).fill(0n);
    let eR1WY = mul(mul(e, r1), weight);
    const eS1W = mul(mul(e, s1), weight);
    const eSquaredZW = mul(mul(eSquared, z), weight);
    const minusESquaredZW = sub(0n, eSquaredZW);
    let minusESquaredWY = mul(mul(sub(0n, eSquared), weight), yMN);
    for (let i = 0; i < MN; i++) {
      let g = eR1WY;
      g = muladd(g, cache[i]!, eSquaredZW);
      giScalars[i] = add(giScalars[i]!, g);
      let h = muladd(eS1W, cache[(~i) & (MN - 1)]!, minusESquaredZW);
      h = muladd(minusESquaredWY, d[i]!, h);
      hiScalars[i] = add(hiScalars[i]!, h);
      eR1WY = mul(eR1WY, yinv);
      minusESquaredWY = mul(minusESquaredWY, yinv);
    }

    // L_j / R_j
    for (let j = 0; j < rounds; j++) {
      terms.push({ scalar: mul(mul(challenges[j]!, challenges[j]!), minusWeightESquared), point: L8[j]! });
      terms.push({ scalar: mul(mul(challengesInv[j]!, challengesInv[j]!), minusWeightESquared), point: R8[j]! });
    }

    // Assemble the full multiscalar sum and check it is the identity.
    terms.push({ scalar: gScalar, point: G });
    terms.push({ scalar: hScalar, point: H });
    for (let i = 0; i < MN; i++) {
      terms.push({ scalar: giScalars[i]!, point: Gi(i) });
      terms.push({ scalar: hiScalars[i]!, point: Hi(i) });
    }

    let acc = Point.ZERO;
    for (const term of terms) {
      const s = ((term.scalar % L) + L) % L;
      if (s === 0n) continue;
      acc = acc.add(term.point.multiplyUnsafe(s));
    }
    return acc.is0();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The prover
// ---------------------------------------------------------------------------

/** A weighted sum of points; zero scalars are skipped, so terms may carry them. */
function msum(terms: readonly { scalar: bigint; point: EdPoint }[]): EdPoint {
  let acc = Point.ZERO;
  for (const term of terms) {
    const s = ((term.scalar % L) + L) % L;
    if (s === 0n) continue;
    acc = acc.add(term.point.multiplyUnsafe(s));
  }
  return acc;
}

/** a·P + b·Q, the two-term case the folds use. */
function fold2(a: bigint, P: EdPoint, b: bigint, Q: EdPoint): EdPoint {
  return msum([{ scalar: a, point: P }, { scalar: b, point: Q }]);
}

/**
 * How many 32-byte random scalars `proveBulletproofPlus` consumes for a given
 * number of amounts: alpha, then dL and dR per inner-product round, then
 * r, s, d, eta at the end.
 */
export function bppRandomCount(nAmounts: number): number {
  let logM = 0;
  while ((1 << logM) < nAmounts) logM++;
  return 1 + 2 * (logM + LOG_N) + 4;
}

export interface BulletproofPlusProof {
  proof: BulletproofPlus;
  /** The offset commitments `V` the proof is over; `outPk[i]` is `8·V[i]`. */
  V: string[];
}

/**
 * Prove that each amount is in `[0, 2^64)`, without revealing any of them.
 *
 * Transcribed from `bulletproof_plus_PROVE` in `bulletproofs_plus.cc`. The
 * commitment for amount `i` is `masks[i]·G + amounts[i]·H` (what `commit`
 * produces, and what goes on the wire as `outPk`); the proof itself carries
 * everything else. `randomScalars` supplies the blinding scalars, exactly
 * `bppRandomCount(amounts.length)` of them, injected rather than drawn here
 * for the same reason `clsagSign` does it: the caller owns the entropy source,
 * and the tests can replay one.
 *
 * The proof this returns is checked by `verifyBulletproofPlus`, and that
 * verifier is anchored against real mainnet proofs. That chain is the whole
 * argument for this prover: it is not verified against itself, it is verified
 * against a verifier that agrees with consensus.
 *
 * The reference retries its transcript on a zero challenge; at 256 bits that
 * is a probability of roughly 2^-252 per draw, so this throws instead of
 * retrying, and a thrown proof is a proof that was never produced.
 */
export function proveBulletproofPlus(
  amounts: readonly bigint[],
  masks: readonly Uint8Array[],
  randomScalars: readonly Uint8Array[],
): BulletproofPlusProof {
  if (amounts.length === 0) throw new Error('Nothing to prove.');
  if (amounts.length !== masks.length) throw new Error('Each amount needs exactly one mask.');
  if (amounts.length > MAX_M) throw new Error(`At most ${MAX_M} amounts per proof.`);
  for (const amount of amounts) {
    if (amount < 0n || amount >= 2n ** 64n) throw new Error('An amount is outside [0, 2^64), which is the range being proven.');
  }
  const need = bppRandomCount(amounts.length);
  if (randomScalars.length !== need) throw new Error(`Proving over ${amounts.length} amounts needs exactly ${need} random scalars.`);
  let drawAt = 0;
  const draw = (): bigint => {
    const s = b2s(randomScalars[drawAt++]!);
    if (s === 0n) throw new Error('A supplied random scalar reduced to zero.');
    return s;
  };

  let logM = 0;
  while ((1 << logM) < amounts.length) logM++;
  const M = 1 << logM;
  const MN = M * N;

  const gammas = masks.map(b2s);

  // V[i] = (gamma·inv8)·G + (amount·inv8)·H, the offset commitment on the wire.
  const V: EdPoint[] = amounts.map((amount, i) =>
    msum([
      { scalar: mul(gammas[i]!, INV8), point: G },
      { scalar: mul(amount % L, INV8), point: H },
    ]),
  );
  const Vwire = V.map((p) => p.toBytes());

  /* Bit decomposition, padded to M amounts: aL is the bits, aR is aL - 1,
   * and the 8^-1-scaled copies are what the commitment A is built from. */
  const aL = new Array<bigint>(MN).fill(0n);
  const aR = new Array<bigint>(MN).fill(0n);
  const aL8 = new Array<bigint>(MN).fill(0n);
  const aR8 = new Array<bigint>(MN).fill(0n);
  const MINUS_ONE = sub(0n, 1n);
  const MINUS_INV8 = sub(0n, INV8);
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < N; i++) {
      if (j < amounts.length && ((amounts[j]! >> BigInt(i)) & 1n) === 1n) {
        aL[j * N + i] = 1n;
        aL8[j * N + i] = INV8;
      } else {
        aR[j * N + i] = MINUS_ONE;
        aR8[j * N + i] = MINUS_INV8;
      }
    }
  }

  // --- Fiat-Shamir, mirrored exactly by the verifier ---
  let transcript = tu(INITIAL_TRANSCRIPT, hashScalar(...Vwire));

  const alpha = draw();
  const preATerms: { scalar: bigint; point: EdPoint }[] = [];
  for (let i = 0; i < MN; i++) {
    preATerms.push({ scalar: aL8[i]!, point: Gi(i) });
    preATerms.push({ scalar: aR8[i]!, point: Hi(i) });
  }
  preATerms.push({ scalar: mul(alpha, INV8), point: G });
  const Awire = msum(preATerms).toBytes();

  transcript = tu(transcript, Awire);
  const y = b2s(transcript);
  if (y === 0n) throw new Error('The challenge y is zero.');
  const z = b2s(hashScalar(s2b(y)));
  if (z === 0n) throw new Error('The challenge z is zero.');
  transcript = s2b(z);
  const zSquared = mul(z, z);

  // d[j·N+i] = z^(2(j+1)) · 2^i
  const d = new Array<bigint>(MN).fill(0n);
  d[0] = zSquared;
  for (let i = 1; i < N; i++) d[i] = mul(d[i - 1]!, 2n);
  for (let j = 1; j < M; j++) for (let i = 0; i < N; i++) d[j * N + i] = mul(d[(j - 1) * N + i]!, zSquared);

  // Powers of y up to y^(MN+1).
  const yPowers = new Array<bigint>(MN + 2).fill(0n);
  yPowers[0] = 1n;
  for (let i = 1; i <= MN + 1; i++) yPowers[i] = mul(yPowers[i - 1]!, y);

  // aL1 = aL - z ; aR1 = aR + z + d∘(reversed y powers)
  let aprime = aL.map((v) => sub(v, z));
  let bprime = aR.map((v, i) => add(add(v, z), mul(d[i]!, yPowers[MN - i]!)));

  let alpha1 = alpha;
  let zPow = 1n;
  for (let j = 0; j < amounts.length; j++) {
    zPow = mul(zPow, zSquared);
    alpha1 = muladd(mul(yPowers[MN + 1]!, zPow), gammas[j]!, alpha1);
  }

  const yinv = inv(y);
  const yinvPow = new Array<bigint>(MN).fill(0n);
  yinvPow[0] = 1n;
  for (let i = 1; i < MN; i++) yinvPow[i] = mul(yinvPow[i - 1]!, yinv);

  let Gprime: EdPoint[] = [];
  let Hprime: EdPoint[] = [];
  for (let i = 0; i < MN; i++) { Gprime.push(Gi(i)); Hprime.push(Hi(i)); }

  const Lwire: Uint8Array[] = [];
  const Rwire: Uint8Array[] = [];

  /* Weighted inner product: sum a[i]·b[i]·y^(i+1). */
  const wip = (a: readonly bigint[], b: readonly bigint[]): bigint => {
    let res = 0n;
    let yPower = 1n;
    for (let i = 0; i < a.length; i++) {
      yPower = mul(yPower, y);
      res = muladd(mul(a[i]!, b[i]!), yPower, res);
    }
    return res;
  };

  let nprime = MN;
  while (nprime > 1) {
    nprime = Math.floor(nprime / 2);

    const cL = wip(aprime.slice(0, nprime), bprime.slice(nprime));
    const cR = wip(aprime.slice(nprime).map((v) => mul(v, yPowers[nprime]!)), bprime.slice(0, nprime));

    const dL = draw();
    const dR = draw();

    /* compute_LR: the scaled halves of aprime/bprime over the offset halves of
     * the generators, plus the inner product on H and the blind on G, all
     * carried at 8^-1 so the verifier's multiply-by-8 lands them where the
     * equation wants them. */
    const lTerms: { scalar: bigint; point: EdPoint }[] = [];
    const rTerms: { scalar: bigint; point: EdPoint }[] = [];
    for (let i = 0; i < nprime; i++) {
      lTerms.push({ scalar: mul(mul(aprime[i]!, yinvPow[nprime]!), INV8), point: Gprime[nprime + i]! });
      lTerms.push({ scalar: mul(bprime[nprime + i]!, INV8), point: Hprime[i]! });
      rTerms.push({ scalar: mul(mul(aprime[nprime + i]!, yPowers[nprime]!), INV8), point: Gprime[i]! });
      rTerms.push({ scalar: mul(bprime[i]!, INV8), point: Hprime[nprime + i]! });
    }
    lTerms.push({ scalar: mul(cL, INV8), point: H }, { scalar: mul(dL, INV8), point: G });
    rTerms.push({ scalar: mul(cR, INV8), point: H }, { scalar: mul(dR, INV8), point: G });
    const Lr = msum(lTerms).toBytes();
    const Rr = msum(rTerms).toBytes();
    Lwire.push(Lr);
    Rwire.push(Rr);

    transcript = tu(transcript, Lr, Rr);
    const challenge = b2s(transcript);
    if (challenge === 0n) throw new Error('An inner-product challenge is zero.');
    const challengeInv = inv(challenge);

    const gFold = mul(yinvPow[nprime]!, challenge);
    const nextG: EdPoint[] = [];
    const nextH: EdPoint[] = [];
    for (let i = 0; i < nprime; i++) {
      nextG.push(fold2(challengeInv, Gprime[i]!, gFold, Gprime[nprime + i]!));
      nextH.push(fold2(challenge, Hprime[i]!, challengeInv, Hprime[nprime + i]!));
    }
    Gprime = nextG;
    Hprime = nextH;

    const aFold = mul(challengeInv, yPowers[nprime]!);
    const nextA: bigint[] = [];
    const nextB: bigint[] = [];
    for (let i = 0; i < nprime; i++) {
      nextA.push(add(mul(aprime[i]!, challenge), mul(aprime[nprime + i]!, aFold)));
      nextB.push(add(mul(bprime[i]!, challengeInv), mul(bprime[nprime + i]!, challenge)));
    }
    aprime = nextA;
    bprime = nextB;

    alpha1 = muladd(dL, mul(challenge, challenge), alpha1);
    alpha1 = muladd(dR, mul(challengeInv, challengeInv), alpha1);
  }

  // --- Final round ---
  const r = draw();
  const s = draw();
  const dScalar = draw();
  const eta = draw();

  const A1wire = msum([
    { scalar: mul(r, INV8), point: Gprime[0]! },
    { scalar: mul(s, INV8), point: Hprime[0]! },
    { scalar: mul(dScalar, INV8), point: G },
    { scalar: mul(add(mul(mul(r, y), bprime[0]!), mul(mul(s, y), aprime[0]!)), INV8), point: H },
  ]).toBytes();

  const Bwire = msum([
    { scalar: mul(eta, INV8), point: G },
    { scalar: mul(mul(mul(r, y), s), INV8), point: H },
  ]).toBytes();

  transcript = tu(transcript, A1wire, Bwire);
  const e = b2s(transcript);
  if (e === 0n) throw new Error('The final challenge e is zero.');
  const eSquared = mul(e, e);

  const r1 = muladd(aprime[0]!, e, r);
  const s1 = muladd(bprime[0]!, e, s);
  const d1 = muladd(alpha1, eSquared, muladd(dScalar, e, eta));

  return {
    proof: {
      A: toHex(Awire),
      A1: toHex(A1wire),
      B: toHex(Bwire),
      r1: toHex(s2b(r1)),
      s1: toHex(s2b(s1)),
      d1: toHex(s2b(d1)),
      L: Lwire.map(toHex),
      R: Rwire.map(toHex),
    },
    V: Vwire.map(toHex),
  };
}
