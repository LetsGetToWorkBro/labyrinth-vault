/**
 * The seam between the reader and the screen.
 *
 * Two properties matter here and they are different in kind. One is that the
 * conversion is faithful — every output present, every number formatted by the
 * one implementation that has tests. The other is that the shape survives
 * JSON, because a bridge is a serialisation and a field that quietly becomes
 * `undefined` on the way across is a field the screen will render as blank.
 *
 * The multi-payee tests are the reason this file exists. The Swift model this
 * replaced had a single `destination`, so a transaction paying two people
 * would have shown one of them, and money would have left to an address the
 * person approving it never saw.
 */

import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { addressAt, openFromMnemonic } from '../src/keys/bitcoin';
import { describePsbt } from '../src/keys/psbt';
import { describeForScreen, encodeForScreen, toWire } from '../src/bridge/summary';

const WORDS =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const STRANGER =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const wallet = openFromMnemonic(WORDS);
const stranger = openFromMnemonic(STRANGER);

interface Out {
  script?: Uint8Array;
  ours?: { change: 0 | 1; index: number };
  strangerIndex?: number;
  value: bigint;
}

function build(inputValues: bigint[], outputs: Out[]): Uint8Array {
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  inputValues.forEach((value, i) => {
    tx.addInput({
      txid: new Uint8Array(32).fill(i + 1),
      index: 0,
      witnessUtxo: { script: addressAt(wallet, 0, i).script, amount: value },
    });
  });
  for (const out of outputs) {
    const script =
      out.script ??
      (out.ours
        ? addressAt(wallet, out.ours.change, out.ours.index).script
        : addressAt(stranger, 0, out.strangerIndex ?? 0).script);
    tx.addOutput({ script, amount: out.value });
  }
  return tx.toPSBT();
}

describe('every output crosses, always', () => {
  it('carries three outputs as three outputs', () => {
    const psbt = build(
      [1_000_000n],
      [
        { strangerIndex: 0, value: 300_000n },
        { strangerIndex: 1, value: 450_000n },
        { ours: { change: 1, index: 0 }, value: 249_800n },
      ],
    );
    const wire = describeForScreen(psbt, wallet);
    expect(wire.outputs).toHaveLength(3);
    expect(wire.outputs.filter((o) => !o.mine)).toHaveLength(2);
    // Both payees are named, and they are different people.
    const payees = wire.outputs.filter((o) => !o.mine).map((o) => o.address);
    expect(new Set(payees).size).toBe(2);
    expect(payees.every((address) => typeof address === 'string')).toBe(true);
  });

  it('numbers them the way the screen says them', () => {
    const wire = describeForScreen(build([500_000n], [{ value: 100_000n }, { value: 100_000n }]), wallet);
    expect(wire.outputs.map((o) => o.position)).toEqual([1, 2]);
    expect(wire.inputs.map((i) => i.position)).toEqual([1]);
  });

  it('keeps the script for an output with no readable address', () => {
    // The screen has to show something, and a blank is the one thing it must
    // not show.
    const psbt = build([200_000n], [{ script: new Uint8Array([0x6a, 0x04, 1, 2, 3, 4]), value: 90_000n }]);
    const wire = describeForScreen(psbt, wallet);
    expect(wire.outputs[0]!.address).toBeNull();
    expect(wire.outputs[0]!.scriptHex).toBe('6a0401020304');
    expect(wire.refusal).toBe('opaque-output');
    expect(wire.signable).toBe(false);
  });
});

describe('numbers are formatted once, here', () => {
  const psbt = build(
    [200_000n],
    [{ value: 150_000n }, { ours: { change: 1, index: 0 }, value: 45_000n }],
  );
  const wire = describeForScreen(psbt, wallet);

  it('renders amounts as BTC strings, not satoshi and not floats', () => {
    expect(wire.outputs[0]!.amount).toBe('0.0015');
    expect(wire.leaving).toBe('0.0015');
    expect(wire.fee).toBe('0.00005');
    expect(wire.spending).toBe('0.002');
  });

  it('sends yourNet across, which is the number beside the word paying', () => {
    expect(wire.yourNet).toBe('0.00155');
  });

  it('labels the estimates as estimates', () => {
    expect(wire.feeRate).toMatch(/sat\/vB$/);
    expect(wire.vsize).toMatch(/^~\d+ vB$/);
  });

  it('gives a fee share, and null rather than a fiction when there is none', () => {
    expect(wire.feeShare).toMatch(/%$/);
    // A consolidation pays nobody, so a percentage of the payment is undefined.
    const consolidation = describeForScreen(
      build([200_000n], [{ ours: { change: 0, index: 3 }, value: 195_000n }]),
      wallet,
    );
    expect(consolidation.leaving).toBe('0');
    expect(consolidation.feeShare).toBeNull();
  });

  it('says null for a fee it cannot know, never zero', () => {
    const tx = new btc.Transaction({ allowUnknownOutputs: true });
    tx.addInput({ txid: new Uint8Array(32).fill(1), index: 0 });
    tx.addOutput({ script: addressAt(stranger, 0, 0).script, amount: 50_000n });
    const unknown = describeForScreen(tx.toPSBT(), wallet);
    expect(unknown.fee).toBeNull();
    expect(unknown.feeRate).toBeNull();
    expect(unknown.refusal).toBe('unknown-input-value');
  });
});

describe('the shape survives the crossing', () => {
  const psbt = build([200_000n], [{ value: 150_000n }, { ours: { change: 1, index: 0 }, value: 45_000n }]);

  it('round-trips through JSON with nothing lost', () => {
    const wire = describeForScreen(psbt, wallet);
    const back = JSON.parse(encodeForScreen(wire));
    expect(back).toEqual(wire);
  });

  it('holds no bigint and no typed array, because neither is JSON', () => {
    const wire = describeForScreen(psbt, wallet) as unknown as Record<string, unknown>;
    const walk = (value: unknown, path: string): void => {
      expect(typeof value, `${path} is a bigint`).not.toBe('bigint');
      expect(value, `${path} is a typed array`).not.toBeInstanceOf(Uint8Array);
      if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}[${i}]`));
      else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
      }
    };
    walk(wire, 'wire');
  });

  it('carries the digest and the wallet id the signing contract needs', () => {
    const summary = describePsbt(psbt, wallet);
    const wire = toWire(summary);
    expect(wire.digest).toBe(summary.digest);
    expect(wire.walletId).toBe(summary.walletId);
  });

  it('passes every warning through, fatal flag and all', () => {
    const consolidation = describeForScreen(
      build([200_000n], [{ ours: { change: 0, index: 3 }, value: 195_000n }]),
      wallet,
    );
    const codes = consolidation.warnings.map((w) => w.code);
    expect(codes).toContain('nothing-leaves');
    for (const warning of consolidation.warnings) {
      expect(typeof warning.fatal).toBe('boolean');
      expect(warning.message.length).toBeGreaterThan(10);
    }
  });

  it('reports an unreadable transaction without throwing', () => {
    const wire = describeForScreen(new Uint8Array([1, 2, 3]), wallet);
    expect(wire.ok).toBe(false);
    expect(wire.signable).toBe(false);
    expect(wire.refusal).toBe('unreadable');
    expect(wire.problem).toBeTruthy();
  });
});
