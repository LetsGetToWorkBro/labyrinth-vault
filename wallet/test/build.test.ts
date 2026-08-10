/**
 * The two things that must never be wrong: what gets built, and what gets
 * broadcast.
 *
 * The interesting half of this file is the second one. Building a transaction
 * is ordinary software and it is tested here as such — the coins add up, the
 * fee matches the size, the change goes back to us. Checking the one that
 * comes back is the part the architecture rests on, so those tests do not
 * describe a hostile transaction, they build one: a real PSBT, really signed
 * by a real key, with an output really changed, and then assert that
 * `verifySigned` refuses it.
 *
 * That distinction matters. A test that asserts `verifySigned` returns false
 * for `{}` proves nothing about a transaction that is valid in every way
 * except where the money goes, which is the only kind that will ever actually
 * be shown to somebody.
 */

import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { addressAt, openFromMnemonic } from '@vault/keys/bitcoin';
import { describePsbt } from '@vault/keys/psbt';
import { DUST, estimateVsize, feeFor, maxSendable, prepare, selectCoins, verifySigned } from '../src/core/build';
import type { Utxo } from '../src/core/chain';
import { DEMO_ZPUB, DemoWatcher } from '../src/core/demo';

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NOW = 1_760_000_000_000;
const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

const wallet = openFromMnemonic(WORDS);
const watcher = new DemoWatcher();
const utxos = watcher.snapshot(NOW).assets.BTC.utxos;

function prepared(amount: bigint, rate = 11) {
  const result = prepare({
    asset: 'BTC',
    recipient: RECIPIENT,
    amount,
    rate,
    utxos,
    balance: utxos.reduce((sum, utxo) => sum + utxo.value, 0n),
    zpub: DEMO_ZPUB,
    change: { index: 12 },
    now: NOW,
  });
  if (!result.ok) throw new Error(result.problem);
  return result;
}

/**
 * Sign a PSBT the way the vault would, with the key behind the same account.
 *
 * This is not a re-implementation of the vault's signer — the vault's own
 * `signPsbt` requires an approval digest, deliberately, and threading one
 * through here would be testing that instead of this. What is needed here is
 * simply *a* correctly signed transaction to hand back, so `@scure/btc-signer`
 * signs it with the same private keys, under SIGHASH_ALL, and the result is
 * exactly what would come off a vault's screen.
 */
function signLikeTheVault(psbt: Uint8Array, mutate?: (tx: btc.Transaction) => void): Uint8Array {
  const tx = btc.Transaction.fromPSBT(psbt, { allowUnknown: true, allowUnknownInputs: true, allowUnknownOutputs: true });
  mutate?.(tx);
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(WORDS));
  for (let i = 0; i < tx.inputsLength; i++) {
    let signed = false;
    for (let index = 0; index < 8 && !signed; index++) {
      const key = root.derive(`m/84'/0'/0'/0/${index}`).privateKey;
      if (!key) continue;
      /* `signIdx` throws rather than returning false when the key does not
       * match the input's script, so trying keys in turn means catching. This
       * helper looked correct for as long as every test happened to spend the
       * coin at index 0, which is a good argument for tests that spend a
       * different one. */
      try {
        signed = tx.signIdx(key, i, [btc.SigHash.ALL]);
      } catch {
        signed = false;
      }
    }
    if (!signed) throw new Error(`no key in the first eight signs input ${i}`);
  }
  tx.finalize();
  return tx.extract();
}

describe('what a transaction costs', () => {
  it('sizes a one-in two-out spend the way the network does', () => {
    // 10.5 + 68 + 62 = 140.5, and a fee estimate never rounds down.
    expect(estimateVsize(1, 2)).toBe(141);
    expect(feeFor(1, 2, 10)).toBe(1410n);
  });

  it('charges more for every coin it has to spend', () => {
    expect(feeFor(3, 2, 10)).toBeGreaterThan(feeFor(1, 2, 10));
  });
});

