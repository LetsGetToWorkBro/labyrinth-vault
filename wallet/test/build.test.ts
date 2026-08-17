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
import {
  CHANGE_VBYTES,
  DUST,
  WIDEST_OUTPUT_VBYTES,
  estimateVsize,
  feeFor,
  maxSendable,
  nextChangeIndex,
  outputVbytesFor,
  prepare,
  selectCoins,
  verifySigned,
} from '../src/core/build';
import { GAP_LIMIT } from '../src/core/discover';
import { readFileSync } from 'node:fs';
import type { Utxo } from '../src/core/chain';
import { DEMO_ZPUB, DemoWatcher } from '../src/core/demo';

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NOW = 1_760_000_000_000;
const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
/* Three more destination shapes, because every test in this file used to pay
 * the same bech32 address and an output's size comes from its script. */
const TAPROOT = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
const LEGACY = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';

const wallet = openFromMnemonic(WORDS);
const watcher = new DemoWatcher();
const utxos = watcher.snapshot(NOW).assets.BTC.utxos;

function prepared(amount: bigint, rate = 11, recipient = RECIPIENT) {
  const result = prepare({
    asset: 'BTC',
    recipient,
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
    expect(estimateVsize(1, [CHANGE_VBYTES, CHANGE_VBYTES])).toBe(141);
    expect(feeFor(1, [CHANGE_VBYTES, CHANGE_VBYTES], 10)).toBe(1410n);
  });

  it('charges more for every coin it has to spend', () => {
    expect(feeFor(3, [CHANGE_VBYTES, CHANGE_VBYTES], 10)).toBeGreaterThan(feeFor(1, [CHANGE_VBYTES, CHANGE_VBYTES], 10));
  });
});

describe('picking coins', () => {
  it('prefers one coin and no change when a single coin nearly fits', () => {
    const single = utxos.find((utxo) => utxo.value === 15_000_000n)!;
    const fee = feeFor(1, [outputVbytesFor(RECIPIENT)], 11);
    const selection = selectCoins(utxos, single.value - fee, 11, RECIPIENT);
    expect(selection.chosen).toHaveLength(1);
    expect(selection.change).toBe(0n);
    expect(selection.chosen[0]!.value).toBe(15_000_000n);
  });

  it('takes more coins as the amount grows, and always covers the fee', () => {
    const selection = selectCoins(utxos, 40_000_000n, 11, RECIPIENT);
    const gathered = selection.chosen.reduce((sum: bigint, utxo: Utxo) => sum + utxo.value, 0n);
    expect(selection.problem).toBeNull();
    expect(selection.chosen.length).toBeGreaterThan(1);
    expect(gathered).toBe(40_000_000n + selection.fee + selection.change);
  });

  it('gives dust to the miner rather than making an output nobody can afford to spend', () => {
    const single = utxos.find((utxo) => utxo.value === 25_000_000n)!;
    const fee = feeFor(1, [outputVbytesFor(RECIPIENT), CHANGE_VBYTES], 11);
    const selection = selectCoins(utxos, single.value - fee - 200n, 11, RECIPIENT);
    expect(selection.change).toBe(0n);
    expect(selection.changeToFee).toBe(true);
    expect(selection.fee).toBeGreaterThan(fee);
    expect(selection.fee).toBeLessThan(fee + DUST);
  });

  it('refuses what the wallet cannot cover, and says by how much', () => {
    const selection = selectCoins(utxos, 90_000_000n, 11, RECIPIENT);
    expect(selection.problem).toMatch(/more than this wallet holds/);
    expect(selection.chosen).toHaveLength(0);
  });

  it('leaves the fee out of the maximum, because the fee has to come from somewhere', () => {
    const total = utxos.reduce((sum: bigint, utxo: Utxo) => sum + utxo.value, 0n);
    expect(maxSendable(utxos, 11, RECIPIENT)).toBeLessThan(total);
    expect(maxSendable(utxos, 11, RECIPIENT)).toBe(total - feeFor(utxos.length, [outputVbytesFor(RECIPIENT)], 11));
  });
});

