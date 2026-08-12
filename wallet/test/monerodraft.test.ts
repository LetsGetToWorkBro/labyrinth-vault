/**
 * The Monero draft, and the checks on what comes back.
 *
 * The plan half runs against the same fake node moneroplan.test.ts uses, so a
 * draft here is a real unsigned set: decoys drawn from a distribution, ring
 * members fetched, change to the account's own address. What the assertions
 * pin is the wrapping - the digest is keccak of the exact wire bytes, the
 * spent-coin record names the real ring members, the fee is the set's own.
 *
 * The verify half is adversarial, one test per lie: a wrong fee, a swapped
 * coin, an extra coin, a missing coin, an unparseable return, and a book
 * that cannot vouch for the plan. Each refuses with a sentence a person can
 * act on, and none of them can be talked into an ok.
 */

import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { toHex } from '@vault/keys/monero';
import { prepareMoneroDraft, verifySignedMonero, type MoneroSpendMaterials } from '../src/core/monerodraft';
import { SIGNED_VERSION, type SpendableOutput } from '../src/core/monerospend';
import type { Reply, Request, Transport } from '../src/net/http';
import type { Draft } from '../src/core/model';

const NOW = 1_700_000_000_000;

function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 0x100000000; };
}

const hex64 = (tag: string): string => (tag + '0'.repeat(64)).slice(0, 64);

function owned(amount: bigint, globalIndex: number): SpendableOutput {
  return {
    globalIndex,
    key: hex64(`a${globalIndex}`),
    commitment: hex64(`c${globalIndex}`),
    amount,
    txPublicKey: hex64(`b${globalIndex}`),
    indexInTx: 0,
  };
}

/** The same dense fake node the planner's own tests run against. */
function fakeNode(realOutputs: SpendableOutput[]): Transport {
  const byIndex = new Map(realOutputs.map((o) => [o.globalIndex, o]));
  const tip = 90_000;
  return {
    base: 'https://node.example',
    async send(request: Request): Promise<Reply> {
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (request.path === '/json_rpc' && body['method'] === 'get_info') {
        return { ok: true, status: 200, text: JSON.stringify({ result: { height: tip, target_height: 0, synchronized: true, mainnet: true, status: 'OK' } }) };
      }
      if (request.path === '/json_rpc' && body['method'] === 'get_output_distribution') {
        const cumulative: number[] = [];
        let total = 0;
        for (let i = 0; i < 100_000; i++) { total += 30; cumulative.push(total); }
        return { ok: true, status: 200, text: JSON.stringify({ result: { distributions: [{ distribution: cumulative, start_height: 0, base: 0 }] } }) };
      }
      if (request.path === '/get_outs') {
        const requested = (body['outputs'] ?? []) as { index: number }[];
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: 'OK',
            outs: requested.map((o, position) => {
              const real = byIndex.get(o.index);
              if (real) return { key: real.key, mask: real.commitment, unlocked: true, height: 1 };
              return { key: hex64(`de${position}`), mask: hex64(`ad${position}`), unlocked: true, height: 1 };
            }),
          }),
        };
      }
      return { ok: false, status: 404, problem: `no ${request.path}` };
    },
  };
}

const OWN = '4'.repeat(95);
const THEM = '8'.repeat(95);

function materials(coins: SpendableOutput[]): MoneroSpendMaterials {
  return {
    transport: fakeNode(coins),
    ownAddress: OWN,
    network: 'mainnet',
    owned: coins,
    feePerByte: 10n,
    uniform: rng(0x5eed),
  };
}

async function draftOf(): Promise<Draft> {
  const coins = [owned(2_000_000_000_000n, 1_000_001)];
  const planned = await prepareMoneroDraft(materials(coins), {
    recipient: THEM,
    amount: 1_000_000_000_000n,
    multiplier: 1,
    now: NOW,
  });
  if (!planned.ok) throw new Error(planned.problem);
  return planned.draft;
}

