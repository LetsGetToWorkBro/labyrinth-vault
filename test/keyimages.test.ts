/**
 * The key image round trip, tested from both ends of the wire.
 *
 * The sender in these tests is the same arithmetic the wallet's scanner is
 * tested with: a transaction is built the way a real sender builds one, paying
 * a wallet whose seed is written out below, and the vault is asked for the key
 * images of what a scan of that transaction would have found.
 *
 * The tests that matter most are the refusals. `computeKeyImages` touches the
 * spend secret, and the property being held is that it does arithmetic only on
 * outputs it has re-proved are this wallet's own: a tampered one-time key, a
 * shifted index, a stranger's output all come back refused, individually,
 * without taking the honest entries in the same request down with them.
 */

import { describe, expect, it } from 'vitest';
import { encodeParts, parsePart } from '../src/airgap/envelope';
import {
  computeKeyImages,
  encodeKeyImageReply,
  encodeKeyImageRequest,
  parseKeyImageReply,
  parseKeyImageRequest,
  KEYIMAGE_VERSION,
  MAX_OUTPUTS,
  type KeyImageRequest,
} from '../src/keys/keyimages';
import {
  fromHex,
  publicFromSecret,
  reduceScalar,
  toHex,
  walletFromSeed,
} from '../src/keys/monero';
import {
  derivePublicKey,
  deriveSecretKey,
  generateKeyDerivation,
  generateKeyImage,
} from '../src/keys/monerocrypto';

const wallet = walletFromSeed(new Uint8Array(32).map((_, i) => (i * 11 + 3) & 0xff));
const stranger = walletFromSeed(new Uint8Array(32).fill(7));

/** A sender paying `to` at output `index`, returning what a scan would find. */
function paidOutput(to: typeof wallet, index: number, ephemeral = 5) {
  const secret = reduceScalar(new Uint8Array(32).map((_, i) => (i * 3 + ephemeral) & 0xff));
  const txPublic = toHex(publicFromSecret(secret));
  const derivation = generateKeyDerivation(fromHex(to.viewPublic), secret);
  const oneTime = toHex(derivePublicKey(derivation, index, fromHex(to.spendPublic)));
  return { tx: txPublic, index, key: oneTime };
}

const request = (outputs: KeyImageRequest['outputs']): KeyImageRequest => ({
  v: KEYIMAGE_VERSION,
  chain: 'xmr',
  outputs,
});

describe('computing key images', () => {
  it('answers for an output that is really ours', () => {
    const output = paidOutput(wallet, 0);
    const reply = computeKeyImages(wallet, request([output]));

    expect(reply.refused).toEqual([]);
    expect(reply.images).toHaveLength(1);
    expect(reply.images[0]!.key).toBe(output.key);
    expect(reply.images[0]!.image).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computes the image the primitives say it should be', () => {
    /* The same chain of vector-pinned operations, composed independently
     * here. This proves the plumbing between them — the right derivation into
     * the right index into the right base key — since the operations
     * themselves are each pinned to the Monero project's own vectors. */
    const output = paidOutput(wallet, 3);
    const reply = computeKeyImages(wallet, request([output]));

    const derivation = generateKeyDerivation(fromHex(output.tx), wallet.viewSecret);
    const oneTimeSecret = deriveSecretKey(derivation, 3, wallet.spendSecret);
    const expected = toHex(generateKeyImage(fromHex(output.key), oneTimeSecret));
    expect(reply.images[0]!.image).toBe(expected);
  });

  it('is deterministic, and different outputs get different images', () => {
    const one = paidOutput(wallet, 0);
    const two = paidOutput(wallet, 1);
    const first = computeKeyImages(wallet, request([one, two]));
    const second = computeKeyImages(wallet, request([one, two]));

    expect(first.images).toEqual(second.images);
    expect(first.images[0]!.image).not.toBe(first.images[1]!.image);
  });

  it('refuses an output that belongs to somebody else', () => {
    const theirs = paidOutput(stranger, 0);
    const reply = computeKeyImages(wallet, request([theirs]));
    expect(reply.images).toEqual([]);
    expect(reply.refused).toEqual([theirs.key]);
  });

  it('refuses a tampered one-time key rather than doing arithmetic on it', () => {
    /* The check this file exists for. Without it, a compromised wallet could
     * ask the spend key to operate on a point somebody chose. */
    const output = paidOutput(wallet, 0);
    const tampered = { ...output, key: output.key.slice(0, 63) + (output.key.endsWith('0') ? '1' : '0') };
    const reply = computeKeyImages(wallet, request([tampered]));
    expect(reply.images).toEqual([]);
    expect(reply.refused).toEqual([tampered.key]);
  });

  it('refuses a shifted index, which claims a different one-time address', () => {
    const output = paidOutput(wallet, 2);
    const reply = computeKeyImages(wallet, request([{ ...output, index: 4 }]));
    expect(reply.images).toEqual([]);
    expect(reply.refused).toHaveLength(1);
  });

  it('refuses one bad entry without taking the good ones down', () => {
    const good = paidOutput(wallet, 0);
    const bad = paidOutput(stranger, 0);
    const alsoGood = paidOutput(wallet, 1);
    const reply = computeKeyImages(wallet, request([good, bad, alsoGood]));

    expect(reply.images.map((entry) => entry.key)).toEqual([good.key, alsoGood.key]);
    expect(reply.refused).toEqual([bad.key]);
  });

  it('survives a transaction key that is not a point', () => {
    const output = { ...paidOutput(wallet, 0), tx: 'ff'.repeat(32) };
    const reply = computeKeyImages(wallet, request([output]));
    expect(reply.images).toEqual([]);
    expect(reply.refused).toHaveLength(1);
  });
});

