/**
 * The Monero signing pair over the bridge, called the way Swift calls it.
 *
 * Same posture as `host-keyimages.test.ts`: strings in, JSON out, the session
 * gate real, and the frames the product. The describe-then-sign contract is
 * the part worth testing at this boundary: signing without describing fails,
 * signing with a stale digest fails, and the digest that works is the digest
 * of the exact bytes that were described.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { api, resetHost } from '../src/bridge/host';
import { Collector } from '../src/airgap/envelope';
import { signingRandomCount, SIGNED_VERSION } from '../src/keys/monerobuild';
import {
  fromHex,
  parseAddress,
  publicFromSecret,
  reduceScalar,
  toHex,
  walletFromSeed,
} from '../src/keys/monero';
import {
  commit,
  commitmentMask,
  derivationToScalar,
  derivePublicKey,
  generateKeyDerivation,
} from '../src/keys/monerocrypto';
import { passphraseToBytes } from '../src/keys/seal';

afterEach(() => resetHost());

const hex = (length: number, fill: number) => toHex(new Uint8Array(length).fill(fill));

function detBytes(seed: number): Uint8Array {
  const b = new Uint8Array(32);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < 32; i++) { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; b[i] = x & 0xff; }
  b[31] = b[31]! & 0x0f;
  return b;
}

function openSession(): { xmrAddress: string } {
  const pass = Array.from(passphraseToBytes('correct horse battery staple'));
  const created = JSON.parse(api.create(hex(88, 0x5a), pass, '')) as { ok: boolean; sealed?: string };
  expect(created.ok).toBe(true);
  const unlocked = JSON.parse(api.unlock(created.sealed!, pass)) as { ok: boolean; xmrAddress?: string };
  expect(unlocked.ok).toBe(true);
  return { xmrAddress: unlocked.xmrAddress! };
}

const PAYMENT = 600_000_000_000n;
const CHANGE = 399_280_000_000n;
const FEE = 720_000_000n;

/** An unsigned set spending an output that really derives from the session. */
function setFor(xmrAddress: string): Record<string, unknown> {
  const parsed = parseAddress(xmrAddress);
  const payerSecret = reduceScalar(new Uint8Array(32).map((_, i) => (i * 11 + 3) & 0xff));
  const derivation = generateKeyDerivation(fromHex(parsed.viewPublic!), payerSecret);
  const indexInTx = 0;
  const amount = PAYMENT + CHANGE + FEE;
  const key = toHex(derivePublicKey(derivation, indexInTx, fromHex(parsed.spendPublic!)));
  const mask = commitmentMask(derivationToScalar(derivation, indexInTx));
  const commitment = toHex(commit(amount, mask));

  const realPosition = 7;
  const ring = Array.from({ length: 16 }, (_, i) => i === realPosition
    ? { globalIndex: 5_000_000 + i * 3, key, commitment }
    : {
        globalIndex: 5_000_000 + i * 3,
        key: toHex(publicFromSecret(detBytes(0x4000 + i * 2))),
        commitment: toHex(publicFromSecret(detBytes(0x4001 + i * 2))),
      });

  const receiver = walletFromSeed(detBytes(0xcafe), 'mainnet');
  return {
    v: 1,
    chain: 'xmr',
    network: 'mainnet',
    inputs: [{
      txPublicKey: toHex(publicFromSecret(payerSecret)),
      indexInTx,
      globalIndex: 5_000_000 + realPosition * 3,
      amount: amount.toString(),
      ring,
      realPosition,
    }],
    outputs: [
      { address: receiver.address, amount: PAYMENT.toString(), change: false },
      { address: xmrAddress, amount: CHANGE.toString(), change: true },
    ],
    fee: FEE.toString(),
    ringSize: 16,
  };
}

const asPayloadHex = (set: unknown): string => toHex(new TextEncoder().encode(JSON.stringify(set)));

function randomHexFor(): string {
  const need = signingRandomCount(1, 16, 2);
  let out = '';
  for (let i = 0; i < need; i++) out += toHex(detBytes(0x6000 + i));
  return out;
}

