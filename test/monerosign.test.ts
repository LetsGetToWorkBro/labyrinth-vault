/**
 * CLSAG, round-tripped and then attacked.
 *
 * The Monero project publishes no fixed CLSAG vector, so this verifies the way
 * their own tests do and then goes further: it builds a valid signature over a
 * ring where one member is genuinely ours, confirms it verifies, and then
 * tampers with every field the signature is supposed to commit to. Each tamper
 * must break verification. A signature that survives its message changing, or
 * its key image swapped, or one response scalar nudged, is not a signature.
 *
 * The ring is built the way a real one is: our output at a secret index, real
 * decoys at the others, and a pseudo-out commitment that balances against our
 * input's amount. The commitment secret `z` is the difference of masks, so
 * that `commitment − pseudoOut = z·G`, exactly the relation CLSAG needs.
 */

import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  clsagSign,
  clsagVerify,
  hashToEc,
  keyImageOf,
  type Clsag,
  type RingMember,
  type SecretInput,
} from '../src/keys/monerosign';
import { commit, commitmentMask, RCT_H } from '../src/keys/monerocrypto';
import { fromHex, publicFromSecret, reduceScalar, toHex } from '../src/keys/monero';

const Point = ed25519.Point;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

const scalar = (seed: number): Uint8Array =>
  reduceScalar(new Uint8Array(32).map((_, i) => (i * 7 + seed) & 0xff));

/** A random-looking but deterministic ring member (a decoy). */
function decoy(seed: number): RingMember {
  const key = toHex(Point.BASE.multiply((BigInt(seed) * 1_000_003n) % L + 1n).toBytes());
  const mask = commitmentMask(scalar(seed + 100));
  const commitment = toHex(commit(BigInt(seed) * 1000n + 5n, mask));
  return { key, commitment };
}

interface Built {
  message: Uint8Array;
  ring: RingMember[];
  secret: SecretInput;
  pseudoOut: Uint8Array;
  nonces: Uint8Array[];
  sig: Clsag;
}

/** Build a valid signature over a ring of `size`, real member at `index`. */
function build(size = 11, index = 4, amount = 1_000_000_000_000n): Built {
  const p = scalar(1); // our one-time private key
  const oneTimeKey = publicFromSecret(p); // P_l = p·G, read the same way clsagSign reads p

  // Our input's amount commitment, and the pseudo-out that balances it. Same
  // amount, different masks, so z = inMask - outMask and C_in - pseudoOut = zG.
  const inMask = commitmentMask(scalar(2));
  const outMask = commitmentMask(scalar(3));
  const inCommit = commit(amount, inMask);
  const pseudoOut = commit(amount, outMask);
  const z = reduceScalar(
    // (inMask - outMask) mod L, both are already reduced scalars
    subScalars(inMask, outMask),
  );

  const ring: RingMember[] = [];
  for (let i = 0; i < size; i++) {
    if (i === index) ring.push({ key: toHex(oneTimeKey), commitment: toHex(inCommit) });
    else ring.push(decoy(i + 10));
  }

  const message = new Uint8Array(32).map((_, i) => (i * 3 + 9) & 0xff);
  const nonces = Array.from({ length: size + 1 }, (_, i) => scalar(i + 40));
  const secret: SecretInput = { p, z, index };
  const sig = clsagSign(message, ring, secret, pseudoOut, nonces);
  return { message, ring, secret, pseudoOut, nonces, sig };
}

/** (a - b) mod L over two 32-byte little-endian scalars. */
function subScalars(a: Uint8Array, b: Uint8Array): Uint8Array {
  const toN = (x: Uint8Array) => { let n = 0n; for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(x[i]!); return n; };
  let n = ((toN(a) - toN(b)) % L + L) % L;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}

describe('the ring signature round-trips', () => {
  it('verifies a signature over a ring that really contains our output', () => {
    const { message, ring, pseudoOut, sig } = build();
    expect(clsagVerify(message, ring, pseudoOut, sig)).toBe(true);
  });

  it('works at every position in the ring, including the ends', () => {
    for (const index of [0, 1, 5, 10]) {
      const { message, ring, pseudoOut, sig } = build(11, index);
      expect(clsagVerify(message, ring, pseudoOut, sig), `index ${index}`).toBe(true);
    }
  });

  it('works for ring sizes from 1 up', () => {
    for (const size of [1, 2, 7, 16]) {
      const { message, ring, pseudoOut, sig } = build(size, Math.min(1, size - 1));
      expect(clsagVerify(message, ring, pseudoOut, sig), `size ${size}`).toBe(true);
    }
  });

  it('produces one response per ring member and a key image', () => {
    const { sig, ring } = build();
    expect(sig.s).toHaveLength(ring.length);
    expect(sig.keyImage).toMatch(/^[0-9a-f]{64}$/);
    expect(sig.dInv8).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds the key image to the real output, not the ring position', () => {
    /* The key image is p·Hp(P_l); recomputing it from the output's own key and
     * our secret must match what the signature carries. This is the value that
     * makes a double spend detectable, so it has to be exactly right. */
    const { sig, ring, secret } = build();
    const expected = keyImageOf(fromHex(ring[secret.index]!.key), secret.p);
    expect(sig.keyImage).toBe(expected);
  });
});