describe('the request format', () => {
  const good = () => request([paidOutput(wallet, 0)]);

  it('round trips', () => {
    const parsed = parseKeyImageRequest(encodeKeyImageRequest(good()));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.request).toEqual(good());
  });

  it('refuses bytes that are not a request at all', () => {
    for (const bytes of [new Uint8Array([1, 2, 3]), new TextEncoder().encode('"a string"'), new TextEncoder().encode('null')]) {
      expect(parseKeyImageRequest(bytes).ok).toBe(false);
    }
  });

  it('refuses a version from the future rather than guessing at it', () => {
    const wrong = { ...good(), v: KEYIMAGE_VERSION + 1 };
    expect(parseKeyImageRequest(encodeKeyImageRequest(wrong)).ok).toBe(false);
  });

  it('refuses an empty list, which is a request for nothing', () => {
    expect(parseKeyImageRequest(encodeKeyImageRequest(request([]))).ok).toBe(false);
  });

  it('caps the batch, because each entry costs this device curve arithmetic', () => {
    const output = paidOutput(wallet, 0);
    const flood = request(Array.from({ length: MAX_OUTPUTS + 1 }, () => output));
    const parsed = parseKeyImageRequest(encodeKeyImageRequest(flood));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toContain(String(MAX_OUTPUTS));
  });

  it('refuses malformed keys and indices with a sentence, not an exception', () => {
    const output = paidOutput(wallet, 0);
    const cases: unknown[] = [
      [{ ...output, key: 'zz'.repeat(32) }],
      [{ ...output, tx: 'abc' }],
      [{ ...output, index: -1 }],
      [{ ...output, index: 1.5 }],
      [{ ...output, index: 999_999 }],
    ];
    for (const outputs of cases) {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ v: KEYIMAGE_VERSION, chain: 'xmr', outputs }),
      );
      const parsed = parseKeyImageRequest(bytes);
      expect(parsed.ok).toBe(false);
    }
  });

  it('lower-cases hex on the way in, so matching later is exact', () => {
    const output = paidOutput(wallet, 0);
    const shouting = request([{ ...output, key: output.key.toUpperCase(), tx: output.tx.toUpperCase() }]);
    const parsed = parseKeyImageRequest(encodeKeyImageRequest(shouting));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.request.outputs[0]!.key).toBe(output.key);
  });
});

describe('the reply format', () => {
  it('round trips, refusals included', () => {
    const reply = computeKeyImages(wallet, request([paidOutput(wallet, 0), paidOutput(stranger, 1)]));
    const parsed = parseKeyImageReply(encodeKeyImageReply(reply));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.reply).toEqual(reply);
  });

  it('refuses a reply whose entries are not key-and-image pairs', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ v: 1, chain: 'xmr', images: [{ key: 'ab', image: 'cd' }] }),
    );
    expect(parseKeyImageReply(bytes).ok).toBe(false);
  });

  it('travels the wire as frames a collector reassembles', () => {
    const reply = computeKeyImages(wallet, request([paidOutput(wallet, 0)]));
    const frames = encodeParts('XMRKEYIMAGES', encodeKeyImageReply(reply));
    expect(frames.length).toBeGreaterThan(0);
    expect(parsePart(frames[0]!)?.kind).toBe('XMRKEYIMAGES');
  });

  it('has a request kind too, and a reader tells them apart', () => {
    const frames = encodeParts('XMROUTPUTS', encodeKeyImageRequest(request([paidOutput(wallet, 0)])));
    expect(parsePart(frames[0]!)?.kind).toBe('XMROUTPUTS');
  });
});