describe('moneroDescribe and moneroSign over the bridge', () => {
  it('refuses to describe when locked, and to sign undescribed', () => {
    const locked = JSON.parse(api.moneroDescribe('00')) as { ok: boolean; problem?: string };
    expect(locked.ok).toBe(false);
    expect(locked.problem).toMatch(/locked/i);

    openSession();
    const unsigned = JSON.parse(api.moneroSign('00'.repeat(32), randomHexFor())) as { ok: boolean; problem?: string };
    expect(unsigned.ok).toBe(false);
    expect(unsigned.problem).toMatch(/described/);
  });

  it('describes what will be paid, then signs exactly that', { timeout: 30_000 }, () => {
    const { xmrAddress } = openSession();
    const payloadHex = asPayloadHex(setFor(xmrAddress));

    const described = JSON.parse(api.moneroDescribe(payloadHex)) as {
      ok: boolean;
      digest: string;
      paying: string;
      fee: string;
      network: string;
      outputs: { address: string; change: boolean }[];
    };
    expect(described.ok).toBe(true);
    expect(described.paying).toBe(PAYMENT.toString());
    expect(described.fee).toBe(FEE.toString());
    expect(described.network).toBe('mainnet');
    expect(described.outputs.filter((o) => o.change)).toHaveLength(1);

    const signed = JSON.parse(api.moneroSign(described.digest, randomHexFor())) as {
      ok: boolean;
      txid: string;
      keyImages: string[];
      frames: string[];
    };
    expect(signed.ok).toBe(true);
    expect(signed.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.keyImages).toHaveLength(1);

    /* The frames are the product: they must reassemble into the XMRSIGNED
     * payload shape the wallet's `parseSignedTx` reads (that parser has its
     * own tests in the wallet package; the wire shape is pinned by both). */
    const collector = new Collector();
    let payload: Uint8Array | null = null;
    for (const frame of signed.frames) payload = collector.offer(frame).payload ?? payload;
    expect(payload).not.toBeNull();
    const parsed = JSON.parse(new TextDecoder().decode(payload!)) as Record<string, unknown>;
    expect(parsed['v']).toBe(SIGNED_VERSION);
    expect(parsed['chain']).toBe('xmr');
    expect(parsed['network']).toBe('mainnet');
    expect(parsed['txid']).toBe(signed.txid);
    expect(parsed['hex']).toMatch(/^[0-9a-f]{400,}$/);
    expect(parsed['keyImages']).toEqual(signed.keyImages);
  });

  it('refuses a signature for a digest that is not the described set', () => {
    const { xmrAddress } = openSession();
    const described = JSON.parse(api.moneroDescribe(asPayloadHex(setFor(xmrAddress)))) as { ok: boolean; digest: string };
    expect(described.ok).toBe(true);
    const wrong = described.digest.slice(0, -2) + (described.digest.endsWith('00') ? '01' : '00');
    const signed = JSON.parse(api.moneroSign(wrong, randomHexFor())) as { ok: boolean; problem?: string };
    expect(signed.ok).toBe(false);
    expect(signed.problem).toMatch(/approval|match/);
  });

  it('spends one approval on one signature', { timeout: 30_000 }, () => {
    const { xmrAddress } = openSession();
    const described = JSON.parse(api.moneroDescribe(asPayloadHex(setFor(xmrAddress)))) as { ok: boolean; digest: string };
    const first = JSON.parse(api.moneroSign(described.digest, randomHexFor())) as { ok: boolean };
    expect(first.ok).toBe(true);
    const second = JSON.parse(api.moneroSign(described.digest, randomHexFor())) as { ok: boolean; problem?: string };
    expect(second.ok).toBe(false);
    expect(second.problem).toMatch(/described/);
  });

  it('refuses short randomness in a sentence naming the number', () => {
    const { xmrAddress } = openSession();
    const described = JSON.parse(api.moneroDescribe(asPayloadHex(setFor(xmrAddress)))) as { ok: boolean; digest: string };
    const signed = JSON.parse(api.moneroSign(described.digest, 'ab'.repeat(64))) as { ok: boolean; problem?: string };
    expect(signed.ok).toBe(false);
    expect(signed.problem).toMatch(/randomness/);
  });

  it('refuses a set naming a network the wallet is not on', () => {
    const { xmrAddress } = openSession();
    const set = setFor(xmrAddress);
    set['network'] = 'stagenet';
    const described = JSON.parse(api.moneroDescribe(asPayloadHex(set))) as { ok: boolean; digest?: string };
    /* Describe passes (the set is well formed); the sign refuses, because the
     * addresses inside are mainnet addresses and the network says stagenet. */
    if (described.ok) {
      const signed = JSON.parse(api.moneroSign(described.digest!, randomHexFor())) as { ok: boolean; problem?: string };
      expect(signed.ok).toBe(false);
    } else {
      expect(described.ok).toBe(false);
    }
  });
});
