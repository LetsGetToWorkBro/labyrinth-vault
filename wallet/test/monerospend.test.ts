/**
 * Building an unsigned Monero spend, with the money-loss surfaces nailed down.
 *
 * The crypto in a spend rejects if it is wrong; the arithmetic here loses money
 * if it is wrong. So this file is heavier on the boring parts than on anything
 * cryptographic: change goes to the owner and nowhere else, the balance closes
 * to the piconero, dust change folds into the fee rather than becoming a
 * useless output, and the unsigned set round-trips through its own parser
 * without gaining or losing a satoshi of Monero.
 */

import { describe, expect, it } from 'vitest';
import {
  DUST,
  assembleUnsigned,
  encodeUnsigned,
  estimateWeight,
  feeFor,
  parseSignedTx,
  parseUnsigned,
  selectInputs,
  UNSIGNED_VERSION,
  type Ring,
  type SpendableOutput,
} from '../src/core/monerospend';
import type { ChainOutput } from '../src/net/monerod';

let counter = 0;
const hex64 = (tag: string): string => (tag + '0'.repeat(64)).slice(0, 64);

function owned(amount: bigint, globalIndex = counter++): SpendableOutput {
  return {
    globalIndex,
    key: hex64(`a${globalIndex}`),
    commitment: hex64(`c${globalIndex}`),
    amount,
    txPublicKey: hex64(`b${globalIndex}`),
    indexInTx: 0,
  };
}

function ringFor(real: SpendableOutput, size = 16): Ring {
  const members: ChainOutput[] = [];
  let realPosition = 0;
  for (let i = 0; i < size; i++) {
    if (i === 3) {
      realPosition = i;
      members.push({ globalIndex: real.globalIndex, key: real.key, commitment: real.commitment, unlocked: true, height: 1 });
    } else {
      members.push({ globalIndex: 900000 + i, key: hex64(`d${i}`), commitment: hex64(`e${i}`), unlocked: true, height: 1 });
    }
  }
  return { members, realPosition };
}

const OWN = '4'.repeat(95);
const THEM = '8'.repeat(95);

describe('the fee grows with the transaction', () => {
  it('is heavier with more inputs and more outputs', () => {
    expect(estimateWeight(2, 2)).toBeGreaterThan(estimateWeight(1, 2));
    expect(estimateWeight(1, 3)).toBeGreaterThan(estimateWeight(1, 2));
  });

  it('scales linearly in the per-byte rate', () => {
    expect(feeFor(1, 2, 2n)).toBe(feeFor(1, 2, 1n) * 2n);
  });

  it('scales with priority', () => {
    expect(feeFor(1, 2, 10n, 5)).toBe(feeFor(1, 2, 10n, 1) * 5n);
  });
});

