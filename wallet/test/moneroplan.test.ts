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

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Reply, Request, Transport } from '../src/net/http';
import { forgetOutputDistribution, planMoneroSpend } from '../src/core/moneroplan';
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
  /** Report the real output as freshly mined, to test the maturity refusal. */
  youngReal?: boolean;
  /** The chain length this node reports, for the distribution cache tests. */
  height?: number;
  /** Which node this is, so the cache can be shown to be keyed on it. */
  base?: string;
  /** Counted per node, because the distribution is the expensive call. */
  counts?: { distribution: number };
}

/** A node with a big, dense output distribution and answers for get_outs. */
function fakeNode(realOutputs: SpendableOutput[], options: NodeOptions = {}): Transport {
  const byIndex = new Map(realOutputs.map((o) => [o.globalIndex, o]));
  const tip = options.height ?? 90_000;
  return {
    base: options.base ?? 'https://node.example',
    async send(request: Request): Promise<Reply> {
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (request.path === '/json_rpc' && body['method'] === 'get_info') {
        return { ok: true, status: 200, text: JSON.stringify({ result: { height: tip, target_height: 0, synchronized: true, mainnet: true, status: 'OK' } }) };
      }
      if (request.path === '/json_rpc' && body['method'] === 'get_output_distribution') {
        if (options.counts) options.counts.distribution += 1;
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
                const height = options.youngReal ? tip - 3 : 1;
                return { key, mask: real.commitment, unlocked: !options.lockOne, height };
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

/* The distribution cache lives for the module's lifetime, which is the whole
 * file here. Cleared between tests so no test is quietly answered by a
 * fixture another test fetched. */
beforeEach(() => forgetOutputDistribution());

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

  it('refuses to spend an output that is not yet mature', async () => {
    const input = owned(2_000_000_000_000n, 1_000_007);
    const plan = await planMoneroSpend({
      transport: fakeNode([input], { youngReal: true }),
      ownAddress: OWN,
      network: 'mainnet',
      owned: [input],
      destinations: [{ address: THEM, amount: 1_000_000_000_000n }],
      feePerByte: 10n,
      uniform: rng(0x1234),
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.problem).toMatch(/deep and needs/);
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

describe('the output distribution, which is the expensive call', () => {
  const planWith = (transport: Transport, globalIndex: number) => {
    const input = owned(2_000_000_000_000n, globalIndex);
    return planMoneroSpend({
      transport,
      ownAddress: OWN,
      network: 'mainnet',
      owned: [input],
      destinations: [{ address: THEM, amount: 1_000_000_000_000n }],
      feePerByte: 10n,
      uniform: rng(0x1234),
    });
  };

  it('fetches it once for a node and a height, not once per attempt', async () => {
    /* At mainnet scale this answer is over two million entries and about
     * twenty megabytes of JSON, buffered whole under a twelve second timeout.
     * It ran on every press of REVIEW, so composing a payment, backing out and
     * composing it again paid for it twice on a phone connection. */
    const counts = { distribution: 0 };
    const node = fakeNode([owned(2_000_000_000_000n, 1_000_010), owned(2_000_000_000_000n, 1_000_011)], { counts });

    expect((await planWith(node, 1_000_010)).ok).toBe(true);
    expect(counts.distribution).toBe(1);
    expect((await planWith(node, 1_000_011)).ok).toBe(true);
    expect(counts.distribution).toBe(1);
  });

  it('fetches it again once a block has been mined', async () => {
    /* Tighter than a clock on purpose. A distribution that lags the chain
     * cannot draw a decoy from the newest outputs, and a ring whose members
     * all stop short of the real output's age is a ring that says which member
     * is real. The tip moving is what expires this. */
    const counts = { distribution: 0 };
    const coin = owned(2_000_000_000_000n, 1_000_012);
    expect((await planWith(fakeNode([coin], { counts, height: 90_000 }), 1_000_012)).ok).toBe(true);
    expect(counts.distribution).toBe(1);
    expect((await planWith(fakeNode([coin], { counts, height: 90_001 }), 1_000_012)).ok).toBe(true);
    expect(counts.distribution).toBe(2);
  });

  it('does not serve one node the distribution another node gave', async () => {
    const counts = { distribution: 0 };
    const coin = owned(2_000_000_000_000n, 1_000_013);
    expect((await planWith(fakeNode([coin], { counts }), 1_000_013)).ok).toBe(true);
    const other = fakeNode([coin], { counts, base: 'https://elsewhere.example' });
    expect((await planWith(other, 1_000_013)).ok).toBe(true);
    expect(counts.distribution).toBe(2);
  });

  it('does not remember an answer that failed', async () => {
    /* Caching a refusal would turn one bad minute on a node into a send path
     * that will not plan anything until the next block. */
    const counts = { distribution: 0 };
    const coin = owned(2_000_000_000_000n, 1_000_014);
    const good = fakeNode([coin], { counts });
    const flaky: Transport = {
      base: good.base,
      async send(request) {
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (body['method'] === 'get_output_distribution') {
          counts.distribution += 1;
          return { ok: false, status: 500, problem: 'the node fell over' };
        }
        return good.send(request);
      },
    };

    expect((await planWith(flaky, 1_000_014)).ok).toBe(false);
    expect(counts.distribution).toBe(1);
    expect((await planWith(good, 1_000_014)).ok).toBe(true);
    expect(counts.distribution).toBe(2);
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

describe('the cached distribution has somewhere to go', () => {
  /*
   * W-M20's other half. `forgetOutputDistribution` was written and exported
   * so that the twenty megabytes of numbers the send path caches could be
   * handed back, and nothing called it, so the array was held until the tip
   * moved whatever the person did next. A function with no caller is not a
   * feature: it is the appearance of one.
   *
   * Three doors, and each is a different reason the answer is no longer
   * wanted. Read off the source rather than driven, because the store is a
   * React tree this package has no harness for, and a wiring check that
   * cannot run is still better than a comment.
   */
  const store = readFileSync('src/state/store.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('is imported by the store at all', () => {
    expect(store).toMatch(/import \{ forgetOutputDistribution \} from '\.\.\/core\/moneroplan'/);
  });

  it('lets go when the payment ends', () => {
    /* `reset` is every way out of a payment: the screen closing, DISCARD, a
     * finished broadcast. Hung off the store's own `send` rather than off a
     * screen, so it does not depend on which screen was on top. */
    expect(store).toMatch(/if \(event\.type === 'reset'\) forgetOutputDistribution\(\)/);
    expect(store, 'the raw dispatch is exposed again, and nothing hangs off reset').not.toMatch(
      /send: dispatch,/,
    );
  });

  it('lets go when the Monero node changes', () => {
    expect(store).toMatch(/if \(kind === 'monerod'\) forgetOutputDistribution\(\)/);
  });

  it('lets go when everything stored is forgotten', () => {
    const forget = /forgetStored: \(\) => \{[\s\S]*?\n    \},/.exec(store)?.[0] ?? '';
    expect(forget, 'forgetStored was not found').toBeTruthy();
    expect(forget).toMatch(/forgetOutputDistribution\(\)/);
  });
});
