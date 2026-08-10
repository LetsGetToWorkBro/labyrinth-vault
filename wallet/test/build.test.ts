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
    zpub: DEMO_ZPUB,
    change: { address: '', index: 12 },
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
    for (let index = 0; index < 8; index++) {
      const key = root.derive(`m/84'/0'/0'/0/${index}`).privateKey;
      if (key && tx.signIdx(key, i, [btc.SigHash.ALL])) break;
    }
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
      zpub: DEMO_ZPUB,
      change: { address: '', index: 12 },
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

  it('will not pass a Monero payment, because Monero signing is not finished', () => {
    const result = prepare({
      asset: 'XMR',
      recipient: '4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2684Rge',
      amount: 1_000_000_000_000n,
      rate: 2.4,
      utxos: [],
      zpub: DEMO_ZPUB,
      change: { address: '', index: 0 },
      now: NOW,
    });
    expect(result.ok).toBe(false);
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