describe('picking coins', () => {
  it('prefers one coin and no change when a single coin nearly fits', () => {
    const single = utxos.find((utxo) => utxo.value === 15_000_000n)!;
    const fee = feeFor(1, 1, 11);
    const selection = selectCoins(utxos, single.value - fee, 11);
    expect(selection.chosen).toHaveLength(1);
    expect(selection.change).toBe(0n);
    expect(selection.chosen[0]!.value).toBe(15_000_000n);
  });

  it('takes more coins as the amount grows, and always covers the fee', () => {
    const selection = selectCoins(utxos, 40_000_000n, 11);
    const gathered = selection.chosen.reduce((sum: bigint, utxo: Utxo) => sum + utxo.value, 0n);
    expect(selection.problem).toBeNull();
    expect(selection.chosen.length).toBeGreaterThan(1);
    expect(gathered).toBe(40_000_000n + selection.fee + selection.change);
  });

  it('gives dust to the miner rather than making an output nobody can afford to spend', () => {
    const single = utxos.find((utxo) => utxo.value === 25_000_000n)!;
    const fee = feeFor(1, 2, 11);
    const selection = selectCoins(utxos, single.value - fee - 200n, 11);
    expect(selection.change).toBe(0n);
    expect(selection.changeToFee).toBe(true);
    expect(selection.fee).toBeGreaterThan(fee);
    expect(selection.fee).toBeLessThan(fee + DUST);
  });

  it('refuses what the wallet cannot cover, and says by how much', () => {
    const selection = selectCoins(utxos, 90_000_000n, 11);
    expect(selection.problem).toMatch(/more than this wallet holds/);
    expect(selection.chosen).toHaveLength(0);
  });

  it('leaves the fee out of the maximum, because the fee has to come from somewhere', () => {
    const total = utxos.reduce((sum: bigint, utxo: Utxo) => sum + utxo.value, 0n);
    expect(maxSendable(utxos, 11)).toBeLessThan(total);
    expect(maxSendable(utxos, 11)).toBe(total - feeFor(utxos.length, 1, 11));
  });
});