describe('preparing a Monero draft', () => {
  it('wraps a real planned set, digest over the exact wire bytes', async () => {
    const draft = await draftOf();
    expect(draft.asset).toBe('XMR');
    expect(draft.amount).toBe(1_000_000_000_000n);
    expect(draft.fee).toBeGreaterThan(0n);
    /* The name both halves use: keccak of the payload, exactly what the
     * vault's moneroDescribe computes over the same bytes. */
    expect(draft.digest).toBe(toHex(keccak_256(draft.unsigned)));
    /* The spent-coin record names the coin that was planned, and change has
     * nowhere to go but home. */
    expect(draft.spentKeys).toEqual([hex64('a1000001')]);
    expect(draft.changeAddresses).toEqual([OWN]);
    expect(draft.inputTotal).toBe(2_000_000_000_000n);
    /* And the payload is a set the vault's parser will recognize. */
    const parsed = JSON.parse(new TextDecoder().decode(draft.unsigned)) as { chain: string; outputs: unknown[] };
    expect(parsed.chain).toBe('xmr');
    expect(parsed.outputs.length).toBeGreaterThanOrEqual(2);
  });

  it('hands a planning refusal through as a sentence', async () => {
    const planned = await prepareMoneroDraft(materials([]), {
      recipient: THEM,
      amount: 1_000_000_000_000n,
      multiplier: 1,
      now: NOW,
    });
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.problem.length).toBeGreaterThan(10);
  });
});

describe('verifying the signed set that comes back', () => {
  const IMAGE = hex64('11');
  const OTHER_IMAGE = hex64('22');

  function signedReturn(overrides: Partial<{ fee: string; keyImages: string[]; network: string }> = {}): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({
      v: SIGNED_VERSION,
      chain: 'xmr',
      network: overrides.network ?? 'mainnet',
      txid: 'f'.repeat(64),
      hex: 'ab'.repeat(200),
      fee: overrides.fee ?? '720000000',
      keyImages: overrides.keyImages ?? [IMAGE],
    }));
  }

  function draftWith(): Draft {
    return {
      asset: 'XMR',
      recipient: THEM,
      amount: 1_000_000_000_000n,
      fee: 720_000_000n,
      feeRate: 1,
      unsigned: new Uint8Array([1]),
      digest: 'ab'.repeat(32),
      createdAt: NOW,
      inputs: [],
      inputTotal: 2_000_000_000_000n,
      changeAddresses: [OWN],
      spentKeys: [hex64('a1000001')],
    };
  }

  it('accepts the transaction that finishes the draft', () => {
    const verdict = verifySignedMonero(draftWith(), signedReturn(), [IMAGE]);
    expect(verdict.ok, verdict.ok ? '' : verdict.reasons.join(' / ')).toBe(true);
    if (verdict.ok) {
      expect(verdict.txid).toBe('f'.repeat(64));
      expect(verdict.fee).toBe(720_000_000n);
      expect(verdict.network).toBe('mainnet');
      expect(verdict.raw.length).toBe(200);
    }
  });

  it('refuses a fee that is not the approved fee, to the piconero', () => {
    const verdict = verifySignedMonero(draftWith(), signedReturn({ fee: '720000001' }), [IMAGE]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons.join(' ')).toMatch(/fee/);
  });

  it('refuses a transaction spending a coin nobody approved', () => {
    const verdict = verifySignedMonero(draftWith(), signedReturn({ keyImages: [OTHER_IMAGE] }), [IMAGE]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons.join(' ')).toMatch(/not in the payment you approved/);
  });

  it('refuses a transaction that spends more coins than were approved', () => {
    const verdict = verifySignedMonero(draftWith(), signedReturn({ keyImages: [IMAGE, OTHER_IMAGE] }), [IMAGE]);
    expect(verdict.ok).toBe(false);
  });

  it('refuses when the book cannot vouch for every planned coin', () => {
    /* One planned coin, no images: verification is impossible, and impossible
     * is a refusal with directions, never a shrug and a pass. */
    const verdict = verifySignedMonero(draftWith(), signedReturn(), []);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons.join(' ')).toMatch(/key image/i);
  });

  it('refuses bytes that are not a signed set at all', () => {
    const verdict = verifySignedMonero(draftWith(), new Uint8Array([9, 9, 9]), [IMAGE]);
    expect(verdict.ok).toBe(false);
  });
});
