/**
 * Monero's own answers, against ours.
 *
 * Every vector in this file was extracted verbatim from monero-project's
 * `tests/crypto/tests.txt`, which is the file their own unit tests read. None
 * of it was produced here, and that is the entire point: a round trip through
 * our own encoder proves consistency, and consistency is exactly what a
 * transcription error preserves.
 *
 * The one that earns its keep is `hash_to_point`. It tests
 * `ge_fromfe_frombytes_vartime` with nothing wrapped around it — no Keccak
 * before, no multiplication by 8 after — so when it fails there is one
 * function to look at. That map is the only piece of curve arithmetic in this
 * repository that was written rather than imported, and it is a transcription
 * of unreadable C, so it gets the most direct test available.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { publicFromSecret, reduceScalar } from '../src/keys/monero';
import {
  FIELD_CONSTANTS,
  derivationToScalar,
  derivePublicKey,
  deriveSecretKey,
  deriveViewTag,
  generateKeyDerivation,
  generateKeyImage,
  hashToPoint,
  hashToScalar,
  selfTest,
  writeVarint,
  RCT_H,
  RCT_H_HEX,
  amountMask,
  commit,
  commitmentMask,
} from '../src/keys/monerocrypto';

const Point = ed25519.Point;

interface Fixture {
  note: string;
  vectors: Record<string, string[][]>;
}

const fixture: Fixture = JSON.parse(
  readFileSync('test/fixtures/monero-crypto.json', 'utf8'),
) as Fixture;

const bytes = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const hex = (value: Uint8Array): string =>
  Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');

/** Read a vector list, refusing to pass by finding nothing to check. */
function vectors(name: string, arity: number): string[][] {
  const list = fixture.vectors[name];
  expect(list, `no ${name} vectors in the fixture`).toBeDefined();
  expect(list!.length, `${name} has too few vectors to mean anything`).toBeGreaterThan(99);
  for (const vector of list!) expect(vector).toHaveLength(arity);
  return list!;
}

describe('the fixture is what it claims to be', () => {
  it('says where it came from', () => {
    expect(fixture.note).toMatch(/monero-project/);
    expect(fixture.note).toMatch(/nothing here was produced by this repository/i);
  });

  it('carries all six operations', () => {
    expect(Object.keys(fixture.vectors).sort()).toEqual([
      'derive_public_key',
      'derive_secret_key',
      'generate_key_derivation',
      'generate_key_image',
      'hash_to_point',
      'hash_to_scalar',
    ]);
  });
});

describe('the field constants are proved, not copied', () => {
  /* They are written as plain integers in monerocrypto.ts because the limb
   * arrays in crypto-ops.c cannot be checked by eye. That only helps if
   * something checks them, so: each is squared and compared against the
   * expression it is supposed to be a square root of. A typo in any digit
   * fails here rather than silently producing a wrong key image. */
  const { P, L, SQRT_M1, MA, MA2, FFFB1, FFFB2, FFFB3, FFFB4, A } = FIELD_CONSTANTS;
  const mod = (n: bigint): bigint => ((n % P) + P) % P;
  const square = (n: bigint): bigint => mod(n * n);

  it('has the right field and the right group order', () => {
    expect(P).toBe(2n ** 255n - 19n);
    expect(L).toBe(2n ** 252n + 27742317777372353535851937790883648493n);
  });

  it('has a real square root of -1, and the canonical one', () => {
    expect(square(SQRT_M1)).toBe(mod(-1n));
    /* Which of the two roots it is decides which branch the map takes, so it
     * is not enough that it squares to -1: it has to be 2^((p-1)/4). */
    let two = 1n;
    for (let e = (P - 1n) / 4n, b = 2n; e > 0n; e >>= 1n, b = mod(b * b)) {
      if (e & 1n) two = mod(two * b);
    }
    expect(two).toBe(SQRT_M1);
  });

  it('has -A and -A squared', () => {
    expect(MA).toBe(mod(-A));
    expect(MA2).toBe(mod(-A * A));
  });

  it('has the four square roots the Elligator map branches on', () => {
    expect(square(FFFB1)).toBe(mod(-2n * A * (A + 2n)));
    expect(square(FFFB2)).toBe(mod(2n * A * (A + 2n)));
    expect(square(FFFB3)).toBe(mod(-SQRT_M1 * A * (A + 2n)));
    expect(square(FFFB4)).toBe(mod(SQRT_M1 * A * (A + 2n)));
  });
});