describe('the unsigned transaction the vault will be shown', () => {
  it('is a PSBT the vault can read, sign, and state a fee for', () => {
    const { draft } = prepared(5_000_000n);
    const summary = describePsbt(draft.unsigned, wallet);
    expect(summary.ok, summary.problem ?? '').toBe(true);
    /* `signable` is the vault's own verdict: every input ours, every value
     * known, nothing fatal. A wallet that builds transactions its own signer
     * would refuse has a bug on this side, and this is where it shows up. */
    expect(summary.signable, summary.warnings.map((warning) => warning.message).join(' / ')).toBe(true);
    expect(summary.fee).toBe(draft.fee);
  });

  it('pays the recipient exactly the amount, with the rest coming back as change', () => {
    const { draft } = prepared(5_000_000n);
    const summary = describePsbt(draft.unsigned, wallet);
    const leaving = summary.outputs.filter((output) => !output.mine);
    expect(leaving).toHaveLength(1);
    expect(leaving[0]!.address).toBe(RECIPIENT);
    expect(leaving[0]!.value).toBe(5_000_000n);
    expect(summary.outputs.some((output) => output.mine)).toBe(true);
  });

  it('records the intent it will later be checked against', () => {
    const { draft, selection } = prepared(5_000_000n);
    expect(draft.inputs).toHaveLength(selection.chosen.length);
    expect(draft.inputTotal).toBe(selection.chosen.reduce((sum: bigint, utxo: Utxo) => sum + utxo.value, 0n));
    expect(draft.changeAddresses).toHaveLength(1);
    expect(draft.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a destination that is not an address', () => {
    const result = prepare({
      asset: 'BTC',
      recipient: 'bc1qnotanaddressatall',
      amount: 1_000_000n,
      rate: 11,
      utxos,
      balance: utxos.reduce((sum: bigint, utxo: Utxo) => sum + utxo.value, 0n),
      zpub: DEMO_ZPUB,
      change: { index: 12 },
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });
});

describe('checking what the vault hands back', () => {
  it('accepts the transaction it asked for', () => {
    const { draft } = prepared(5_000_000n);
    const signed = signLikeTheVault(draft.unsigned);
    const verdict = verifySigned(draft, signed);
    expect(verdict.ok, verdict.ok ? '' : verdict.reasons.join(' / ')).toBe(true);
    if (verdict.ok) {
      expect(verdict.txid).toMatch(/^[0-9a-f]{64}$/);
      expect(verdict.fee).toBe(draft.fee);
    }
  });

  it('refuses a different transaction that pays somebody else', () => {
    /* The attack, built rather than described: the same coins, the same
     * amount, the same fee, genuinely signed by the real key — and one
     * character different in the destination. Everything about these bytes is
     * valid. A node will accept them. The signature verifies. The only thing
     * wrong with them is that they are not what anybody approved, and that has
     * to be enough. */
    const { draft } = prepared(5_000_000n);
    const attacker = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
    const hostile = new btc.Transaction();
    const original = btc.Transaction.fromPSBT(draft.unsigned);
    for (let i = 0; i < original.inputsLength; i++) hostile.addInput(original.getInput(i));
    hostile.addOutputAddress(attacker, draft.amount);
    for (let i = 1; i < original.outputsLength; i++) hostile.addOutput(original.getOutput(i));

    const signed = signLikeTheVault(hostile.toPSBT(0));
    const verdict = verifySigned(draft, signed);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reasons.join(' ')).toMatch(/Nothing in this transaction pays/);
      expect(verdict.outputs.some((output) => output.address === attacker)).toBe(true);
    }
  });

  it('refuses a transaction whose amount changed', () => {
    const { draft } = prepared(5_000_000n);
    const tampered = { ...draft, amount: 6_000_000n };
    const signed = signLikeTheVault(draft.unsigned);
    const verdict = verifySigned(tampered, signed);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons.join(' ')).toMatch(/6000000 was approved/);
  });

  it('refuses a transaction that spends a coin nobody approved', () => {
    const { draft } = prepared(5_000_000n);
    const signed = signLikeTheVault(draft.unsigned);
    const swapped = { ...draft, inputs: [{ txid: 'a'.repeat(64), vout: 0 }] };
    const verdict = verifySigned(swapped, signed);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons.join(' ')).toMatch(/not in the transaction you approved|leaves out/);
  });

  it('refuses bytes that are not a transaction at all', () => {
    const { draft } = prepared(5_000_000n);
    const verdict = verifySigned(draft, new Uint8Array([1, 2, 3, 4]));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reasons[0]).toMatch(/not a finished transaction/);
  });

  /**
   * Monero, and a test that used to assert a bug.
   *
   * The old version of this test said a Monero payment could not be prepared,
   * and it passed. It passed because `prepareMonero` was reading the balance
   * off the unspent-output list, which is empty for Monero: a view key does
   * not enumerate outputs the way an extended public key enumerates addresses.
   * So every Monero payment, of any size, was "more than this wallet holds",
   * and a test written from the observed behavior locked that in.
   *
   * What should be true is below. A Monero draft builds, because composing a
   * payment is this device's job and it can do it. It is tagged `provisional`,
   * because the payload it produces is not `wallet2`'s format yet. And the
   * refusal happens at `verifySigned`, which is where an unfinished format
   * should stop being waved through, rather than at a balance check that was
   * wrong for an unrelated reason.
   */
  describe('Monero, which is composable and not yet signable', () => {
    const MONERO = '4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2684Rge';
    const monero = (amount: bigint) =>
      prepare({
        asset: 'XMR',
        recipient: MONERO,
        amount,
        rate: 2.4,
        utxos: [],
        balance: 14_381_000_000_000n,
        zpub: DEMO_ZPUB,
        change: { index: 0 },
        now: NOW,
      });

    it('prepares a payment the wallet can afford', () => {
      const result = monero(1_000_000_000_000n);
      expect(result.ok, result.ok ? '' : result.problem).toBe(true);
      if (result.ok) {
        expect(result.draft.provisional).toBe(true);
        expect(result.draft.amount).toBe(1_000_000_000_000n);
        expect(result.draft.fee).toBeGreaterThan(0n);
      }
    });

    it('refuses one it cannot', () => {
      expect(monero(20_000_000_000_000n).ok).toBe(false);
    });

    it('will not verify a signature for it, because there is nothing to verify yet', () => {
      const result = monero(1_000_000_000_000n);
      if (!result.ok) throw new Error(result.problem);
      const verdict = verifySigned(result.draft, new Uint8Array([1, 2, 3]));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reasons[0]).toMatch(/not finished/);
    });
  });
});

