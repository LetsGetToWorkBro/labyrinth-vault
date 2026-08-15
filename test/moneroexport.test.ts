/*
 * The key-image export blob, against Monero's own crypto.
 *
 * `test/fixtures/monero-keyimages.json` was not produced by this repository.
 * It came out of a C++ program linked against Monero's `crypto.cpp`,
 * `crypto-ops.c`, `chacha.c` and the CryptoNight in vendor/cryptonight, with
 * `generate_random_bytes_thread_safe` replaced by a byte counter so the
 * signatures are reproducible. Every field below — the chacha key, each ring
 * signature, the plaintext, the finished file — is what Monero produced. The
 * TypeScript has to match it byte for byte or it is wrong.
 *
 * ## Why the nonces are in the fixture
 *
 * Monero draws `k` at random inside `generate_signature` and
 * `generate_ring_signature`, so two correct implementations produce different
 * signatures on the same input and cannot be compared at all. Both sides
 * therefore take their nonces from outside: Monero's came from the stubbed
 * counter, and the same bytes are handed to the TypeScript here. That is also
 * the house rule for `clsagSign`, for the same reason.
 *
 * ## What the CryptoNight shim is, and why it is not cheating
 *
 * `cn_slow_hash` is native C and is not in this bundle, so these tests install
 * a stand-in that answers with the fixture's `chachaKey` for the fixture's
 * view secret and refuses everything else. That would be circular on its own.
 * It is not, because `ios/LabyrinthVaultKDFTests/CryptoNightVectorTests.swift`
 * takes the same view secret and asserts the real vendored C produces the same
 * 32 bytes. The fixture is the contract between the two languages; each side
 * is held to it separately.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  chachaKeyFor,
  exportKeyImageBlob,
  keyImagePlaintext,
  readKeyImageBlob,
  setNativeCnSlowHash,
  nativeCnSlowHashInstalled,
  KEY_IMAGE_MAGIC,
  KEY_IMAGE_VERSION_BYTE,
  MAGIC_LENGTH,
  MAX_IMAGES,
} from '../src/keys/moneroexport';
import { generateRingSignatureOfOne, legacySignatureBytes } from '../src/keys/monerosign';

interface Case {
  name: string;
  offset: number;
  viewPublic: string;
  spendPublic: string;
  chachaKey: string;
  outPubs: string[];
  keyImages: string[];
  ringSigs: string[];
  nonces: string[];
  iv: string;
  plaintext: string;
  file: string;
}

const fixture: { viewSecret: string; ephemeralSecrets: string[]; cases: Case[] } = JSON.parse(
  readFileSync('test/fixtures/monero-keyimages.json', 'utf8'),
);

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((p) => parseInt(p, 16)));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const viewSecret = bytes(fixture.viewSecret);

/** Answers only for what the fixture pins, so an unexpected input is a failure
 *  rather than a plausible-looking wrong answer. */
const shim = (data: Uint8Array): Uint8Array => {
  const want = hex(viewSecret);
  if (hex(data) === want) return bytes(fixture.cases[0]!.chachaKey);
  throw new Error(`the shim has no CryptoNight answer for ${hex(data).slice(0, 16)}…`);
};

beforeEach(() => setNativeCnSlowHash(shim));
afterEach(() => setNativeCnSlowHash(null));

const request = (c: Case) => ({
  viewSecret,
  spendPublic: bytes(c.spendPublic),
  offset: c.offset,
  outputs: c.keyImages.map((ki, i) => ({
    oneTimeKey: bytes(c.outPubs[i]!),
    oneTimeSecret: bytes(fixture.ephemeralSecrets[i]!),
    keyImage: bytes(ki),
  })),
  nonces: c.nonces.map(bytes),
  iv: bytes(c.iv),
});