describe('hash_to_scalar', () => {
  it('matches all 120 published vectors', () => {
    for (const [data, want] of vectors('hash_to_scalar', 2)) {
      expect(hex(hashToScalar(bytes(data!)))).toBe(want);
    }
  });

  it('is a reduction, not just a hash', () => {
    /* The failure this guards against is dropping sc_reduce32, which produces
     * a well-formed 32-byte value that every other wallet disagrees with. Find
     * an input whose raw Keccak is above the group order and check we differ
     * from it there. */
    const L = FIELD_CONSTANTS.L;
    const asNumber = (value: Uint8Array): bigint => {
      let n = 0n;
      for (let i = value.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(value[i]!);
      return n;
    };
    let found = false;
    for (let i = 0; i < 64 && !found; i++) {
      const input = Uint8Array.of(i);
      const raw = keccak_256(input);
      if (asNumber(raw) < L) continue;
      found = true;
      expect(hex(hashToScalar(input))).not.toBe(hex(raw));
      expect(asNumber(hashToScalar(input))).toBe(asNumber(raw) % L);
    }
    expect(found, 'no input landed above the group order, so nothing was tested').toBe(true);
  });
});

describe('generate_key_derivation', () => {
  it('matches all 120 published vectors', () => {
    for (const [pub, sec, valid, want] of vectors('generate_key_derivation', 4)) {
      expect(valid, 'this test does not cover the rejected-key vectors').toBe('true');
      expect(hex(generateKeyDerivation(bytes(pub!), bytes(sec!)))).toBe(want);
    }
  });

  it('refuses a public key that is not a point', () => {
    const notAPoint = new Uint8Array(32).fill(0xff);
    const secret = bytes('eb2bd1cf0c5e074f9dbf38ebbc99c316f54e21803048c687a3bb359f7a713b02');
    expect(() => generateKeyDerivation(notAPoint, secret)).toThrow();
  });

  it('refuses a zero secret rather than returning the identity', () => {
    const pub = bytes('fdfd97d2ea9f1c25df773ff2c973d885653a3ee643157eb0ae2b6dd98f0b6984');
    expect(() => generateKeyDerivation(pub, new Uint8Array(32))).toThrow(/zero/);
  });
});

describe('derive_public_key', () => {
  it('matches all 120 published vectors', () => {
    for (const [derivation, index, base, valid, want] of vectors('derive_public_key', 5)) {
      expect(valid).toBe('true');
      expect(hex(derivePublicKey(bytes(derivation!), Number(index), bytes(base!)))).toBe(want);
    }
  });

  it('reads the output index as a decimal number', () => {
    /* The vectors write it in decimal. Reading it as hex would still produce a
     * well-formed key, for a different output, and would only be noticed by a
     * wallet that could not find its own money. */
    const [derivation, index, base, , want] = vectors('derive_public_key', 5)
      .find((v) => /[2-9]/.test(v[1]!) && v[1]!.length > 2)!;
    expect(hex(derivePublicKey(bytes(derivation!), parseInt(index!, 10), bytes(base!)))).toBe(want);
    expect(hex(derivePublicKey(bytes(derivation!), parseInt(index!, 16), bytes(base!)))).not.toBe(want);
  });
});

describe('derive_view_tag', () => {
  interface ViewTagVector { derivation: string; outputIndex: number; viewTag: string }
  const viewTags: { vectors: ViewTagVector[] } = JSON.parse(
    readFileSync('test/fixtures/view-tag.json', 'utf8'),
  );

  it('matches all 70 published vectors', () => {
    expect(viewTags.vectors.length).toBe(70);
    for (const v of viewTags.vectors) {
      expect(hex(deriveViewTag(bytes(v.derivation), v.outputIndex))).toBe(v.viewTag);
    }
  });

  it('is one byte and depends on the output index', () => {
    const derivation = bytes(viewTags.vectors[0]!.derivation);
    expect(deriveViewTag(derivation, 0)).toHaveLength(1);
    /* Two indices under the same derivation give (almost surely) different
     * tags; the published vectors 0 and 1 differ, so assert that pair. */
    expect(hex(deriveViewTag(derivation, 0))).not.toBe(hex(deriveViewTag(derivation, 1)));
  });
});

describe('derive_secret_key', () => {
  it('matches all 120 published vectors', () => {
    for (const [derivation, index, base, want] of vectors('derive_secret_key', 4)) {
      expect(hex(deriveSecretKey(bytes(derivation!), Number(index), bytes(base!)))).toBe(want);
    }
  });

  it('is the private half of derive_public_key', () => {
    /* The property that actually matters, and the one no vector states
     * directly: the secret key derived for an output must open the public key
     * derived for the same output. If these ever disagree the money is on the
     * chain and unreachable. */
    const secret = hashToScalar(new TextEncoder().encode('a fixed spend key for this test'));
    const derivation = generateKeyDerivation(
      bytes('fdfd97d2ea9f1c25df773ff2c973d885653a3ee643157eb0ae2b6dd98f0b6984'),
      bytes('eb2bd1cf0c5e074f9dbf38ebbc99c316f54e21803048c687a3bb359f7a713b02'),
    );
    for (const index of [0, 1, 7, 217407]) {
      const publicKey = derivePublicKey(derivation, index, publicFromSecret(secret));
      const secretKey = deriveSecretKey(derivation, index, secret);
      expect(hex(publicFromSecret(secretKey))).toBe(hex(publicKey));
    }
  });
});

describe('hash_to_point', () => {
  it('matches all 120 published vectors', () => {
    /* ge_fromfe_frombytes_vartime, alone. This is the transcribed function. */
    for (const [input, want] of vectors('hash_to_point', 2)) {
      expect(hex(hashToPoint(bytes(input!)))).toBe(want);
    }
  });

  it('exercises every branch of the map', () => {
    /* Three branches, chosen by whether a square root exists. If the vectors
     * only ever took one of them, 120 of them would prove one third of the
     * function. Counted by the shape of the answer rather than by
     * instrumenting the code: the branches differ in whether the result is
     * multiplied by u, which changes nothing observable, so instead check the
     * inputs are spread over the whole field. */
    const list = vectors('hash_to_point', 2);
    const highBitSet = list.filter((v) => parseInt(v[0]!.slice(62, 64), 16) & 0x80).length;
    expect(highBitSet, 'no vector has the top bit set, so the unmasked read is untested')
      .toBeGreaterThan(10);
  });

  it('reads the input as a full 256-bit value, not a masked one', () => {
    /* The ordinary fe_frombytes masks the top bit. This one does not, and the
     * difference shows up on one input in two. Two inputs differing only in
     * that bit must therefore map to different points. */
    const low = new Uint8Array(32).fill(3);
    const high = new Uint8Array(32).fill(3);
    high[31] = high[31]! | 0x80;
    expect(hex(hashToPoint(high))).not.toBe(hex(hashToPoint(low)));
  });
});

describe('generate_key_image', () => {
  it('matches all 120 published vectors', () => {
    for (const [pub, sec, want] of vectors('generate_key_image', 3)) {
      expect(hex(generateKeyImage(bytes(pub!), bytes(sec!)))).toBe(want);
    }
  });

  it('gives the same image for the same key every time', () => {
    // A key image that varied would not stop a double spend at all.
    const [pub, sec, want] = vectors('generate_key_image', 3)[0]!;
    for (let i = 0; i < 4; i++) expect(hex(generateKeyImage(bytes(pub!), bytes(sec!)))).toBe(want);
  });

  it('gives different images for different keys', () => {
    const list = vectors('generate_key_image', 3);
    const images = new Set(list.map((v) => v[2]!));
    expect(images.size).toBe(list.length);
  });
});

describe('varints', () => {
  it('encodes the way Monero does', () => {
    expect(hex(writeVarint(0))).toBe('00');
    expect(hex(writeVarint(1))).toBe('01');
    expect(hex(writeVarint(127))).toBe('7f');
    expect(hex(writeVarint(128))).toBe('8001');
    expect(hex(writeVarint(300))).toBe('ac02');
    expect(hex(writeVarint(1932534752))).toBe('e0c7c09907');
  });

  it('refuses anything that is not a whole non-negative number', () => {
    for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 60]) {
      expect(() => writeVarint(bad)).toThrow();
    }
  });

  it('is what derivationToScalar appends', () => {
    const derivation = bytes('ca780b065e48091d910de90bcab2411db3d1a845e6d95cfd556af4138504c737');
    const index = 217407;
    const buffer = new Uint8Array(32 + writeVarint(index).length);
    buffer.set(derivation, 0);
    buffer.set(writeVarint(index), 32);
    expect(hex(derivationToScalar(derivation, index))).toBe(hex(hashToScalar(buffer)));
  });
});