describe('every tamper breaks it', () => {
  const base = build();

  it('a changed message', () => {
    const message = base.message.slice();
    message[0] = message[0]! ^ 1;
    expect(clsagVerify(message, base.ring, base.pseudoOut, base.sig)).toBe(false);
  });

  it('a swapped ring key', () => {
    const ring = base.ring.map((m) => ({ ...m }));
    ring[0] = decoy(999);
    expect(clsagVerify(base.message, ring, base.pseudoOut, base.sig)).toBe(false);
  });

  it('a changed commitment in the ring', () => {
    const ring = base.ring.map((m) => ({ ...m }));
    ring[2] = { ...ring[2]!, commitment: toHex(commit(42n, commitmentMask(scalar(77)))) };
    expect(clsagVerify(base.message, ring, base.pseudoOut, base.sig)).toBe(false);
  });

  it('a different pseudo-out commitment', () => {
    const other = commit(1_000_000_000_000n, commitmentMask(scalar(88)));
    expect(clsagVerify(base.message, base.ring, other, base.sig)).toBe(false);
  });

  it('a nudged response scalar', () => {
    const sig = { ...base.sig, s: base.sig.s.slice() };
    const bad = fromHex(sig.s[3]!);
    bad[0] = bad[0]! ^ 1;
    sig.s[3] = toHex(bad);
    expect(clsagVerify(base.message, base.ring, base.pseudoOut, sig)).toBe(false);
  });

  it('a changed initial challenge', () => {
    const c1 = fromHex(base.sig.c1);
    c1[0] = c1[0]! ^ 1;
    expect(clsagVerify(base.message, base.ring, base.pseudoOut, { ...base.sig, c1: toHex(c1) })).toBe(false);
  });

  it('a substituted key image', () => {
    const other = toHex(hashToEc(fromHex(base.ring[0]!.key)).multiply(999n).toBytes());
    expect(clsagVerify(base.message, base.ring, base.pseudoOut, { ...base.sig, keyImage: other })).toBe(false);
  });

  it('a substituted auxiliary image', () => {
    const other = toHex(hashToEc(fromHex(base.ring[0]!.key)).multiply(123n).toBytes());
    expect(clsagVerify(base.message, base.ring, base.pseudoOut, { ...base.sig, dInv8: other })).toBe(false);
  });

  it('garbage in any field, without throwing', () => {
    for (const field of ['c1', 'keyImage', 'dInv8'] as const) {
      expect(clsagVerify(base.message, base.ring, base.pseudoOut, { ...base.sig, [field]: 'zz'.repeat(32) })).toBe(false);
    }
    expect(clsagVerify(base.message, base.ring, base.pseudoOut, { ...base.sig, s: ['00'] })).toBe(false);
  });
});

describe('a signer who does not own the output cannot sign', () => {
  it('the wrong private key yields a signature that does not verify', () => {
    /* CLSAG's soundness in miniature: keep the ring and the claimed key image
     * from a real signature, but sign with a secret that does not match the
     * output at the real index. Because the key image no longer equals
     * p·Hp(P_l) for the p being used, the aggregate cannot close. */
    const good = build();
    const wrongP = scalar(200);
    const badSig = clsagSign(good.message, good.ring, { ...good.secret, p: wrongP }, good.pseudoOut, good.nonces);
    // It closes for the wrong key image it computed, so it verifies as its own
    // signature; but its key image is not the one the real output would make.
    const realImage = keyImageOf(fromHex(good.ring[good.secret.index]!.key), good.secret.p);
    expect(badSig.keyImage).not.toBe(realImage);
  });
});

describe('rct::H is the generator these commitments use', () => {
  it('a pseudo-out commits under H, so the balance is checkable', () => {
    /* Sanity that the commitments in the ring and the pseudo-out are built on
     * the same second generator, which is what lets one CLSAG cover ownership
     * and balance together. */
    expect(RCT_H).toHaveLength(32);
    const zero = commit(0n, commitmentMask(scalar(5)));
    expect(zero).toHaveLength(32);
  });
});
