/**
 * The key image export file, over the bridge.
 *
 * ## What this closes
 *
 * `exportKeyImageBlob` has been built and checked against Monero's own crypto
 * since the CryptoNight work, and until `moneroKeyImageFile` existed nothing
 * could ask for one. That is the whole reason `vendor/cryptonight` is in this
 * repository — thirty-four files of Monero's C, byte-pinned — and it was
 * reachable from no screen and no bridge function. `src/keys/monerotx.ts` even
 * said "this vault *writes* this one", which was true of the code and false of
 * the product.
 *
 * ## What is checked here, and where the real check is
 *
 * The bytes are not checked here. `test/moneroexport.test.ts` holds the writer
 * to a file Monero's own `crypto.cpp` and `chacha.c` produced, byte for byte,
 * and that is the contract that matters. What this file checks is the layer
 * between that writer and a person: that the request is remembered, that the
 * randomness contract is exact, that the file that comes back is one the
 * reader accepts, that a locked vault answers nothing, and that a request with
 * a refusal in it produces no file at all.
 *
 * That last one is the interesting rule. `import_key_images` pairs records
 * with transfers *by position*, so a file one record short pairs everything
 * after the gap with the wrong output. Those fail `check_ring_signature` on
 * the far side, which is the right failure — and a file known in advance to
 * fail is not worth animating across a room.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { api, resetHost } from '../src/bridge/host';
import { Collector } from '../src/airgap/envelope';
import { keyImageFileRandomBytes, KEYIMAGE_VERSION } from '../src/keys/keyimages';
import {
  MAGIC_LENGTH,
  readKeyImageBlob,
  setNativeCnSlowHash,
} from '../src/keys/moneroexport';
import {
  fromHex,
  parseAddress,
  publicFromSecret,
  reduceScalar,
  toHex,
  walletFromSeed,
} from '../src/keys/monero';
import { derivePublicKey, generateKeyDerivation } from '../src/keys/monerocrypto';
import { passphraseToBytes, } from '../src/keys/seal';
import { sha256 } from '@noble/hashes/sha2.js';

afterEach(() => {
  setNativeCnSlowHash(null);
  resetHost();
});

const CREATE_RANDOM = new Uint8Array(88).fill(0x5a);
const SECRET_BYTES = 48;
/** An arbitrary ChaCha key. The seam the vendored C sits behind answers with
 *  it, which is what standing in for that C means; the real C is held to the
 *  oracle's key by CryptoNightVectorTests.swift. */
const CHACHA_KEY = new Uint8Array(32).map((_, i) => (i * 11 + 3) & 0xff);

/** The Monero wallet the session holds, re-derived the way host.ts derives it. */
function sessionWallet() {
  const material = new Uint8Array(1 + SECRET_BYTES);
  material[0] = 0x02;
  material.set(CREATE_RANDOM.subarray(0, SECRET_BYTES), 1);
  return walletFromSeed(sha256(material));
}

function openSession(): { xmrAddress: string } {
  const pass = Array.from(passphraseToBytes('correct horse battery staple'));
  const created = JSON.parse(api.create(toHex(CREATE_RANDOM), pass, '')) as {
    ok: boolean;
    sealed?: string;
  };
  expect(created.ok).toBe(true);
  const unlocked = JSON.parse(api.unlock(created.sealed!, pass)) as {
    ok: boolean;
    xmrAddress?: string;
  };
  expect(unlocked.ok).toBe(true);
  return { xmrAddress: unlocked.xmrAddress! };
}

/** A sender paying an address, from nothing but the address. */
function outputFor(address: string, index: number, seed = 13) {
  const parsed = parseAddress(address);
  const secret = reduceScalar(new Uint8Array(32).map((_, i) => (i * 7 + seed) & 0xff));
  const derivation = generateKeyDerivation(fromHex(parsed.viewPublic!), secret);
  return {
    tx: toHex(publicFromSecret(secret)),
    index,
    key: toHex(derivePublicKey(derivation, index, fromHex(parsed.spendPublic!))),
  };
}

const asRequestHex = (outputs: unknown, offset?: number): string =>
  toHex(
    new TextEncoder().encode(
      JSON.stringify({ v: KEYIMAGE_VERSION, chain: 'xmr', outputs, ...(offset === undefined ? {} : { offset }) }),
    ),
  );

/** Reassemble whatever the frames carry, through the vault's own collector. */
function assemble(frames: string[]): Uint8Array {
  const collector = new Collector();
  let payload: Uint8Array | null = null;
  for (const frame of frames) {
    const progress = collector.offer(frame);
    if (progress.payload) payload = progress.payload;
  }
  expect(payload, 'the frames never assembled').not.toBeNull();
  return payload!;
}

interface ImagesReply {
  ok: boolean;
  answered?: number;
  refused?: number;
  frames?: string[];
  fileRandomBytes?: number | null;
  problem?: string;
}
interface FileReply {
  ok: boolean;
  answered?: number;
  offset?: number;
  frames?: string[];
  problem?: string;
}