describe('the key-image export blob', () => {
  it('has both an empty export and a populated one to check', () => {
    /* Without this the suite could pass while only ever exercising one shape,
     * and the empty case is the one where the offset and the two public keys
     * are the whole payload. */
    expect(fixture.cases.map((c) => c.keyImages.length)).toEqual([0, 2]);
  });

  for (const c of fixture.cases) {
    describe(`case: ${c.name}`, () => {
      it('signs each key image exactly as Monero does', () => {
        for (const [i, image] of c.keyImages.entries()) {
          const sig = generateRingSignatureOfOne(
            bytes(image),
            bytes(c.outPubs[i]!),
            bytes(fixture.ephemeralSecrets[i]!),
            bytes(c.nonces[i]!),
          );
          expect(hex(legacySignatureBytes(sig)), `ring signature ${i}`).toBe(c.ringSigs[i]);
        }
      });

      it('lays the plaintext out as Monero does', () => {
        expect(hex(keyImagePlaintext(request(c), bytes(c.viewPublic)))).toBe(c.plaintext);
      });

      it('produces the same file, magic and outer signature included', () => {
        /* The whole thing: the header, every ring signature, the ChaCha20
         * under a CryptoNight-derived key, and the Schnorr signature over the
         * lot. One byte wrong anywhere and this fails. */
        expect(hex(exportKeyImageBlob(request(c)))).toBe(c.file);
      });

      it('reads its own file back', () => {
        const read = readKeyImageBlob(bytes(c.file), viewSecret);
        expect(read, 'the blob did not read back').not.toBeNull();
        expect(read!.offset).toBe(c.offset);
        expect(hex(read!.viewPublic)).toBe(c.viewPublic);
        expect(hex(read!.spendPublic)).toBe(c.spendPublic);
        expect(read!.images.map((im) => hex(im.keyImage))).toEqual(c.keyImages);
        expect(read!.images.map((im) => hex(im.signature))).toEqual(c.ringSigs);
      });
    });
  }

  it('keeps the magic in the clear, which is how a wallet knows what it has', () => {
    const file = exportKeyImageBlob(request(fixture.cases[1]!));
    expect(new TextDecoder().decode(file.subarray(0, KEY_IMAGE_MAGIC.length))).toBe(KEY_IMAGE_MAGIC);
    /* The version byte after the name. Upstream keeps it inside one C string
     * literal; here it is a named constant, because a raw 0x03 in source is
     * invisible in a review and could vanish without a test noticing. So it
     * gets asserted against the fixture's own bytes rather than against
     * itself. */
    expect(file[KEY_IMAGE_MAGIC.length]).toBe(KEY_IMAGE_VERSION_BYTE);
    expect(MAGIC_LENGTH).toBe(24);
    expect(hex(file.subarray(0, MAGIC_LENGTH))).toBe(fixture.cases[1]!.file.slice(0, MAGIC_LENGTH * 2));
  });
});

describe('what the export refuses', () => {
  const c = fixture.cases[1]!;

  it('will not produce a blob at all without CryptoNight', () => {
    /* The important refusal in this file. Argon2id has a JavaScript fallback,
     * so a missing native function costs speed; this has none, so a missing
     * native function would mean encrypting under whatever a stub returned.
     * The result would look like a valid file, import into nothing, and tell
     * its owner their balance was wrong. */
    setNativeCnSlowHash(null);
    expect(nativeCnSlowHashInstalled()).toBe(false);
    expect(() => exportKeyImageBlob(request(c))).toThrow(/CryptoNight/);
    expect(() => chachaKeyFor(viewSecret)).toThrow(/CryptoNight/);
  });

  it('refuses a native function that returns the wrong length', () => {
    setNativeCnSlowHash(() => new Uint8Array(16));
    expect(() => chachaKeyFor(viewSecret)).toThrow(/wrong length/);
  });

  it('needs one nonce per image plus one for the outer signature', () => {
    const short = { ...request(c), nonces: request(c).nonces.slice(0, -1) };
    expect(() => exportKeyImageBlob(short)).toThrow(/nonces/);
  });

  it('refuses an offset that is not a 32-bit unsigned integer', () => {
    for (const offset of [-1, 1.5, 0x1_0000_0000]) {
      expect(() => exportKeyImageBlob({ ...request(c), offset })).toThrow(/32-bit/);
    }
  });

  it('refuses more key images than it will verify', () => {
    const one = request(c).outputs[0]!;
    const many = {
      ...request(c),
      outputs: new Array(MAX_IMAGES + 1).fill(one),
      /* Enough nonces, so the ceiling is what refuses rather than the arity
       * check standing in front of it. The first version of this test had too
       * few and passed for the wrong reason. */
      nonces: new Array(MAX_IMAGES + 2).fill(bytes(c.nonces[0]!)),
    };
    expect(() => exportKeyImageBlob(many)).toThrow(/more than/);
  });
});

describe('what the reader refuses', () => {
  const c = fixture.cases[1]!;

  it('returns null instead of half a file', () => {
    const file = bytes(c.file);
    expect(readKeyImageBlob(file.subarray(0, file.length - 1), viewSecret),
      'a truncated blob was read').toBeNull();
    expect(readKeyImageBlob(new Uint8Array(10), viewSecret)).toBeNull();
  });

  it('refuses a file whose magic is not the magic', () => {
    const wrong = bytes(c.file);
    wrong[0] = 0x4e;
    expect(readKeyImageBlob(wrong, viewSecret)).toBeNull();
  });

  it('refuses a body that is not a whole number of records', () => {
    /* There is no count in the format: the number of images is the length
     * divided by 96. So a blob one byte short is not "the last image is
     * truncated", it is a blob that cannot be read at all, and reading as far
     * as it goes would hand back images from a file somebody tampered with. */
    const file = bytes(c.file);
    const bent = new Uint8Array(file.length + 1);
    bent.set(file, 0);
    expect(readKeyImageBlob(bent, viewSecret)).toBeNull();
  });

  it('refuses a blob that was not made under this key', () => {
    /* A wrong key decrypts to noise, and noise is not the view public key this
     * secret produces. That check is the only thing standing between a wrong
     * key and a list of plausible 32-byte values. */
    const other = bytes('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f00');
    setNativeCnSlowHash((data) => (hex(data) === hex(other) ? new Uint8Array(32).fill(7) : shim(data)));
    expect(readKeyImageBlob(bytes(c.file), other)).toBeNull();
  });
});
