/**
 * Monero's six core operations, and the one piece of curve arithmetic that
 * cannot be borrowed.
 *
 * ## Why this file exists
 *
 * Everything in `monero.ts` is about holding a key: derive it, encode it into
 * an address, write it down as words. None of that is enough to *spend*, and
 * spending is where Monero stops resembling Bitcoin. To find out that a
 * transaction paid you, a wallet has to run the sender's ephemeral key through
 * a Diffie-Hellman step and re-derive the one-time output key. To spend that
 * output it has to produce a key image, which is a second point derived from
 * the same key by a completely different route, and which the network uses to
 * notice a double spend without ever learning which output was spent.
 *
 * Those are the operations here. They are the floor under any Monero
 * transaction the vault could ever sign, and until they are right and pinned
 * to somebody else's answers there is no honest way to build the rest.
 *
 * ## What is trusted and what is written
 *
 * Keccak-256 and ed25519 group arithmetic come from @noble, which is audited.
 * Scalar reduction and encoding come from `monero.ts`, which is tested.
 *
 * One thing had to be written, and it is worth naming plainly:
 * `ge_fromfe_frombytes_vartime`, the map from 32 arbitrary bytes onto a curve
 * point that Monero uses to build key images. It predates the standard
 * hash-to-curve constructions, no audited library implements it, and there is
 * no way to express it in terms of anything that does. So it is transcribed
 * from `crypto-ops.c` below, in the same order, with the branches in the same
 * shape.
 *
 * Transcribed code is exactly the kind of code that is quietly wrong, so it is
 * not trusted at all: `test/monerocrypto.test.ts` runs it against 120 vectors
 * taken verbatim from the Monero project's own `tests/crypto/tests.txt`, plus
 * 120 each for the other five operations. A key image is the value that stops
 * a double spend; wrong by one operation, it is a transaction the network
 * rejects, or worse, one that links two spends that were meant to be
 * unlinkable.
 *
 * ## What this is not
 *
 * It is not transaction signing. CLSAG ring signatures and Bulletproofs+ range
 * proofs are the other half and neither is here. See
 * `docs/monero-signing.md` for what is missing and why it is not being guessed
 * at.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { reduceScalar } from './monero';

const Point = ed25519.Point;

/** The field this all happens in. */
const P = 2n ** 255n - 19n;

/** The order of the prime-order subgroup, for scalars. */
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

const mod = (n: bigint): bigint => ((n % P) + P) % P;

// ---------------------------------------------------------------------------
// Bytes and field elements
// ---------------------------------------------------------------------------

/* Little-endian, because that is how everything in Monero is stored. Local
 * copies rather than exports from monero.ts: these are two four-line functions
 * and widening that module's surface to share them would be the worse trade. */

function toBigIntLE(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}

