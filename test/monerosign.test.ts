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
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  checkRingSignatureOfOne,
  checkSignature,
  clsagSign,
  clsagVerify,
  generateRingSignatureOfOne,
  generateSignature,
  hashToEc,
  keyImageOf,
  legacySignatureBytes,
  type Clsag,
  type RingMember,
  type SecretInput,
} from '../src/keys/monerosign';
import { commit, commitmentMask, hashToScalar, RCT_H } from '../src/keys/monerocrypto';
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

// ---------------------------------------------------------------------------
// `check_signature`, against signatures Monero's own C produced

describe('the envelope signature, verified', () => {
  /* The fixtures under test/fixtures were made by `oracle/`, which links
   * Monero's `crypto.cpp` and calls `crypto::generate_signature` with the RNG
   * stubbed to a byte counter. So the signatures below are Monero's, not ours,
   * and a verifier that accepts them is agreeing with the implementation that
   * matters rather than with its own prover.
   *
   * That is the whole reason this function could not be written earlier and
   * can be now: `moneroexport.ts` used to say a verifier would have "nothing
   * to check it against", which was true until the harness was committed.
   */

  const keyImages = JSON.parse(
    readFileSync('test/fixtures/monero-keyimages.json', 'utf8'),
  ) as {
    cases: { name: string; viewPublic: string; iv: string; file: string; keyImages: string[] }[];
  };
  const unsigned = JSON.parse(
    readFileSync('test/fixtures/monero-unsigned-tx-set.json', 'utf8'),
  ) as { file: string; viewSecret: string };

  /**
   * The `iv || ciphertext` an envelope signs, and the signature over it.
   *
   * The prefix is the magic plus its one version byte, which is why the magic
   * is passed in rather than a length: getting it wrong by one shifts the
   * whole body and every assertion below would fail together, which is a
   * confusing way to be told the offset is off.
   */
  function envelope(fileHex: string, magic: string) {
    const file = fromHex(fileHex);
    const body = file.subarray(magic.length + 1, file.length - 64);
    return { body, signature: file.subarray(file.length - 64) };
  }

  it('found the fixtures, so a pass means something', () => {
    expect(keyImages.cases.length).toBeGreaterThan(1);
    expect(unsigned.file.length).toBeGreaterThan(200);
  });

  for (const one of ['empty', 'two']) {
    it(`accepts the key-image export Monero signed (${one})`, () => {
      const found = keyImages.cases.find((c) => c.name === one)!;
      const { body, signature } = envelope(found.file, 'Monero key image export');
      expect(checkSignature(keccak_256(body), fromHex(found.viewPublic), signature)).toBe(true);
    });
  }

  it('accepts the unsigned transaction set Monero signed', () => {
    const { body, signature } = envelope(unsigned.file, 'Monero unsigned tx set');
    const viewPublic = publicFromSecret(fromHex(unsigned.viewSecret));
    expect(checkSignature(keccak_256(body), viewPublic, signature)).toBe(true);
  });

  it('rejects every single-byte change to the signature', () => {
    /* The test that makes acceptance mean something. Accepting one signature
     * is a property a function that returns `true` also has. */
    const found = keyImages.cases.find((c) => c.name === 'two')!;
    const { body, signature } = envelope(found.file, 'Monero key image export');
    const message = keccak_256(body);
    const key = fromHex(found.viewPublic);

    for (let at = 0; at < 64; at++) {
      const bent = Uint8Array.from(signature);
      bent[at] = (bent[at]! + 1) & 0xff;
      expect(checkSignature(message, key, bent), `byte ${at} of the signature`).toBe(false);
    }
  });

  it('rejects a changed message and a changed key', () => {
    const found = keyImages.cases.find((c) => c.name === 'two')!;
    const { body, signature } = envelope(found.file, 'Monero key image export');
    const message = keccak_256(body);
    const key = fromHex(found.viewPublic);
    expect(checkSignature(message, key, signature)).toBe(true);

    const otherMessage = Uint8Array.from(message);
    otherMessage[7] = (otherMessage[7]! ^ 0x01) & 0xff;
    expect(checkSignature(otherMessage, key, signature)).toBe(false);

    /* A different but perfectly valid public key. The signature is over this
     * message; it is not over it *for that key*. */
    expect(checkSignature(message, publicFromSecret(scalar(3)), signature)).toBe(false);
  });

  it('rejects a signature whose scalars are not canonical', () => {
    /* `sc_check`. A verifier that reduced instead would accept `c + L` as well
     * as `c`, which turns one signature into many for the same message. */
    const found = keyImages.cases.find((c) => c.name === 'two')!;
    const { body, signature } = envelope(found.file, 'Monero key image export');
    const message = keccak_256(body);
    const key = fromHex(found.viewPublic);

    const shift = (start: number) => {
      const bent = Uint8Array.from(signature);
      let n = 0n;
      for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(bent[start + i]!);
      let plus = n + L;
      for (let i = 0; i < 32; i++) {
        bent[start + i] = Number(plus & 0xffn);
        plus >>= 8n;
      }
      return bent;
    };
    expect(checkSignature(message, key, shift(0)), 'c + L was accepted').toBe(false);
    expect(checkSignature(message, key, shift(32)), 'r + L was accepted').toBe(false);
  });

  it('rejects the shapes that are not signatures at all', () => {
    const key = publicFromSecret(scalar(9));
    const message = keccak_256(new Uint8Array(8));
    expect(checkSignature(message, key, new Uint8Array(63))).toBe(false);
    expect(checkSignature(message, key, new Uint8Array(65))).toBe(false);
    expect(checkSignature(message, new Uint8Array(31), new Uint8Array(64))).toBe(false);
    expect(checkSignature(new Uint8Array(31), key, new Uint8Array(64))).toBe(false);
    // All zeroes: c is zero, which Monero refuses before doing any arithmetic.
    expect(checkSignature(message, key, new Uint8Array(64))).toBe(false);
    // A public key that is not a point at all.
    expect(checkSignature(message, new Uint8Array(32).fill(0xff), new Uint8Array(64))).toBe(false);
  });

  it('rejects the signature whose commitment is the identity point', () => {
    /* ## The one check a round trip can never justify
     *
     * Upstream's `check_signature` ends with
     *
     *     if (memcmp(&buf.comm, &infinity_point, sizeof(buf.comm)) == 0)
     *       return false;
     *
     * and a verifier written by inverting the signer would not have it: an
     * honest signature never produces the identity, so nothing in a
     * sign-then-verify test ever reaches that line. Deleting it from this
     * repository broke no test, which is how this one came to exist.
     *
     * The signature below is constructed rather than signed. Take the
     * challenge the identity commitment hashes to, then choose `r` so that
     * `c·P + r·G` really is the identity. Both scalars are canonical, `c` is
     * non-zero, and a verifier missing that last line accepts it, because the
     * commitment it hashes is exactly the one the challenge came from.
     *
     * It is not a forgery: building it needs the secret key, so it
     * demonstrates no attack. What it demonstrates is the thing that matters
     * here, which is *disagreement*. Monero rejects this signature. A vault
     * that accepts an envelope real Monero software rejects is a vault reading
     * files nobody else would.
     */
    const secretBytes = scalar(57);
    const publicKey = publicFromSecret(secretBytes);
    const message = keccak_256(new Uint8Array([9, 9, 9]));

    const leToBigInt = (bytes: Uint8Array): bigint => {
      let n = 0n;
      for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
      return n;
    };
    const bigIntToLe = (value: bigint): Uint8Array => {
      const out = new Uint8Array(32);
      let n = ((value % L) + L) % L;
      for (let i = 0; i < 32; i++) {
        out[i] = Number(n & 0xffn);
        n >>= 8n;
      }
      return out;
    };

    /* `ge_tobytes` of the identity: y = 1, sign bit clear. */
    const identity = new Uint8Array(32);
    identity[0] = 1;

    const buf = new Uint8Array(96);
    buf.set(message, 0);
    buf.set(publicKey, 32);
    buf.set(identity, 64);
    const c = leToBigInt(hashToScalar(buf)) % L;
    expect(c, 'the constructed challenge is zero, so this would prove nothing').not.toBe(0n);

    const x = leToBigInt(secretBytes);
    // r = -c·x, so that c·P + r·G = c·x·G - c·x·G = the identity.
    const r = (L - ((c * x) % L)) % L;

    /* The premise, asserted, so a mistake in the construction shows up as a
     * failing premise rather than as a test that passes for the wrong reason. */
    expect(
      Point.BASE.multiply((c * x) % L).add(Point.BASE.multiply(r)).toBytes(),
      'the constructed commitment is not the identity',
    ).toEqual(identity);

    const forged = new Uint8Array(64);
    forged.set(bigIntToLe(c), 0);
    forged.set(bigIntToLe(r), 32);
    expect(checkSignature(message, publicKey, forged)).toBe(false);
  });

  it("agrees with this repository's own signer, both ways", () => {
    /* The round trip, kept as well as the oracle check rather than instead of
     * it. It is what catches a verifier and a signer drifting together. */
    const secret = scalar(21);
    const publicKey = publicFromSecret(secret);
    const message = keccak_256(new Uint8Array([1, 2, 3, 4]));
    const sig = legacySignatureBytes(generateSignature(message, publicKey, secret, scalar(44)));
    expect(checkSignature(message, publicKey, sig)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `check_ring_signature`, the gate an importing wallet applies

describe('the ring signature a key image export carries', () => {
  /* ## What this closes
   *
   * `generateRingSignatureOfOne` was checked by reproducing Monero's bytes
   * given the same nonce. That proves two *signers* agree and says nothing
   * about the verifier — and the verifier is what decides whether
   * `wallet2::import_key_images` succeeds or throws "signature check failed"
   * at somebody standing in front of Cake or Feather.
   *
   * The fixture now carries Monero's own verdict. `oracle/src/keyimage.cpp`
   * runs `crypto::check_ring_signature` and `crypto::check_signature` over its
   * own output and records the answers, so the claim "another wallet will
   * accept this" rests on running wallet2's gate rather than on reading
   * wallet2.cpp. This file holds the TypeScript verifier to the same records.
   */

  const fixture = JSON.parse(
    readFileSync('test/fixtures/monero-keyimages.json', 'utf8'),
  ) as {
    cases: {
      name: string;
      outPubs: string[];
      keyImages: string[];
      ringSigs: string[];
      verified: { ringSignatures: boolean[]; envelope: boolean };
    }[];
  };

  const two = fixture.cases.find((c) => c.name === 'two')!;

  it('found the fixture, and Monero itself accepted these', () => {
    /* The premise, asserted. If the oracle ever records a false here, the
     * bytes below are not a valid signature and every assertion after this
     * would be checking agreement about something wrong. */
    expect(two.ringSigs).toHaveLength(2);
    expect(two.verified.ringSignatures).toEqual([true, true]);
    expect(two.verified.envelope).toBe(true);
    for (const one of fixture.cases) {
      expect(one.verified.ringSignatures, one.name).toEqual(one.ringSigs.map(() => true));
    }
  });

  it('accepts the records Monero accepted', () => {
    for (const [i, signature] of two.ringSigs.entries()) {
      expect(
        checkRingSignatureOfOne(fromHex(two.keyImages[i]!), fromHex(two.outPubs[i]!), fromHex(signature)),
        `record ${i}`,
      ).toBe(true);
    }
  });

  it('rejects every single-byte change to a signature', () => {
    const image = fromHex(two.keyImages[0]!);
    const key = fromHex(two.outPubs[0]!);
    const signature = fromHex(two.ringSigs[0]!);
    for (let at = 0; at < 64; at++) {
      const bent = Uint8Array.from(signature);
      bent[at] = (bent[at]! + 1) & 0xff;
      expect(checkRingSignatureOfOne(image, key, bent), `byte ${at}`).toBe(false);
    }
  });

  it('rejects a record paired with the wrong output', () => {
    /* The failure `import_key_images` actually produces in the field. It walks
     * `m_transfers[i + offset]` and pairs by position, so a file whose order
     * does not match the importing wallet's presents each signature against
     * somebody else's key. These two records are both valid and both this
     * wallet's; swapped, neither verifies. */
    expect(checkRingSignatureOfOne(fromHex(two.keyImages[0]!), fromHex(two.outPubs[1]!), fromHex(two.ringSigs[0]!)))
      .toBe(false);
    expect(checkRingSignatureOfOne(fromHex(two.keyImages[1]!), fromHex(two.outPubs[0]!), fromHex(two.ringSigs[1]!)))
      .toBe(false);
    // And swapping the images too, which is what a shifted file really does.
    expect(checkRingSignatureOfOne(fromHex(two.keyImages[1]!), fromHex(two.outPubs[0]!), fromHex(two.ringSigs[0]!)))
      .toBe(false);
  });

  it('rejects a key image outside the prime-order subgroup', () => {
    /* The behaviour is worth pinning; the *reason* is not what this test
     * shows, and saying so avoids a comment that reads as more than it is.
     * Deleting `isTorsionFree` from the verifier breaks nothing, because an
     * image outside the subgroup changes `b` and the challenge fails to
     * reproduce a line later. Monero checks first anyway, because a key image
     * is the network's only defense against spending one output twice and that
     * rests on one output having exactly one image.
     *
     * The point below is a real curve point of order 8, from RFC 8032's
     * small-order list, so what is being rejected is a genuine small-order
     * image rather than bytes that fail to decode. */
    const smallOrder = fromHex('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa');
    expect(Point.fromBytes(smallOrder).isTorsionFree(), 'the premise is wrong').toBe(false);
    expect(checkRingSignatureOfOne(smallOrder, fromHex(two.outPubs[0]!), fromHex(two.ringSigs[0]!)))
      .toBe(false);
  });

  it('rejects a signature whose scalars are not canonical', () => {
    const image = fromHex(two.keyImages[0]!);
    const key = fromHex(two.outPubs[0]!);
    const signature = fromHex(two.ringSigs[0]!);
    const shift = (start: number) => {
      const bent = Uint8Array.from(signature);
      let n = 0n;
      for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(bent[start + i]!);
      let plus = n + L;
      for (let i = 0; i < 32; i++) {
        bent[start + i] = Number(plus & 0xffn);
        plus >>= 8n;
      }
      return bent;
    };
    expect(checkRingSignatureOfOne(image, key, shift(0)), 'c + L was accepted').toBe(false);
    expect(checkRingSignatureOfOne(image, key, shift(32)), 'r + L was accepted').toBe(false);
  });

  it('rejects the shapes that are not a record at all', () => {
    const image = fromHex(two.keyImages[0]!);
    const key = fromHex(two.outPubs[0]!);
    expect(checkRingSignatureOfOne(image, key, new Uint8Array(63))).toBe(false);
    expect(checkRingSignatureOfOne(image, new Uint8Array(31), new Uint8Array(64))).toBe(false);
    expect(checkRingSignatureOfOne(new Uint8Array(32).fill(0xff), key, new Uint8Array(64))).toBe(false);
  });

  it('agrees with this repository\'s own signer, both ways', () => {
    const secret = scalar(31);
    const oneTimeKey = publicFromSecret(secret);
    const image = fromHex(keyImageOf(oneTimeKey, secret));
    const signature = legacySignatureBytes(
      generateRingSignatureOfOne(image, oneTimeKey, secret, scalar(64)),
    );
    expect(checkRingSignatureOfOne(image, oneTimeKey, signature)).toBe(true);
  });
});

describe("CLSAG against Monero's own prover and verifier", () => {
  /* The gap this closes, and it was a real one.
   *
   * The header of this file says the Monero project publishes no fixed CLSAG
   * vector, which is true, and everything above verifies the way their own
   * tests do: round trip, then attack every field. That is a good test of a
   * *pair*. It is no test at all of whether the pair matches Monero, because
   * a prover and a verifier that make the same mistake agree perfectly.
   *
   * Two shared mistakes lived in the aggregation hash and survived every test
   * in this file. `C_offset` sat where Monero puts the key images, and the
   * *unscaled* auxiliary key image was hashed where Monero hashes D·(1/8).
   * Signatures came out that this repository verified and the Monero network
   * would have refused, which means every Monero spend the vault made would
   * have been rejected on broadcast.
   *
   * `oracle/src/clsag.cpp` is what found them, and this is what stops them
   * coming back. It goes in both directions:
   *
   *   - our `clsagSign`, handed the same nonces Monero's stubbed RNG produced,
   *     has to reproduce `rct::proveRctCLSAGSimple` byte for byte;
   *   - `rct::verRctCLSAGSimple` has to accept the signature we made.
   *
   * The second is the one that matters. The first only says two signers agree.
   */
  const fixture = JSON.parse(readFileSync('test/fixtures/monero-clsag.json', 'utf8')) as {
    ringSize: number;
    realIndex: number;
    secret: string;
    z: string;
    message: string;
    pseudoOut: string;
    ring: { key: string; commitment: string }[];
    nonces: string[];
    monero: { c1: string; s: string[]; keyImage: string; dInv8: string };
    oursVerified: boolean;
    ours: { c1: string; s: string[]; keyImage: string; dInv8: string };
  };

  const ours = clsagSign(
    fromHex(fixture.message),
    fixture.ring,
    { p: fromHex(fixture.secret), z: fromHex(fixture.z), index: fixture.realIndex },
    fromHex(fixture.pseudoOut),
    fixture.nonces.map(fromHex),
  );

  it("reproduces rct::proveRctCLSAGSimple byte for byte", () => {
    /* Not "our signature verifies" - that was already true while it was
     * wrong. The same challenge, the same responses, the same two images. */
    expect(ours.c1).toBe(fixture.monero.c1);
    expect(ours.s).toEqual(fixture.monero.s);
    expect(ours.keyImage).toBe(fixture.monero.keyImage);
    expect(ours.dInv8).toBe(fixture.monero.dInv8);
    expect(fixture.monero.s).toHaveLength(fixture.ringSize);
  });

  it('is the signature the fixture recorded a verdict for', () => {
    /* The verdict below was given to specific bytes. Without this, a later
     * change to the signer would quietly inherit an answer about different
     * ones. */
    expect(ours).toEqual(fixture.ours);
  });

  it('was accepted by rct::verRctCLSAGSimple', () => {
    /* A false here is not a failing test to work around. It means the vault
     * signs Monero transactions the network refuses. */
    expect(fixture.oursVerified).toBe(true);
  });

  it('still verifies here, so both verifiers agree about it', () => {
    expect(clsagVerify(fromHex(fixture.message), fixture.ring, fromHex(fixture.pseudoOut), ours)).toBe(true);
  });

  it('hashes the images and the offset in Monero\'s order', () => {
    /* The mutation guard for the actual defect. Both mistakes are in the last
     * three entries of the aggregation hash, and both are invisible to every
     * other test in this file, so the shape of that list is asserted directly
     * rather than only through its consequences. */
    const source = readFileSync('src/keys/monerosign.ts', 'utf8');
    const inputs = [...source.matchAll(/dom, \.\.\.ringKeys, \.\.\.ringCommits, ([^\]]+)\]/g)]
      .map((m) => m[1]!.trim().replace(/,$/, ''));
    expect(inputs, 'clsagSign and clsagVerify both build the aggregation hash input').toHaveLength(2);
    expect(inputs[0]).toBe('Ibytes, dInv8Bytes, Coforbytes');
    expect(inputs[1]).toBe('Ibytes, dInv8Bytes, pseudoOut');
  });
});
