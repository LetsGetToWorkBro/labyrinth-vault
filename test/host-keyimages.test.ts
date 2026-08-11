/**
 * The key image host function, called the way Swift calls it.
 *
 * Everything crosses as strings, the session gate is real, and the reply
 * frames have to reassemble into the same bytes the engine encoded. This is
 * the file that would catch a host function that works in unit tests and
 * fails at the boundary: an argument that is not a string, a reply that does
 * not survive JSON, a refusal that throws instead of refusing.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { api, resetHost } from '../src/bridge/host';
import { Collector } from '../src/airgap/envelope';
import { parseKeyImageReply, KEYIMAGE_VERSION } from '../src/keys/keyimages';
import {
  fromHex,
  parseAddress,
  publicFromSecret,
  reduceScalar,
  toHex,
} from '../src/keys/monero';
import { derivePublicKey, generateKeyDerivation } from '../src/keys/monerocrypto';
import { passphraseToBytes } from '../src/keys/seal';

afterEach(() => resetHost());

const hex = (length: number, fill: number) => toHex(new Uint8Array(length).fill(fill));

/** Open a session the way the app does: create a vault, then unlock it. */
function openSession(): { xmrAddress: string } {
  const pass = Array.from(passphraseToBytes('correct horse battery staple'));
  const created = JSON.parse(api.create(hex(88, 0x5a), pass, '')) as {
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

/** A sender paying the session's wallet, from nothing but its address. */
function outputFor(address: string, index: number) {
  const parsed = parseAddress(address);
  const secret = reduceScalar(new Uint8Array(32).map((_, i) => (i * 7 + 13) & 0xff));
  const derivation = generateKeyDerivation(fromHex(parsed.viewPublic!), secret);
  return {
    tx: toHex(publicFromSecret(secret)),
    index,
    key: toHex(derivePublicKey(derivation, index, fromHex(parsed.spendPublic!))),
  };
}

const asRequestHex = (outputs: unknown): string =>
  toHex(new TextEncoder().encode(JSON.stringify({ v: KEYIMAGE_VERSION, chain: 'xmr', outputs })));

describe('moneroKeyImages over the bridge', () => {
  it('refuses when the vault is locked, in a sentence', () => {
    const reply = JSON.parse(api.moneroKeyImages(asRequestHex([]))) as {
      ok: boolean;
      problem?: string;
    };
    expect(reply.ok).toBe(false);
    expect(reply.problem).toMatch(/locked/i);
  });

  it('answers with frames that reassemble into a reply about our output', () => {
    const { xmrAddress } = openSession();
    const output = outputFor(xmrAddress, 0);
    const reply = JSON.parse(api.moneroKeyImages(asRequestHex([output]))) as {
      ok: boolean;
      answered: number;
      refused: number;
      frames: string[];
    };
    expect(reply.ok).toBe(true);
    expect(reply.answered).toBe(1);
    expect(reply.refused).toBe(0);

    /* The frames are the product. Walk them through the same collector the
     * wallet uses, and the payload has to parse as a reply naming the output
     * that was asked about. */
    const collector = new Collector();
    let payload: Uint8Array | null = null;
    for (const frame of reply.frames) payload = collector.offer(frame).payload ?? payload;
    expect(payload).not.toBeNull();

    const parsed = parseKeyImageReply(payload!);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.reply.images).toHaveLength(1);
      expect(parsed.reply.images[0]!.key).toBe(output.key);
    }
  });

  it('reports a refused count for an output that is not ours', () => {
    const { xmrAddress } = openSession();
    const output = outputFor(xmrAddress, 0);
    const tampered = { ...output, index: 5 };
    const reply = JSON.parse(api.moneroKeyImages(asRequestHex([output, tampered]))) as {
      ok: boolean;
      answered: number;
      refused: number;
    };
    expect(reply.ok).toBe(true);
    expect(reply.answered).toBe(1);
    expect(reply.refused).toBe(1);
  });

  it('refuses garbage without throwing across the bridge', () => {
    openSession();
    for (const bad of ['', 'zz', 'deadbeef', toHex(new TextEncoder().encode('[]'))]) {
      const reply = JSON.parse(api.moneroKeyImages(bad)) as { ok: boolean; problem?: string };
      expect(reply.ok).toBe(false);
      expect(typeof reply.problem).toBe('string');
    }
  });

  it('is gone after lock, like everything else the session holds', () => {
    const { xmrAddress } = openSession();
    api.lock();
    const reply = JSON.parse(api.moneroKeyImages(asRequestHex([outputFor(xmrAddress, 0)]))) as {
      ok: boolean;
      problem?: string;
    };
    expect(reply.ok).toBe(false);
    expect(reply.problem).toMatch(/locked/i);
  });
});