describe('the file every other Monero wallet imports', () => {
  it('states what the file would cost in randomness, before it is asked for', () => {
    /* The same contract `moneroSign` has: the engine owns the formula, the
     * platform CSPRNG owns the bytes, and the screen never re-derives a count
     * it could get wrong. */
    const { xmrAddress } = openSession();
    setNativeCnSlowHash(() => CHACHA_KEY);
    const reply = JSON.parse(
      api.moneroKeyImages(asRequestHex([outputFor(xmrAddress, 0), outputFor(xmrAddress, 1)])),
    ) as ImagesReply;
    expect(reply.ok).toBe(true);
    expect(reply.answered).toBe(2);
    expect(reply.fileRandomBytes).toBe(keyImageFileRandomBytes(2));
  });

  it('says the file cannot be written when this build has no CryptoNight', () => {
    /* The reason `version` reports `cryptonight` at all. A build without it
     * signs and answers on this project's own wire exactly as before; the one
     * thing it cannot do is write this file, and the screen that offers the
     * button needs to know before it draws one. */
    const { xmrAddress } = openSession();
    setNativeCnSlowHash(null);
    const reply = JSON.parse(api.moneroKeyImages(asRequestHex([outputFor(xmrAddress, 0)]))) as ImagesReply;
    expect(reply.ok).toBe(true);
    expect(reply.frames, 'the own-wire answer is unaffected').toBeTruthy();
    expect(reply.fileRandomBytes).toBeNull();

    const file = JSON.parse(api.moneroKeyImageFile('00'.repeat(72))) as FileReply;
    expect(file.ok).toBe(false);
    expect(file.problem).toMatch(/CryptoNight/);
  });

  it('writes a file the reader accepts, carrying every requested image', () => {
    const { xmrAddress } = openSession();
    setNativeCnSlowHash(() => CHACHA_KEY);
    const outputs = [outputFor(xmrAddress, 0), outputFor(xmrAddress, 1), outputFor(xmrAddress, 2)];
    const images = JSON.parse(api.moneroKeyImages(asRequestHex(outputs, 7))) as ImagesReply;
    expect(images.fileRandomBytes).toBe(keyImageFileRandomBytes(3));

    const random = toHex(new Uint8Array(images.fileRandomBytes!).map((_, i) => (i * 29 + 5) & 0xff));
    const reply = JSON.parse(api.moneroKeyImageFile(random)) as FileReply;
    expect(reply.problem ?? null).toBeNull();
    expect(reply.ok).toBe(true);
    expect(reply.answered).toBe(3);
    expect(reply.offset).toBe(7);

    const file = assemble(reply.frames!);
    /* It is the container it says it is, on the wire that carries Monero's own
     * files in either direction. */
    expect(new TextDecoder().decode(file.subarray(0, MAGIC_LENGTH - 1)))
      .toBe('Monero key image export');

    const read = readKeyImageBlob(file, sessionWallet().viewSecret);
    expect(read, 'the vault cannot read back the file it just wrote').not.toBeNull();
    expect(read!.offset).toBe(7);
    expect(read!.images).toHaveLength(3);
    expect(toHex(read!.viewPublic)).toBe(sessionWallet().viewPublic);
    expect(toHex(read!.spendPublic)).toBe(sessionWallet().spendPublic);
  });

  it('carries the same key images the own-wire answer carries', () => {
    /* Two wires, one answer. If these ever differed, one of the two readers
     * would be told a different thing about the same outputs, and only one of
     * them could be right. */
    const { xmrAddress } = openSession();
    setNativeCnSlowHash(() => CHACHA_KEY);
    const outputs = [outputFor(xmrAddress, 0), outputFor(xmrAddress, 1)];
    const images = JSON.parse(api.moneroKeyImages(asRequestHex(outputs))) as ImagesReply;
    const ownWire = JSON.parse(new TextDecoder().decode(assemble(images.frames!))) as {
      images: { key: string; image: string }[];
    };

    const random = toHex(new Uint8Array(images.fileRandomBytes!).map((_, i) => (i * 3 + 1) & 0xff));
    const reply = JSON.parse(api.moneroKeyImageFile(random)) as FileReply;
    const read = readKeyImageBlob(assemble(reply.frames!), sessionWallet().viewSecret)!;

    expect(read.images.map((r) => toHex(r.keyImage))).toEqual(ownWire.images.map((i) => i.image));
  });

  it('defaults the offset to zero, which is what exporting everything means', () => {
    const { xmrAddress } = openSession();
    setNativeCnSlowHash(() => CHACHA_KEY);
    const images = JSON.parse(api.moneroKeyImages(asRequestHex([outputFor(xmrAddress, 0)]))) as ImagesReply;
    const random = toHex(new Uint8Array(images.fileRandomBytes!).fill(0x11));
    const reply = JSON.parse(api.moneroKeyImageFile(random)) as FileReply;
    expect(reply.offset).toBe(0);
  });
});

