/**
 * The online half of a send, composed against a synthetic node.
 *
 * The pure pieces are tested on their own; this proves they meet the node
 * correctly, which is the seam that isolated tests cannot cover. It also holds
 * the two refusals that matter when a node is hostile or wrong: a node that
 * returns a different output at the real ring position than the one being
 * spent, and the mainnet broadcast gate that keeps unverified bytes off the
 * network with real value.
 */

import { describe, expect, it } from 'vitest';
import type { Reply, Request, Transport } from '../src/net/http';
import { planMoneroSpend } from '../src/core/moneroplan';
import { moneroBroadcastGate, MONERO_SEND_BROADCAST_VERIFIED } from '../src/core/moneroreadiness';
import type { SpendableOutput } from '../src/core/monerospend';

function rng(seed: number) {
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

interface NodeOptions {
  /** Return the wrong key for the real output, to test the refusal. */
  swapReal?: boolean;
  /** Mark a fetched output as not unlocked. */
  lockOne?: boolean;
}

/** A node with a big, dense output distribution and answers for get_outs. */
function fakeNode(realOutputs: SpendableOutput[], options: NodeOptions = {}): Transport {
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
        // 100k blocks, 30 outputs each: ~3M outputs, plenty to hide in.
        const blocks = 100_000;
        const cumulative: number[] = [];
        let total = 0;
        for (let i = 0; i < blocks; i++) { total += 30; cumulative.push(total); }
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
              if (real) {
                const key = options.swapReal ? hex64('ff') : real.key;
                return { key, mask: real.commitment, unlocked: !options.lockOne, height: 1 };
              }
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

describe('planning a spend end to end', () => {
  it('builds an unsigned set that balances and sends change home', async () => {
    const input = owned(2_000_000_000_000n, 1_000_001);
    const plan = await planMoneroSpend({
      transport: fakeNode([input]),
      ownAddress: OWN,
      network: 'mainnet',
      owned: [input],
      destinations: [{ address: THEM, amount: 1_000_000_000_000n }],
      feePerByte: 10n,
      uniform: rng(0x1234),
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const set = plan.set;

    // Balance closes.
    const inTotal = set.inputs.reduce((s, i) => s + BigInt(i.amount), 0n);
    const outTotal = set.outputs.reduce((s, o) => s + BigInt(o.amount), 0n);
    expect(inTotal).toBe(outTotal + BigInt(set.fee));

    // A full ring per input, the real one where it says.
    for (const wireInput of set.inputs) {
      expect(wireInput.ring).toHaveLength(16);
      expect(wireInput.ring[wireInput.realPosition]!.globalIndex).toBe(input.globalIndex);
    }

    // Change goes to OWN and nowhere else.
    const change = set.outputs.filter((o) => o.change);
    expect(change).toHaveLength(1);
    expect(change[0]!.address).toBe(OWN);
  });

  it('refuses when the node returns a different output at the real position', async () => {
    const input = owned(2_000_000_000_000n, 1_000_002);
    const plan = await planMoneroSpend({
      transport: fakeNode([input], { swapReal: true }),
      ownAddress: OWN,
      network: 'mainnet',
      owned: [input],
      destinations: [{ address: THEM, amount: 1_000_000_000_000n }],
      feePerByte: 10n,
      uniform: rng(0x1234),
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.problem).toMatch(/different output/);
  });

  it('refuses when a ring member is not spendable', async () => {
    const input = owned(2_000_000_000_000n, 1_000_003);
    const plan = await planMoneroSpend({
      transport: fakeNode([input], { lockOne: true }),
      ownAddress: OWN,
      network: 'mainnet',
      owned: [input],
      destinations: [{ address: THEM, amount: 1_000_000_000_000n }],
      feePerByte: 10n,
      uniform: rng(0x1234),
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.problem).toMatch(/spendable/);
  });

  it('refuses when the owned outputs cannot cover the send', async () => {
    const input = owned(500n, 1_000_004);
    const plan = await planMoneroSpend({
      transport: fakeNode([input]),
      ownAddress: OWN,
      network: 'mainnet',
      owned: [input],
      destinations: [{ address: THEM, amount: 1_000_000_000_000n }],
      feePerByte: 10n,
      uniform: rng(0x1234),
    });
    expect(plan.ok).toBe(false);
  });
});

describe('the mainnet broadcast gate', () => {
  it('is closed until a live acceptance is recorded', () => {
    /* This test is the gate's tripwire: when someone lifts the constant, they
     * have to change this line in the same commit, which is where the reviewer
     * asks to see the stagenet transaction id. */
    expect(MONERO_SEND_BROADCAST_VERIFIED).toBe(false);
    const gate = moneroBroadcastGate('mainnet');
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.problem).toMatch(/has not yet had a transaction accepted/);
  });

  it('leaves stagenet and testnet open, because that is where the evidence is made', () => {
    expect(moneroBroadcastGate('stagenet').allowed).toBe(true);
    expect(moneroBroadcastGate('testnet').allowed).toBe(true);
  });
});