/**
 * SEND MAX, and the number the wallet must not then refuse.
 *
 * `maxSendable` budgets one output, because a sweep leaves no change.
 * `selectCoins` used to test every multi-coin candidate against a two-output
 * fee, so for any wallet needing more than one coin it refused the answer by
 * exactly the width of a change output. Pressing MAX and then REVIEW produced
 * "That is more than this wallet holds" from the wallet that had just filled
 * the field in, and there was no way out of it: Send has no text field for the
 * recipient, so the number could not be edited down by hand.
 *
 * The old test asserted `maxSendable` against a restatement of its own
 * formula, which is why a suite of this size could not see it. This one feeds
 * the answer back into the function that has to accept it, across a table,
 * because the defect was invisible at one coin and present at every other
 * count.
 */
describe('the largest sendable amount, fed back to the picker', () => {
  it('is accepted at every coin count and every rate', () => {
    /* The fixture has to reach past one coin or it cannot see the defect at
     * all: the single-coin case was the one that always worked. */
    expect(utxos.length, 'a one-coin wallet cannot exercise this').toBeGreaterThan(1);

    for (const rate of [1, 11, 200]) {
      for (let count = 1; count <= utxos.length; count++) {
        const coins = utxos.slice(0, count);
        const held = coins.reduce((sum: bigint, utxo: Utxo) => sum + utxo.value, 0n);
        const most = maxSendable(coins, rate, RECIPIENT);
        const selection = selectCoins(coins, most, rate, RECIPIENT);

        const where = `${count} coin${count === 1 ? '' : 's'} at ${rate} sat/vB`;
        expect(selection.problem, where).toBeNull();
        expect(selection.chosen, where).toHaveLength(count);
        /* A sweep: no change, and every satoshi accounted for as either the
         * payment or the fee. */
        expect(selection.change, where).toBe(0n);
        expect(most + selection.fee, where).toBe(held);
      }
    }
  });

  it('sweeps to a taproot destination too, where the output is wider', () => {
    /* The same round trip with an output the old sizing was wrong about, so
     * the two fixes are exercised together rather than one hiding the other. */
    const most = maxSendable(utxos, 7, TAPROOT);
    const selection = selectCoins(utxos, most, 7, TAPROOT);
    expect(selection.problem).toBeNull();
    expect(selection.change).toBe(0n);
  });

  it('says how far short a genuinely unaffordable amount is', () => {
    /* The refusal still has to exist, or the fix above is "accept everything".
     * One satoshi over the maximum is the tightest case there is. */
    const most = maxSendable(utxos, 11, RECIPIENT);
    const selection = selectCoins(utxos, most + 1n, 11, RECIPIENT);
    expect(selection.problem).toMatch(/more than this wallet holds, by 1 sat/);
  });
});

/**
 * What an output costs, which is not the same for every kind of address.
 *
 * 31 vbytes is right for P2WPKH and wrong for everything else `checkAddress`
 * accepts and `addOutputAddress` builds: taproot is 43, legacy 34, P2SH 32.
 * The vault's `psbt.ts` has always summed `9 + script.length`, so the two
 * halves of one product disagreed about the size of the same transaction, and
 * the wallet was the wrong one.
 *
 * The consequence is not cosmetic. `feeOptionsFrom` floors the economy rate at
 * 1 sat/vB because that is Core's default `minrelaytxfee`, so a fee quoted for
 * 141 vbytes against a transaction that is really 153 is 0.92 sat/vB, under
 * the relay minimum, and no node will forward it.
 *
 * Every test in this file used the same bech32 recipient, which is the
 * degenerate fixture that let it through.
 */