describe('what it refuses, and why each refusal is not a nicety', () => {
  it('answers nothing before a request has been read', () => {
    openSession();
    setNativeCnSlowHash(() => CHACHA_KEY);
    const reply = JSON.parse(api.moneroKeyImageFile('00'.repeat(72))) as FileReply;
    expect(reply.ok).toBe(false);
    expect(reply.problem).toMatch(/No key image request/);
  });

  it('forgets the request when the vault locks', () => {
    /* A locked vault answers nothing, and that has to include the thing it was
     * halfway through answering. */
    const { xmrAddress } = openSession();
    setNativeCnSlowHash(() => CHACHA_KEY);
    const images = JSON.parse(api.moneroKeyImages(asRequestHex([outputFor(xmrAddress, 0)]))) as ImagesReply;
    api.lock();
    const random = toHex(new Uint8Array(images.fileRandomBytes!).fill(0x22));
    const reply = JSON.parse(api.moneroKeyImageFile(random)) as FileReply;
    expect(reply.ok).toBe(false);
    expect(reply.problem).toMatch(/locked/i);
  });

  it('refuses any length of randomness but the exact one', () => {
    const { xmrAddress } = openSession();
    setNativeCnSlowHash(() => CHACHA_KEY);
    const images = JSON.parse(api.moneroKeyImages(asRequestHex([outputFor(xmrAddress, 0)]))) as ImagesReply;
    const need = images.fileRandomBytes!;
    for (const wrong of [need - 1, need + 1, 0, 32]) {
      const reply = JSON.parse(api.moneroKeyImageFile('00'.repeat(wrong))) as FileReply;
      expect(reply.ok, `${wrong} bytes was accepted`).toBe(false);
      expect(reply.problem).toMatch(new RegExp(`exactly ${need} bytes`));
    }
    expect(JSON.parse(api.moneroKeyImageFile('not hex')).ok).toBe(false);
  });

  it('refuses whole rather than exporting a file with a gap in it', () => {
    /* The rule worth the most care. An output that does not prove as this
     * wallet's gets no record, and a record missing from the middle shifts
     * every record after it — which the far side pairs with the wrong
     * transfer, fails the ring signature on, and throws over. The own-wire
     * answer has no such problem, because it matches by key, so it still
     * answers the ones it can. */
    const { xmrAddress } = openSession();
    setNativeCnSlowHash(() => CHACHA_KEY);
    const stranger = walletFromSeed(new Uint8Array(32).fill(0x77));
    const outputs = [
      outputFor(xmrAddress, 0),
      outputFor(stranger.address, 1, 99),
      outputFor(xmrAddress, 2),
    ];
    const images = JSON.parse(api.moneroKeyImages(asRequestHex(outputs))) as ImagesReply;
    expect(images.answered, 'the own wire still answers what it can').toBe(2);
    expect(images.refused).toBe(1);

    const random = toHex(new Uint8Array(images.fileRandomBytes!).fill(0x33));
    const reply = JSON.parse(api.moneroKeyImageFile(random)) as FileReply;
    expect(reply.ok).toBe(false);
    expect(reply.frames).toBeUndefined();
    expect(reply.problem).toMatch(/1 of 3 outputs did not prove/);
    expect(reply.problem).toMatch(/matched by position/);
  });

  it('refuses a transfer offset that is not one', () => {
    const { xmrAddress } = openSession();
    for (const bad of [-1, 1.5, 'seven', 2_000_000]) {
      const reply = JSON.parse(
        api.moneroKeyImages(asRequestHex([outputFor(xmrAddress, 0)], bad as number)),
      ) as ImagesReply;
      expect(reply.ok, `offset ${bad} was accepted`).toBe(false);
      expect(reply.problem).toMatch(/transfer offset/);
    }
  });

  it('returns no secret of any kind across the bridge', () => {
    /* The file is encrypted under a key derived from the view secret and the
     * records carry ring signatures made with ephemeral spend keys. None of
     * those may appear in a reply, and the frames are base32 of the encrypted
     * body, so a leak would be visible as hex. */
    const { xmrAddress } = openSession();
    setNativeCnSlowHash(() => CHACHA_KEY);
    const images = JSON.parse(api.moneroKeyImages(asRequestHex([outputFor(xmrAddress, 0)]))) as ImagesReply;
    const random = toHex(new Uint8Array(images.fileRandomBytes!).fill(0x44));
    const raw = api.moneroKeyImageFile(random);
    const wallet = sessionWallet();
    expect(raw).not.toContain(toHex(wallet.viewSecret));
    expect(raw).not.toContain(toHex(wallet.spendSecret));
    expect(raw).not.toContain(toHex(CHACHA_KEY));
  });
});