function fromBigIntLE(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let n = value;
  for (let i = 0; i < length; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function invert(n: bigint): bigint {
  if (mod(n) === 0n) throw new Error('That value has no inverse in the field.');
  return pow(n, P - 2n);
}

function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

function expect32(bytes: Uint8Array, what: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new Error(`A ${what} is 32 bytes.`);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// The constants ge_fromfe_frombytes_vartime needs
// ---------------------------------------------------------------------------

/**
 * These are square roots of fixed quantities in the field, given in
 * `crypto-ops.c` as pre-reduced limb arrays that are unreadable and impossible
 * to check by eye. They are written here as plain integers, and
 * `test/monerocrypto.test.ts` squares each one and checks it against the
 * expression it is supposed to be a root of, so they are proved rather than
 * copied.
 *
 * A square root has two values and only one appears here. For FFFB1..4 that
 * does not matter: each is used as a factor on the x coordinate, whose sign is
 * forced at the end of the routine, so choosing the other root produces the
 * same point. For SQRT_M1 it does matter — it selects which branch is taken —
 * and the value below is the canonical ed25519 one, 2^((p-1)/4).
 */
const SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n;

/** -A, where A = 486662 is the Montgomery curve coefficient. */
const MA = mod(-486662n);
/** -A². */
const MA2 = mod(-486662n * 486662n);

/** sqrt(-2·A·(A+2)) */
const FFFB1 = 703233174040119856926594035342289954908528790615891058923819529064776187391n;
/** sqrt(2·A·(A+2)) */
const FFFB2 = 23057146872909699840411355416938605094565363926207269214935344372714976797965n;
/** sqrt(-i·A·(A+2)), i = SQRT_M1 */
const FFFB3 = 46719087769223307720043111813545796356806574765024592941723029582131464514662n;
/** sqrt(i·A·(A+2)) */
const FFFB4 = 46015854595183187863116517778203506401898045974408701882799210053066688327271n;

/** For the test, which proves each constant instead of trusting the literal. */
export const FIELD_CONSTANTS = {
  P,
  L,
  SQRT_M1,
  MA,
  MA2,
  FFFB1,
  FFFB2,
  FFFB3,
  FFFB4,
  A: 486662n,
} as const;

/**
 * `fe_divpowm1(w, x)` — (w/x) raised to (p+3)/8.
 *
 * The C version computes it as `(w·x⁷)^((p-5)/8) · x³ · w` to avoid an
 * inversion, which is the same value by Fermat and much less obvious. Written
 * the direct way here: an inversion is one exponentiation and this is not a
 * hot loop.
 */
function divpowm1(w: bigint, x: bigint): bigint {
  return pow(mod(w * invert(x)), (P + 3n) / 8n);
}

// ---------------------------------------------------------------------------
// ge_fromfe_frombytes_vartime
// ---------------------------------------------------------------------------

interface Projective {
  X: bigint;
  Y: bigint;
  Z: bigint;
}

/**
 * 32 arbitrary bytes to a curve point, Monero's way.
 *
 * A transcription of `ge_fromfe_frombytes_vartime` in `crypto-ops.c`, an
 * Elligator-style map: read the bytes as a field element, build a Montgomery
 * x-coordinate from it, take a square root, and convert to Edwards form. The
 * three-way branch is the square root not always existing on the first try.
 *
 * Two details that are easy to lose and that the vectors would catch:
 *
 *   - the input is read as a full 256-bit little-endian integer reduced mod p.
 *     The ordinary `fe_frombytes` masks the top bit off first; this one does
 *     not, and a masked version agrees with it 255 times out of 256.
 *   - the result is *not* in the prime-order subgroup. That is deliberate and
 *     `hashToEc` multiplies by the cofactor 8 afterwards. Anything that treats
 *     this point as a public key will be wrong.
 */
function fromfe(bytes: Uint8Array): Projective {
  const u = toBigIntLE(expect32(bytes, 'hash')) % P;

  const v = mod(2n * u * u); //  2u²
  const w = mod(v + 1n); //      2u² + 1
  let x = mod(w * w + MA2 * v); // w² − 2A²u²

  let rX = divpowm1(w, x); // (w/x)^((p+3)/8)
  let y = mod(rX * rX);
  x = mod(y * x);
  y = mod(w - x);

  let z = MA;
  let sign: bigint;

  if (y !== 0n) {
    y = mod(w + x);
    if (y !== 0n) {
      // The square root did not exist; take it in the twisted case instead.
      x = mod(x * SQRT_M1);
      y = mod(w - x);
      /* The C code asserts w + x is zero here when w − x is not. There is
       * nothing to do about it if that ever failed, and the assert compiles
       * out of release builds anyway, so it is left to the vectors. */
      rX = mod(rX * (y !== 0n ? FFFB3 : FFFB4));
      sign = 1n;
      // z stays -A, and rX is not multiplied by u in this branch.
    } else {
      rX = mod(rX * FFFB1);
      rX = mod(rX * u);
      z = mod(z * v);
      sign = 0n;
    }
  } else {
    rX = mod(rX * FFFB2);
    rX = mod(rX * u);
    z = mod(z * v);
    sign = 0n;
  }

  if ((rX & 1n) !== sign) rX = mod(-rX);

  const Z = mod(z + w);
  const Y = mod(z - w);
  const X = mod(rX * Z);
  return { X, Y, Z };
}

/** Projective to the 32-byte ed25519 encoding: y, with x's low bit on top. */
function encodePoint(point: Projective): Uint8Array {
  const iz = invert(point.Z);
  const x = mod(point.X * iz);
  const y = mod(point.Y * iz);
  const out = fromBigIntLE(y, 32);
  out[31] = out[31]! | (Number(x & 1n) << 7);
  return out;
}

// ---------------------------------------------------------------------------
// The six operations
// ---------------------------------------------------------------------------

/**
 * `hash_to_scalar`: Keccak the input, then bring it into the scalar field.
 *
 * The reduction is not cosmetic. Skipping it produces a value that is a valid
 * 32-byte string and not a valid scalar, and every implementation that does
 * reduce will disagree with this one about every number that follows.
 */
export function hashToScalar(data: Uint8Array): Uint8Array {
  return reduceScalar(keccak_256(data));
}

/**
 * `generate_key_derivation`: the shared secret between a transaction's public
 * key and your view key.
 *
 * This is the Diffie-Hellman step that makes a Monero wallet able to recognise
 * its own outputs without revealing anything to anybody watching. Multiplying
 * by 8 afterwards is Monero's, not ed25519's: it clears any small-order
 * component the sender's key might have carried, so two parties cannot be made
 * to compute different derivations from the same pair.
 */
export function generateKeyDerivation(publicKey: Uint8Array, secret: Uint8Array): Uint8Array {
  const point = Point.fromBytes(expect32(publicKey, 'public key'));
  const scalar = toBigIntLE(expect32(secret, 'secret key')) % L;
  if (scalar === 0n) throw new Error('That secret key is zero, which is not usable.');
  // Constant-time multiply: the scalar here is a view key.
  return point.multiply(scalar).multiplyUnsafe(8n).toBytes();
}

/** Monero's varint: seven bits a byte, high bit meaning "more follows". */
export function writeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new Error('An output index is a non-negative whole number.');
  }
  const out: number[] = [];
  let n = value;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Uint8Array.from(out);
}

/**
 * `derivation_to_scalar`: the derivation plus which output it is, hashed.
 *
 * The index is in the hash so that two outputs of the same transaction to the
 * same address do not produce the same one-time key. Leaving it out would make
 * them identical on the chain, which is the whole property Monero is for.
 */
export function derivationToScalar(derivation: Uint8Array, outputIndex: number): Uint8Array {
  expect32(derivation, 'derivation');
  const index = writeVarint(outputIndex);
  const buffer = new Uint8Array(32 + index.length);
  buffer.set(derivation, 0);
  buffer.set(index, 32);
  return hashToScalar(buffer);
}

/**
 * `derive_public_key`: the one-time address an output was actually paid to.
 *
 * This is the half a watching wallet can compute. If it equals the key in the
 * transaction, the output is yours.
 */
export function derivePublicKey(
  derivation: Uint8Array,
  outputIndex: number,
  base: Uint8Array,
): Uint8Array {
  const scalar = toBigIntLE(derivationToScalar(derivation, outputIndex));
  if (scalar === 0n) throw new Error('That derivation produced a zero scalar.');
  const basePoint = Point.fromBytes(expect32(base, 'public key'));
  return basePoint.add(Point.BASE.multiply(scalar)).toBytes();
}

/**
 * `derive_secret_key`: the matching half, which only the spender can compute.
 *
 * Takes the spend secret rather than the spend public key, and adds the same
 * scalar. The result is the private key of the one-time address above.
 */
export function deriveSecretKey(
  derivation: Uint8Array,
  outputIndex: number,
  baseSecret: Uint8Array,
): Uint8Array {
  expect32(baseSecret, 'secret key');
  const scalar = toBigIntLE(derivationToScalar(derivation, outputIndex));
  const sum = (toBigIntLE(baseSecret) + scalar) % L;
  return fromBigIntLE(sum, 32);
}

/**
 * `hash_to_point`: `ge_fromfe_frombytes_vartime` on its own, encoded.
 *
 * Exported because the Monero project publishes vectors for exactly this, with
 * no hashing and no cofactor multiplication around it, which lets the hardest
 * part of this file be tested in isolation. Nothing else should call it: the
 * point it returns has torsion and is not a public key.
 */
export function hashToPoint(bytes: Uint8Array): Uint8Array {
  return encodePoint(fromfe(bytes));
}

/** `hash_to_ec`: Keccak the key, map it onto the curve, clear the cofactor. */
function hashToEc(publicKey: Uint8Array): InstanceType<typeof Point> {
  const mapped = fromfe(keccak_256(expect32(publicKey, 'public key')));
  const iz = invert(mapped.Z);
  const point = Point.fromAffine({ x: mod(mapped.X * iz), y: mod(mapped.Y * iz) });
  return point.multiplyUnsafe(8n);
}

/**
 * `generate_key_image`: the value that stops a Monero output being spent
 * twice.
 *
 * Two different functions of the same key: the public key is `x·G`, and the
 * key image is `x·H(P)` for a point H(P) nobody can relate to G. The network
 * can therefore tell that two transactions spent the same output — the key
 * images match — while learning nothing about which output that was.
 *
 * The consequence of getting this wrong is not a rejected transaction, it is
 * worse than that: a key image that is wrong in a way that still verifies
 * would let the same output be spent twice, and a key image computed from the
 * wrong point could link spends that were supposed to be unlinkable. Hence
 * 120 published vectors rather than a round trip.
 */
export function generateKeyImage(publicKey: Uint8Array, secret: Uint8Array): Uint8Array {
  const scalar = toBigIntLE(expect32(secret, 'secret key')) % L;
  if (scalar === 0n) throw new Error('That secret key is zero, which is not usable.');
  // Constant-time: the scalar is a spend key.
  return hashToEc(publicKey).multiply(scalar).toBytes();
}

// ---------------------------------------------------------------------------
// Launch checks
// ---------------------------------------------------------------------------

export interface Check {
  name: string;
  proves: string;
  ok: boolean;
  detail: string;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function unhex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * One published vector per operation, run on the device.
 *
 * The full 720 live in the test suite; carrying all of them into the bundle
 * would cost a hundred kilobytes and several hundred milliseconds at every
 * launch to prove the same thing. What a single vector catches is the failure
 * that matters on a phone: a build where this code was replaced, or a JS
 * engine that does something different with BigInt than the one CI ran on.
 *
 * Every value below is from monero-project's `tests/crypto/tests.txt`.
 */
export function selfTest(): Check[] {
  const checks: Check[] = [];
  const add = (name: string, proves: string, run: () => [boolean, string]) => {
    try {
      const [ok, detail] = run();
      checks.push({ name, proves, ok, detail });
    } catch (error) {
      checks.push({ name, proves, ok: false, detail: (error as Error).message });
    }
  };

  add('Monero hash-to-scalar against the project vector', 'Every derived scalar starts here, and an unreduced one disagrees with every other wallet.', () => {
    const got = hex(hashToScalar(unhex('14b5ff33')));
    const want = '709162ee2552c852ba62d406efd369d65851777152c9df4b61a2c4e19190c408';
    return [got === want, got];
  });

  add('The output-scanning shared secret', 'The Diffie-Hellman step that finds your own outputs matches the reference implementation.', () => {
    const got = hex(generateKeyDerivation(
      unhex('fdfd97d2ea9f1c25df773ff2c973d885653a3ee643157eb0ae2b6dd98f0b6984'),
      unhex('eb2bd1cf0c5e074f9dbf38ebbc99c316f54e21803048c687a3bb359f7a713b02'),
    ));
    const want = '4e0bd2c41325a1b89a9f7413d4d05e0a5a4936f241dccc3c7d0c539ffe00ef67';
    return [got === want, got];
  });

  add('A one-time output key', 'The address an output was really paid to is computed the same way the network computes it.', () => {
    const got = hex(derivePublicKey(
      unhex('ca780b065e48091d910de90bcab2411db3d1a845e6d95cfd556af4138504c737'),
      217407,
      unhex('6d9dd2068b9d6d643b407e360dfc5eb7a1f628fe2de8112a9e5731e8b3680c39'),
    ));
    const want = 'd48008aff5f27d8fcdc2a3bf814ed3505530f598075f3bf7e868fea696b109f6';
    return [got === want, got];
  });

  add('Its matching private key', 'The spend half agrees with the watch half, or the output is unspendable.', () => {
    const got = hex(deriveSecretKey(
      unhex('0fc47054f355ced4d67de73bfa12e4c78ff19089548fffa7d07a674741860f97'),
      66,
      unhex('5619c62aa4ad787274b1071598b6ecacf4f9dacca2fd11b0c80741b744400500'),
    ));
    const want = '55297d64b0c0556d5583ce0e30c2024ccce90c93d16bdeb4e40fce7afff87803';
    return [got === want, got];
  });

  add('Bytes onto the curve, Monero\'s way', 'The transcribed Elligator map, the one piece of curve arithmetic written here rather than borrowed.', () => {
    const got = hex(hashToPoint(unhex('83efb774657700e37291f4b8dd10c839d1c739fd135c07a2fd7382334dafdd6a')));
    const want = '2789ecbaf36e4fcb41c6157228001538b40ca379464b718d830c58caae7ea4ca';
    return [got === want, got];
  });

  add('A key image', 'The value that stops a double spend, and that links two spends if it is wrong.', () => {
    const got = hex(generateKeyImage(
      unhex('e46b60ebfe610b8ba761032018471e5719bb77ea1cd945475c4a4abe7224bfd0'),
      unhex('981d477fb18897fa1f784c89721a9d600bf283f06b89cb018a077f41dcefef0f'),
    ));
    const want = 'a637203ec41eab772532d30420eac80612fce8e44f1758bc7e2cb1bdda815887';
    return [got === want, got];
  });

  return checks;
}