/**
 * The fee, which for one commit was not checked at all.
 *
 * A finished transaction does not carry what its inputs were worth, so it
 * cannot state its own fee. The check was reading the fee out of the returned
 * transaction, getting null every time, and skipping the comparison. The test
 * that was meant to cover it asserted `verdict.fee === draft.fee` against a
 * value that fell back to `draft.fee` when it was null, so it passed without
 * ever exercising anything.
 *
 * These tests are written so that cannot happen again: they assert on a
 * transaction that was really signed with a really different fee, and on the
 * arithmetic being done from the draft.
 */
describe('the fee, checked against what was approved', () => {
  it('states the true fee on a transaction that matches', () => {
    const { draft, selection } = prepared(5_000_000n);
    const verdict = verifySigned(draft, signLikeTheVault(draft.unsigned));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.fee).toBe(selection.fee);
      /* Not merely equal to the draft's copy of it: recomputed from the coins
       * and the outputs, and equal to what coin selection charged. */
      expect(verdict.fee).toBe(draft.inputTotal - 5_000_000n - selection.change);
    }
  });

  it('refuses a transaction that shaves the change and gives it to a miner', () => {
    /* The attack this hole allowed: same recipient, same amount, same coins,
     * no stranger anywhere in the outputs. Only the change comes back smaller,
     * and the difference is the fee, which nobody approved. */
    const { draft } = prepared(5_000_000n);
    const original = btc.Transaction.fromPSBT(draft.unsigned);
    const greedy = new btc.Transaction();
    for (let i = 0; i < original.inputsLength; i++) greedy.addInput(original.getInput(i));
    greedy.addOutputAddress(RECIPIENT, draft.amount);
    const change = original.getOutput(1) as { script: Uint8Array; amount: bigint };
    greedy.addOutput({ script: change.script, amount: change.amount - 100_000n });

    const verdict = verifySigned(draft, signLikeTheVault(greedy.toPSBT(0)));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reasons.join(' ')).toMatch(/in fees where/);
      expect(verdict.reasons.join(' ')).toMatch(/goes to a miner/);
    }
  });

  /**
   * The check has to be silent when nothing is wrong.
   *
   * A false refusal is not a safe failure here: it sends somebody back to a
   * vault to re-approve a payment that was already correct, and it teaches
   * them that the warning screen means nothing. The awkward case is the
   * transaction with no change output at all, where the fee is whatever was
   * left over, so it is exercised end to end rather than assumed.
   */
  it('accepts a payment with no change, where the fee is the remainder', () => {
    const single = utxos.find((utxo) => utxo.value === 15_000_000n)!;
    const { draft, selection } = prepared(single.value - feeFor(1, 1, 11));
    expect(selection.change).toBe(0n);
    expect(draft.changeAddresses).toHaveLength(0);

    const verdict = verifySigned(draft, signLikeTheVault(draft.unsigned));
    expect(verdict.ok, verdict.ok ? '' : verdict.reasons.join(' / ')).toBe(true);
    if (verdict.ok) expect(verdict.fee).toBe(draft.fee);
  });

  it('refuses a transaction that quietly pays a smaller fee than approved', () => {
    const { draft } = prepared(5_000_000n);
    const original = btc.Transaction.fromPSBT(draft.unsigned);
    const generous = new btc.Transaction();
    for (let i = 0; i < original.inputsLength; i++) generous.addInput(original.getInput(i));
    generous.addOutputAddress(RECIPIENT, draft.amount);
    const change = original.getOutput(1) as { script: Uint8Array; amount: bigint };
    generous.addOutput({ script: change.script, amount: change.amount + 500n });

    const verdict = verifySigned(draft, signLikeTheVault(generous.toPSBT(0)));
    expect(verdict.ok).toBe(false);
  });
});

describe('the demo wallet is really derived, not typed in', () => {
  it('derives its addresses from the published BIP84 vector', () => {
    expect(utxos[0]!.address).toBe(addressAt(wallet, 0, 0).address);
    expect(utxos[0]!.address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  });

  it('holds exactly the balance the home screen claims', () => {
    const balance = utxos.reduce((sum: bigint, utxo: Utxo) => sum + utxo.value, 0n);
    expect(balance).toBe(48_273_100n);
  });
});