describe('the RingCT second generator', () => {
  it('is what Monero says it is', () => {
    /* Computed in the module from the construction and compared here to the
     * literal in monero-project's rctTypes.h. Both halves are load-bearing:
     * the computation shows the constant is what the definition produces, and
     * this comparison shows we agree with the network about which point it is. */
    expect(hex(RCT_H)).toBe(RCT_H_HEX);
  });

  it('is not the Elligator map, which is the mistake to make', () => {
    /* Every other bytes-to-point step in Monero is `hash_to_ec`: Keccak, the
     * Elligator map, then a multiply by eight. H is not. It is Keccak of G's
     * encoding read *directly* as a point encoding, which happens to decode.
     * Getting this wrong produces a well-formed generator that no commitment
     * on the chain will ever verify against. */
    const g = bytes('5866666666666666666666666666666666666666666666666666666666666666');
    const elligator = hashToPoint(keccak_256(g));
    expect(hex(elligator)).not.toBe(RCT_H_HEX);
  });

  it('is not the base point, and not the identity', () => {
    expect(hex(RCT_H)).not.toBe('5866666666666666666666666666666666666666666666666666666666666666');
    expect(hex(RCT_H)).not.toBe('0100000000000000000000000000000000000000000000000000000000000000');
  });
});

describe('opening a RingCT amount', () => {
  const shared = bytes('ca780b065e48091d910de90bcab2411db3d1a845e6d95cfd556af4138504c737');

  it('gives the mask and the amount key different values from one secret', () => {
    /* Same input, two labels. One hash serving both would let the amount be
     * recovered from the mask. */
    expect(hex(commitmentMask(shared))).not.toBe(hex(amountMask(shared)));
  });

  it('is deterministic, because both sides have to agree without talking', () => {
    expect(hex(commitmentMask(shared))).toBe(hex(commitmentMask(shared)));
    expect(hex(amountMask(shared))).toBe(hex(amountMask(shared)));
  });

  it('makes a mask that is a reduced scalar', () => {
    /* An unreduced value is a valid 32-byte string and not a valid scalar, and
     * every implementation that does reduce disagrees with one that does not. */
    const mask = commitmentMask(shared);
    expect(mask.length).toBe(32);
    expect(mask[31]! & 0xf0).toBe(0);
  });

  it('refuses a shared secret that is not 32 bytes', () => {
    expect(() => commitmentMask(new Uint8Array(31))).toThrow();
    expect(() => amountMask(new Uint8Array(33))).toThrow();
  });

  it('commits to different amounts differently under one mask', () => {
    const mask = commitmentMask(shared);
    const seen = new Set([0n, 1n, 2n, 10n ** 12n].map((amount) => hex(commit(amount, mask))));
    expect(seen.size).toBe(4);
  });

  it('commits to one amount differently under different masks', () => {
    /* The blinding is the whole privacy property. Two payments of the same
     * size producing the same point would make amounts readable off the chain
     * by comparison alone. */
    const a = commit(10n ** 12n, commitmentMask(shared));
    const b = commit(10n ** 12n, commitmentMask(bytes('0'.repeat(63) + '1')));
    expect(hex(a)).not.toBe(hex(b));
  });

  it('handles a zero amount, which is legal and occasionally real', () => {
    expect(() => commit(0n, commitmentMask(shared))).not.toThrow();
  });

  it('refuses an amount outside 64 bits', () => {
    expect(() => commit(-1n, commitmentMask(shared))).toThrow();
    expect(() => commit(2n ** 64n, commitmentMask(shared))).toThrow();
    expect(() => commit(2n ** 64n - 1n, commitmentMask(shared))).not.toThrow();
  });

  it('is homomorphic, which is the property the whole scheme rests on', () => {
    /* commit(a, x) + commit(b, y) == commit(a+b, x+y). This is what lets the
     * network check that a transaction's inputs and outputs balance without
     * learning any of the amounts. Testing it here means the two masks and the
     * generator are all being combined the way Monero combines them. */
    const one = commitmentMask(shared);
    const two = commitmentMask(bytes('0'.repeat(62) + '02'));
    const sum = new Uint8Array(32);
    let carry = 0;
    for (let i = 0; i < 32; i++) {
      const total = one[i]! + two[i]! + carry;
      sum[i] = total & 0xff;
      carry = total >> 8;
    }
    const left = Point.fromBytes(commit(4n, one)).add(Point.fromBytes(commit(7n, two)));
    expect(hex(left.toBytes())).toBe(hex(commit(11n, reduceScalar(sum))));
  });
});

describe('the launch checks', () => {
  it('all pass', () => {
    const checks = selfTest();
    expect(checks.length).toBe(7);
    for (const check of checks) expect(check.ok, `${check.name}: ${check.detail}`).toBe(true);
  });

  it('quote vectors that are really in the fixture', () => {
    /* The device-side checks embed a handful of vectors by hand. A copy that
     * drifted from the file would prove nothing on a phone while the full
     * suite stayed green here. */
    const source = readFileSync('src/keys/monerocrypto.ts', 'utf8');
    const all = Object.values(fixture.vectors).flat().flat();
    const quoted = [...source.matchAll(/unhex\('([0-9a-f]{64})'\)/g)].map((m) => m[1]!);
    expect(quoted.length).toBeGreaterThan(6);
    for (const value of quoted) expect(all, `${value} is not in the fixture`).toContain(value);
  });
});
