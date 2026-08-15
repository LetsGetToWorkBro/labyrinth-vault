/*
 * The empty field, and the promise that it is only a field.
 *
 * `withEmptyFinalScriptSig` edits serialized PSBT bytes on the path a
 * signature takes out of the vault, which is the most dangerous place in this
 * repository to be editing bytes. src/keys/finalscriptsig.ts argues for why it
 * has to happen there; this file is the part that makes it safe to have done.
 *
 * The load-bearing test is the last one: the transaction id is identical
 * before and after. A PSBT carries a transaction plus metadata about how to
 * sign it, and `PSBT_IN_FINAL_SCRIPTSIG` is metadata. If the id ever moved,
 * this would be rewriting the transaction rather than annotating it, and that
 * is the failure worth a test of its own rather than a comment.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { withEmptyFinalScriptSig } from '../src/keys/finalscriptsig';

const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));

/* The real signed PSBTs from test/fixtures/wallet-wires.json are unsigned, so
 * the subject here is built the way the vault builds one: sign and finalize a
 * native segwit input with @scure, which is what leaves the field out. */
function finalizedPsbt(): Uint8Array {
  const key = new Uint8Array(32).fill(9);
  const p2wpkh = btc.p2wpkh(secp256k1.getPublicKey(key, true));
  const tx = new btc.Transaction();
  tx.addInput({
    txid: new Uint8Array(32).fill(3),
    index: 0,
    witnessUtxo: { script: p2wpkh.script, amount: 100_000n },
  });
  tx.addOutputAddress(
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    90_000n,
  );
  tx.signIdx(key, 0, [btc.SigHash.ALL]);
  tx.finalize();
  return tx.toPSBT();
}

describe('the empty final scriptSig Electrum insists on', () => {
  const before = finalizedPsbt();
  const after = withEmptyFinalScriptSig(before);

  it('is genuinely missing beforehand, or this whole file is theatre', () => {
    /* If @scure ever starts emitting the field, this fails and the module
     * should be deleted rather than kept as a no-op nobody understands. */
    expect(before).not.toEqual(after);
    expect(after.length).toBe(before.length + 3);
  });

  it('adds exactly one three-byte record: key length, key type 7, empty value', () => {
    const added = [...after].filter((_, i) => before[i] !== after[i]);
    expect(added.length).toBeGreaterThan(0);
    /* Located rather than counted: the record is 0x01 0x07 0x00 and it must
     * appear in the output and not in the input. */
    const has = (b: Uint8Array) => {
      for (let i = 0; i + 2 < b.length; i++) {
        if (b[i] === 0x01 && b[i + 1] === 0x07 && b[i + 2] === 0x00) return true;
      }
      return false;
    };
    expect(has(after), 'the record was not written').toBe(true);
  });

  it('leaves the transaction identical, which is the whole safety claim', () => {
    const one = btc.Transaction.fromPSBT(before, { allowUnknown: true });
    const two = btc.Transaction.fromPSBT(after, { allowUnknown: true });
    expect(two.id).toBe(one.id);
    expect(two.hex).toBe(one.hex);
    expect(two.inputsLength).toBe(one.inputsLength);
    expect(two.outputsLength).toBe(one.outputsLength);
  });

  it('is idempotent, so a second pass cannot double the field', () => {
    expect(withEmptyFinalScriptSig(after)).toEqual(after);
  });

  it('does nothing to a PSBT that is not finalized', () => {
    /* An input still waiting on another party has no final witness, so there
     * is nothing to annotate and the bytes go through untouched. */
    const key = new Uint8Array(32).fill(9);
    const tx = new btc.Transaction();
    tx.addInput({
      txid: new Uint8Array(32).fill(3),
      index: 0,
      witnessUtxo: { script: btc.p2wpkh(secp256k1.getPublicKey(key, true)).script, amount: 100_000n },
    });
    tx.addOutputAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 90_000n);
    const unfinalized = tx.toPSBT();
    expect(withEmptyFinalScriptSig(unfinalized)).toEqual(unfinalized);
  });

  it('hands back anything it cannot fully parse, rather than half-editing it', () => {
    /* Refusal is the whole error strategy here: a PSBT that goes out slightly
     * less compatible is a far better outcome than one mangled on the way. */
    expect(withEmptyFinalScriptSig(new Uint8Array(0))).toEqual(new Uint8Array(0));
    expect(withEmptyFinalScriptSig(bytes('00010203'))).toEqual(bytes('00010203'));
    /* Right magic, truncated body. */
    const truncated = before.subarray(0, 12);
    expect(withEmptyFinalScriptSig(truncated)).toEqual(truncated);
    /* Right magic, unterminated global map. */
    expect(withEmptyFinalScriptSig(bytes('70736274ff01'))).toEqual(bytes('70736274ff01'));
  });

  it('is on the signing path, not merely available', () => {
    const psbt = readFileSync('src/keys/psbt.ts', 'utf8');
    expect(psbt).toContain('withEmptyFinalScriptSig(tx.toPSBT())');
  });
});