describe('coin selection', () => {
  it('covers the amount plus fee and returns the change', () => {
    const plan = selectInputs([owned(2_000_000_000_000n)], 1_000_000_000_000n, 10n);
    expect(plan.ok).toBe(true);
    // change = input - sending - fee, all accounted
    expect(2_000_000_000_000n).toBe(1_000_000_000_000n + plan.fee + plan.change);
  });

  it('adds inputs until they cover the target', () => {
    const plan = selectInputs([owned(400n * 10n ** 9n), owned(400n * 10n ** 9n), owned(400n * 10n ** 9n)], 1_000n * 10n ** 9n, 5n);
    expect(plan.ok).toBe(true);
    expect(plan.inputs.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses when the outputs cannot cover it', () => {
    const plan = selectInputs([owned(500n)], 1_000_000_000_000n, 10n);
    expect(plan.ok).toBe(false);
    expect(plan.problem).toMatch(/Not enough/);
  });

  it('folds dust-sized change into the fee rather than making a useless output', () => {
    /* Engineer a near-exact match so the leftover is below DUST. The plan must
     * report zero change and a fee that absorbed it, not a dust output. */
    const perByte = 1n;
    const sending = 1_000_000n;
    const feeGuess = feeFor(1, 2, perByte);
    const input = owned(sending + feeGuess + DUST - 1n);
    const plan = selectInputs([input], sending, perByte);
    expect(plan.ok).toBe(true);
    expect(plan.change).toBe(0n);
    expect(input.amount).toBe(sending + plan.fee);
  });

  it('refuses to send nothing', () => {
    expect(selectInputs([owned(10n)], 0n, 1n).ok).toBe(false);
  });
});

describe('assembling the unsigned set', () => {
  function plan(sending: bigint, perByte: bigint) {
    const inputs = [owned(sending * 3n)];
    const selected = selectInputs(inputs, sending, perByte);
    if (!selected.ok) throw new Error(selected.problem!);
    const rings = selected.inputs.map((i) => ringFor(i));
    return { selected, rings, inputs: selected.inputs };
  }

  it('sends change to the owner and no one else', () => {
    const { selected, rings } = plan(1_000_000_000_000n, 10n);
    const set = assembleUnsigned({
      inputs: selected.inputs,
      rings,
      destinations: [{ address: THEM, amount: 1_000_000_000_000n }],
      change: selected.change,
      ownAddress: OWN,
      fee: selected.fee,
      network: 'mainnet',
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const changeOutputs = set.set.outputs.filter((o) => o.change);
    expect(changeOutputs).toHaveLength(1);
    expect(changeOutputs[0]!.address).toBe(OWN);
    /* And the only output paying OWN is the change one; nothing else leaks
     * there and no destination was silently rewritten. */
    expect(set.set.outputs.filter((o) => o.address === OWN)).toHaveLength(1);
  });

  it('refuses a set whose inputs do not balance the outputs and fee', () => {
    const { selected, rings } = plan(1_000_000_000_000n, 10n);
    const set = assembleUnsigned({
      inputs: selected.inputs,
      rings,
      destinations: [{ address: THEM, amount: 1_000_000_000_000n }],
      change: selected.change + 1n, // deliberately wrong
      ownAddress: OWN,
      fee: selected.fee,
      network: 'mainnet',
    });
    expect(set.ok).toBe(false);
    if (!set.ok) expect(set.problem).toMatch(/do not balance/);
  });

  it('refuses when a ring does not hold the real output where it claims', () => {
    const { selected, rings } = plan(1_000_000_000_000n, 10n);
    const broken = rings.map((r) => ({ ...r, realPosition: (r.realPosition + 1) % r.members.length }));
    const set = assembleUnsigned({
      inputs: selected.inputs,
      rings: broken,
      destinations: [{ address: THEM, amount: 1_000_000_000_000n }],
      change: selected.change,
      ownAddress: OWN,
      fee: selected.fee,
      network: 'mainnet',
    });
    expect(set.ok).toBe(false);
    if (!set.ok) expect(set.problem).toMatch(/real output/);
  });

  it('produces no change output when the inputs match exactly', () => {
    const perByte = 1n;
    const sending = 5_000_000n;
    const fee = feeFor(1, 2, perByte);
    const input = owned(sending + fee);
    const selected = selectInputs([input], sending, perByte);
    expect(selected.ok).toBe(true);
    const set = assembleUnsigned({
      inputs: selected.inputs,
      rings: selected.inputs.map((i) => ringFor(i)),
      destinations: [{ address: THEM, amount: sending }],
      change: selected.change,
      ownAddress: OWN,
      fee: selected.fee,
      network: 'mainnet',
    });
    expect(set.ok).toBe(true);
    if (set.ok) expect(set.set.outputs.filter((o) => o.change)).toHaveLength(0);
  });
});

describe('the unsigned set crosses the wire intact', () => {
  function built() {
    const input = owned(3_000_000_000_000n);
    const selected = selectInputs([input], 1_000_000_000_000n, 10n);
    if (!selected.ok) throw new Error('setup');
    const set = assembleUnsigned({
      inputs: selected.inputs,
      rings: selected.inputs.map((i) => ringFor(i)),
      destinations: [{ address: THEM, amount: 1_000_000_000_000n }],
      change: selected.change,
      ownAddress: OWN,
      fee: selected.fee,
      network: 'stagenet',
    });
    if (!set.ok) throw new Error('setup');
    return set.set;
  }

  it('round-trips through encode and parse', () => {
    const set = built();
    const parsed = parseUnsigned(encodeUnsigned(set));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.set).toEqual(set);
  });

  it('preserves every amount to the piconero', () => {
    const set = built();
    const parsed = parseUnsigned(encodeUnsigned(set));
    if (!parsed.ok) throw new Error('parse');
    const inTotal = parsed.set.inputs.reduce((s, i) => s + BigInt(i.amount), 0n);
    const outTotal = parsed.set.outputs.reduce((s, o) => s + BigInt(o.amount), 0n);
    expect(inTotal).toBe(outTotal + BigInt(parsed.set.fee));
  });

  it('refuses bytes that are not an unsigned set', () => {
    for (const bad of [new Uint8Array([1, 2, 3]), new TextEncoder().encode('{}'), new TextEncoder().encode('null')]) {
      expect(parseUnsigned(bad).ok).toBe(false);
    }
  });

  it('refuses a ring of the wrong size, an amount that is not a number, a bad network', () => {
    const set = built();
    const encoded = () => JSON.parse(new TextDecoder().decode(encodeUnsigned(set)));

    const shortRing = encoded();
    shortRing.inputs[0].ring.pop();
    expect(parseUnsigned(new TextEncoder().encode(JSON.stringify(shortRing))).ok).toBe(false);

    const badAmount = encoded();
    badAmount.outputs[0].amount = 'lots';
    expect(parseUnsigned(new TextEncoder().encode(JSON.stringify(badAmount))).ok).toBe(false);

    const badNet = encoded();
    badNet.network = 'regtest';
    expect(parseUnsigned(new TextEncoder().encode(JSON.stringify(badNet))).ok).toBe(false);
  });

  it('carries the version so an older vault refuses rather than misreads', () => {
    const set = built();
    expect(set.v).toBe(UNSIGNED_VERSION);
    const wrong = JSON.parse(new TextDecoder().decode(encodeUnsigned(set)));
    wrong.v = UNSIGNED_VERSION + 1;
    expect(parseUnsigned(new TextEncoder().encode(JSON.stringify(wrong))).ok).toBe(false);
  });
});

describe('reading the signed transaction back from the vault', () => {
  const valid = {
    v: 1,
    chain: 'xmr',
    network: 'stagenet',
    txid: 'a'.repeat(64),
    hex: 'ab'.repeat(1200),
    fee: '720000000',
    keyImages: ['b'.repeat(64)],
  };
  const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

  it('accepts what the vault emits', () => {
    const parsed = parseSignedTx(bytes(valid));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.tx.txid).toBe(valid.txid);
      expect(parsed.tx.network).toBe('stagenet');
      expect(parsed.tx.keyImages).toEqual(valid.keyImages);
    }
  });

  it('refuses garbage, the wrong chain, the wrong version', () => {
    expect(parseSignedTx(new Uint8Array([0x7b])).ok).toBe(false);
    expect(parseSignedTx(bytes({ ...valid, chain: 'btc' })).ok).toBe(false);
    expect(parseSignedTx(bytes({ ...valid, v: 2 })).ok).toBe(false);
  });

  it('refuses a malformed id, bytes, or key image', () => {
    expect(parseSignedTx(bytes({ ...valid, txid: 'short' })).ok).toBe(false);
    expect(parseSignedTx(bytes({ ...valid, hex: 'zz' })).ok).toBe(false);
    expect(parseSignedTx(bytes({ ...valid, hex: 'ab' })).ok).toBe(false);
    expect(parseSignedTx(bytes({ ...valid, keyImages: [] })).ok).toBe(false);
    expect(parseSignedTx(bytes({ ...valid, keyImages: ['nope'] })).ok).toBe(false);
  });
});