describe('sizing an output from its script rather than assuming', () => {
  it('prices each address kind at what the chain charges for it', () => {
    expect(outputVbytesFor(RECIPIENT)).toBe(31);
    expect(outputVbytesFor(TAPROOT)).toBe(43);
    expect(outputVbytesFor(LEGACY)).toBe(34);
    expect(outputVbytesFor(P2SH)).toBe(32);
  });

  it('quotes a fee that really covers a taproot payment at the relay floor', () => {
    /* Measured against the signed bytes rather than against another formula,
     * which is the whole point: the transaction is really built, really
     * signed, and its own vsize is what the quoted fee is divided by. */
    const rate = 1;
    const { draft } = prepared(5_000_000n, rate, TAPROOT);
    const signed = signLikeTheVault(draft.unsigned);
    const tx = btc.Transaction.fromRaw(signed);

    expect(tx.vsize).toBeGreaterThan(estimateVsize(draft.inputs.length, [CHANGE_VBYTES, CHANGE_VBYTES]));
    expect(
      Number(draft.fee) / tx.vsize,
      `quoted ${draft.fee} sat for ${tx.vsize} vbytes`,
    ).toBeGreaterThanOrEqual(rate);
  });

  it('budgets the widest standard output when MAX has no destination yet', () => {
    /* MAX is reachable before a destination is entered. Guessing low there
     * would reintroduce the refusal above for any address wider than P2WPKH,
     * so the guess is high, and the amount it produces stays payable to the
     * widest destination there is. */
    expect(WIDEST_OUTPUT_VBYTES).toBe(outputVbytesFor(TAPROOT));
    const blind = maxSendable(utxos, 11);
    expect(blind).toBeLessThan(maxSendable(utxos, 11, RECIPIENT));
    expect(selectCoins(utxos, blind, 11, TAPROOT).problem).toBeNull();
    expect(selectCoins(utxos, blind, 11, RECIPIENT).problem).toBeNull();
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

  /**
   * The same, with the recipient pasted in upper case.
   *
   * BIP173 declares an uppercase bech32 address valid and recommends it inside
   * QR codes, so senders really do hand one over. `getOutputAddress` always
   * re-encodes lowercase, so raw string equality on `draft.recipient` refused
   * a byte-correct signature with two sentences that are both false: "Nothing
   * in this transaction pays BC1Q..." and "There is an output here that was
   * not in the transaction you approved."
   *
   * It failed closed, so nothing could be misspent. What it cost was a person
   * completing the whole airgap ceremony and landing on a screen accusing
   * their own vault of redirecting the payment, with broadcast blocked and no
   * way back: Send has no text field for the recipient, only PASTE, SCAN and
   * CLEAR. The swap flow reached it with no user involvement at all.
   *
   * Driven end to end rather than asserted on the string, because the property
   * is that a correct signature is accepted, not that two strings match.
   */
  it('accepts a signature for a recipient that arrived in upper case', () => {
    const upper = RECIPIENT.toUpperCase();
    /* Not a degenerate fixture: this address has letters, so the two spellings
     * really are different strings. */
    expect(upper).not.toBe(RECIPIENT);

    const { draft } = prepared(5_000_000n, 11, upper);
    /* One spelling on the draft, which is the one the vault renders and the
     * one the person reads across from the other screen. */
    expect(draft.recipient).toBe(RECIPIENT);

    const verdict = verifySigned(draft, signLikeTheVault(draft.unsigned));
    expect(verdict.ok, verdict.ok ? '' : verdict.reasons.join(' / ')).toBe(true);
    expect(verdict.outputs.some((output) => output.address === RECIPIENT)).toBe(true);
  });

  it('still refuses a payment to somebody else when the draft was upper case', () => {
    /* The other half: canonicalizing must not turn the check into "any
     * address will do". Same uppercase draft, a different destination in the
     * signed bytes, still refused. */
    const { draft } = prepared(5_000_000n, 11, RECIPIENT.toUpperCase());
    const original = btc.Transaction.fromPSBT(draft.unsigned);
    const hostile = new btc.Transaction();
    for (let i = 0; i < original.inputsLength; i++) hostile.addInput(original.getInput(i));
    hostile.addOutputAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', draft.amount);
    for (let i = 1; i < original.outputsLength; i++) hostile.addOutput(original.getOutput(i));

    const verdict = verifySigned(draft, signLikeTheVault(hostile.toPSBT(0)));
    expect(verdict.ok).toBe(false);
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
   * Monero, which is no longer prepared here at all.
   *
   * An earlier version built a provisional stand-in payload in this file, and
   * before that, a balance-reading bug made every Monero payment impossible.
   * Both are gone for the same reason: a real Monero draft is planned against
   * the node - decoys from the distribution, ring members fetched and
   * checked, the node's own fee estimate - which is asynchronous and lives
   * in monerodraft.ts, tested there with a fake node. What this file owes
   * Monero is exactly two refusals with directions on them, so a caller that
   * reaches the wrong function gets a sentence instead of a stack trace or,
   * worse, a quiet pass.
   */
  describe('Monero, which is planned elsewhere', () => {
    const MONERO = '4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2684Rge';

    it('points a prepare() caller at the planner', () => {
      const result = prepare({
        asset: 'XMR',
        recipient: MONERO,
        amount: 1_000_000_000_000n,
        rate: 2.4,
        utxos: [],
        balance: 14_381_000_000_000n,
        zpub: DEMO_ZPUB,
        change: { index: 0 },
        now: NOW,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem).toMatch(/prepareMoneroDraft/);
    });

    it('points a verifySigned() caller at the Monero verifier, and passes nothing', () => {
      const draft = {
        asset: 'XMR' as const,
        recipient: MONERO,
        amount: 1_000_000_000_000n,
        fee: 720_000_000n,
        feeRate: 1,
        unsigned: new Uint8Array([1]),
        digest: 'ab'.repeat(32),
        createdAt: NOW,
        inputs: [],
        inputTotal: 1_000_720_000_000n,
        changeAddresses: [],
        spentKeys: ['a'.repeat(64)],
      };
      const verdict = verifySigned(draft, new Uint8Array([1, 2, 3]));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reasons[0]).toMatch(/verifySignedMonero/);
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
    const { draft, selection } = prepared(single.value - feeFor(1, [outputVbytesFor(RECIPIENT)], 11));
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

describe('where change goes, and the gap limit it has to stay inside', () => {
  /* The defect this covers lost money in the only way this app can lose it:
   * silently. The store chose an absolute change index of 24, `discover.ts`
   * walks the change branch from zero and stops after `GAP_LIMIT` consecutive
   * unused addresses, and nothing at 0..23 was ever used, so the gap never
   * reset and 1/24 was never queried. Every change output the app made was
   * outside the scan window forever, on every rescan. The coins were real and
   * the vault signed them: only this half could not see them. */

  it('starts at zero when the scan knows nothing', () => {
    /* An unscanned wallet has used no change addresses. Zero is the answer
     * rather than a fallback, and it is what keeps the first one inside the
     * window. */
    expect(nextChangeIndex([])).toBe(0);
  });

  it('stays inside the gap limit for a fresh wallet, which is the whole defect', () => {
    /* The direct regression. Any index at or past `GAP_LIMIT` on a branch with
     * nothing used is an address the scanner will never ask about. */
    expect(nextChangeIndex([])).toBeLessThan(GAP_LIMIT);
    const receiveOnly = [
      { path: '0/0', used: true },
      { path: '0/1', used: false },
    ];
    expect(nextChangeIndex(receiveOnly)).toBeLessThan(GAP_LIMIT);
  });

  it('goes past every used change address rather than into the first hole', () => {
    /* Reusing a free lower index would publish the link between two payments,
     * which is the thing this function exists to avoid. */
    const addresses = [
      { path: '1/0', used: true },
      { path: '1/1', used: false },
      { path: '1/2', used: true },
      { path: '1/3', used: false },
    ];
    expect(nextChangeIndex(addresses)).toBe(3);
  });

  it('ignores the receive branch entirely', () => {
    /* `0/9` used says nothing about where change should go, and counting it
     * would push change past the gap on a wallet that has merely been paid a
     * few times. */
    const addresses = [
      { path: '0/9', used: true },
      { path: '1/0', used: false },
    ];
    expect(nextChangeIndex(addresses)).toBe(0);
  });

  it('moves on for a second draft prepared before the next refresh', () => {
    /* Two payments composed back to back must not land change on one address.
     * The offset covers exactly the window between a draft and the refresh
     * that would notice it. */
    const addresses = [{ path: '1/0', used: true }];
    expect(nextChangeIndex(addresses, 0)).toBe(1);
    expect(nextChangeIndex(addresses, 1)).toBe(2);
  });

  it('survives paths that are missing or malformed', () => {
    /* `path` is null for Monero and the snapshot is shared. A parse that threw
     * or counted junk would put change somewhere arbitrary. */
    const addresses = [
      { path: null, used: true },
      { path: 'nonsense', used: true },
      { path: '1/x', used: true },
      { path: '1/0', used: true },
    ];
    expect(nextChangeIndex(addresses)).toBe(1);
  });

  it('is what the store actually asks for', () => {
    /* The guard against the absolute index coming back. The store must derive
     * from the snapshot rather than carry a number of its own. */
    const store = readFileSync('src/state/store.tsx', 'utf8');
    expect(store).toMatch(/nextChangeIndex\(\s*\n?\s*snapshot\.assets\.BTC\.addresses/);
    expect(store, 'an absolute change index is back and change will vanish').not.toMatch(
      /changeIndex = useRef\(\d+\)/,
    );
  });
});
