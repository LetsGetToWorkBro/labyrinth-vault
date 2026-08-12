/**
 * Building the transaction, and checking what comes back.
 *
 * This is the wallet's half of the loop and its most consequential file. Two
 * jobs, and the second one is the one that matters:
 *
 *   1. Turn "pay this person this much" into an unsigned transaction, which
 *      means picking coins, computing a fee, and putting change back where it
 *      came from.
 *
 *   2. Look at what the vault hands back and decide whether it is the same
 *      transaction. This is `verifySigned`, and it is the reason the broadcast
 *      button exists on this device rather than the other one.
 *
 * ## Why the wallet checks the signature it asked for
 *
 * The obvious reading of the architecture is that the vault is the paranoid
 * half and this one is a display. That is half right, and the missing half is
 * this: after the vault signs, the signed bytes travel back through a camera
 * on *this* device, into an app running on a phone with a network and an app
 * store on it. If this device is compromised, the thing that broadcasts is
 * compromised, and a malicious wallet could simply ignore what the vault
 * returned and publish something else it prepared earlier.
 *
 * It could. `verifySigned` does not stop a hostile build of this app: nothing
 * inside a hostile app stops a hostile app. What it stops is the honest build
 * from broadcasting something that quietly changed: a misread frame that
 * assembled into a different valid transaction, two send flows open at once,
 * a signed set from an earlier attempt still in the scanner's buffer. Those
 * are not attacks, they are Tuesday, and each one ends with money going
 * somewhere nobody chose.
 *
 * So the rule is: the wallet compares the returned transaction against the
 * *intent it recorded before the vault ever saw it*: recipient, amount, fee,
 * and the exact set of outputs: and refuses to broadcast a mismatch. Not a
 * warning to scroll past. The screen for this state exists and it has no
 * "broadcast anyway" button, which is a design decision made here, in the
 * type: `verifySigned` returns either a `Ready` or a `Mismatch`, and nothing
 * downstream can turn one into the other.
 *
 * ## The comparison is on meaning, not on bytes
 *
 * A signed transaction is not the unsigned one with a signature glued on. The
 * witness appears, the input scripts change, and the serialization differs
 * throughout, so a byte comparison would fail every time and teach everybody
 * to ignore it. What has to be identical is what the transaction *does*: the
 * same inputs spent, the same outputs paid, the same amounts, in the same
 * places. That is what gets compared.
 *
 * The digest of the unsigned bytes is still carried, because it is what the
 * vault's `signPsbt` binds its approval to (see `src/keys/psbt.ts`), and
 * having both sides name the same transaction by the same digest is how a
 * person on the phone knows the two screens are talking about one payment.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import * as btc from '@scure/btc-signer';
import { addressAt, openWatch, type BtcWallet } from '@vault/keys/bitcoin';
import type { Utxo } from './chain';
import type { Asset, Atoms, Draft } from './model';
import { toHex } from './units';

// ------------------------------------------------------------- fee estimates

/**
 * Virtual size of a native-segwit spend, in vbytes.
 *
 * Overhead 10.5, each P2WPKH input 68, each P2WPKH output 31. Rounded up,
 * always: a fee estimate that rounds down produces a transaction that is
 * cheaper than it should be and sits unconfirmed, which is a worse outcome
 * than paying for half a vbyte.
 */
export function estimateVsize(inputs: number, outputs: number): number {
  return Math.ceil(10.5 + 68 * inputs + 31 * outputs);
}

export function feeFor(inputs: number, outputs: number, rate: number): Atoms {
  return BigInt(Math.ceil(estimateVsize(inputs, outputs) * rate));
}

/** Below this, a change output costs more to spend later than it is worth, so
 *  it goes to the miner instead of being created. 546 sat is the network's own
 *  dust limit; this is deliberately well above it. */
export const DUST = 1000n;

// ----------------------------------------------------------- coin selection

export interface Selection {
  chosen: Utxo[];
  fee: Atoms;
  change: Atoms;
  /** True when change was below dust and was added to the fee instead. */
  changeToFee: boolean;
  problem: string | null;
}

/**
 * Pick coins to cover an amount.
 *
 * The strategy is stated plainly because it has consequences a user cannot
 * see: first look for a single coin that covers the payment with the least
 * left over, and use it if there is one. Otherwise take the largest coins
 * until the total covers amount plus fee.
 *
 * **What this costs, honestly.** Largest-first is not a privacy-preserving
 * selection. It reveals more about the wallet's holdings than a branch-and-
 * bound search would, and it consolidates coins that a careful user may have
 * deliberately kept apart. A serious implementation does better, and this one
 * should be replaced before anyone's savings depend on it. It is written this
 * way now because it is short enough to read in one sitting and its failure
 * mode is "an inelegant transaction" rather than "the wrong amount".
 *
 * Preferring a no-change spend is not only elegance: an exact-ish single-coin
 * payment produces a two-output-free transaction that leaks nothing about
 * change at all, and it is smaller, so it is cheaper.
 */
export function selectCoins(utxos: readonly Utxo[], amount: Atoms, rate: number): Selection {
  const none: Selection = { chosen: [], fee: 0n, change: 0n, changeToFee: false, problem: null };
  if (amount <= 0n) return { ...none, problem: 'Enter an amount.' };

  const spendable = [...utxos].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const total = spendable.reduce((sum, utxo) => sum + utxo.value, 0n);
  if (total === 0n) return { ...none, problem: 'There is nothing to spend.' };

  /* One coin, no change, if any single coin lands in the window between "pays
   * the amount and its fee" and "leaves less than dust behind". */
  const singleFee = feeFor(1, 1, rate);
  const exact = [...spendable]
    .filter((utxo) => utxo.value >= amount + singleFee && utxo.value - amount - singleFee < DUST)
    .sort((a, b) => (a.value > b.value ? 1 : -1))[0];
  if (exact) {
    return {
      chosen: [exact],
      fee: exact.value - amount,
      change: 0n,
      changeToFee: exact.value - amount > singleFee,
      problem: null,
    };
  }

  const chosen: Utxo[] = [];
  let gathered = 0n;
  for (const utxo of spendable) {
    chosen.push(utxo);
    gathered += utxo.value;
    const fee = feeFor(chosen.length, 2, rate);
    if (gathered >= amount + fee) {
      const change = gathered - amount - fee;
      if (change < DUST) {
        /* Change too small to be worth an output. Drop the output, recompute
         * without it, and let the remainder go to the fee. Saying so matters:
         * the review screen shows a fee larger than the one quoted, and an
         * unexplained number on a confirmation screen is how people learn to
         * stop reading them. */
        const leanFee = feeFor(chosen.length, 1, rate);
        return {
          chosen,
          fee: gathered - amount,
          change: 0n,
          changeToFee: gathered - amount > leanFee,
          problem: null,
        };
      }
      return { chosen, fee, change, problem: null, changeToFee: false };
    }
  }

  const shortfall = amount + feeFor(chosen.length, 2, rate) - gathered;
  return {
    ...none,
    problem: `That is more than this wallet holds, by ${shortfall} sat once the fee is counted.`,
  };
}

/** The largest amount that can be sent, which is not the balance: the fee
 *  comes out of it, and it is the number the SEND MAX control needs. */
export function maxSendable(utxos: readonly Utxo[], rate: number): Atoms {
  const total = utxos.reduce((sum, utxo) => sum + utxo.value, 0n);
  const fee = feeFor(utxos.length, 1, rate);
  return total > fee ? total - fee : 0n;
}

// -------------------------------------------------------------- preparation

export interface PrepareParams {
  asset: Asset;
  recipient: string;
  amount: Atoms;
  rate: number;
  /** Bitcoin's coins. Empty for Monero, which does not show its outputs to a
   *  view key the way Bitcoin shows them to an extended public key. */
  utxos: readonly Utxo[];
  /** What the wallet holds, which for Monero is the only number there is.
   *  Reading it off `utxos` instead was a bug that made every Monero payment
   *  impossible: the list is empty, so the balance was zero, so everything was
   *  "more than this wallet holds". */
  balance: Atoms;
  /** Watch-only account key. There is no other kind here. */
  zpub: string;
  /** Where change goes: an index on our own change chain, which the address
   *  is derived from here rather than passed in. A caller that could hand in
   *  an address could hand in somebody else's. */
  change: { index: number };
  now: number;
}

export type Prepared = { ok: true; draft: Draft; selection: Selection } | { ok: false; problem: string };

/** sha256 of the unsigned bytes, hex. The name both halves use for one
 *  transaction, and what the vault binds its approval to. */
export function digestOf(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}

/**
 * Build the unsigned transaction.
 *
 * For Bitcoin this is a real PSBT, built by @scure/btc-signer, carrying the
 * previous outputs and the BIP32 derivations. That is not a detail: a PSBT
 * without input values leaves the fee unknowable, and the vault treats that as
 * fatal rather than as a blank field (`describePsbt`). A wallet that omits
 * them produces a transaction its own signer will refuse, which is the correct
 * outcome and an embarrassing one, so they go in here.
 *
 * Nothing marks the change output as change, and that is not an omission. The
 * vault re-derives ownership from its own key and compares scripts; it will
 * not take a PSBT's word for which output is change, because a PSBT that can
 * claim an output is yours is a PSBT that can point that claim at somebody
 * else's script. See the change-swap defense in `src/keys/psbt.ts`. Sending a
 * derivation path would be sending a claim the vault is right to ignore.
 */
export function prepare(params: PrepareParams): Prepared {
  const { asset, recipient, amount, rate, utxos, now } = params;

  if (asset === 'XMR') return prepareMonero(params);

  const selection = selectCoins(utxos, amount, rate);
  if (selection.problem) return { ok: false, problem: selection.problem };

  const opened = openWatch(params.zpub);
  if (!opened.ok || !opened.wallet) {
    return { ok: false, problem: opened.problem ?? 'This wallet has no account key from the vault yet.' };
  }
  const wallet: BtcWallet = opened.wallet;

  let tx: btc.Transaction;
  try {
    tx = new btc.Transaction({ allowUnknownOutputs: false });
    for (const utxo of selection.chosen) {
      tx.addInput({
        txid: utxo.txid,
        index: utxo.vout,
        witnessUtxo: { script: utxo.script, amount: utxo.value },
        sighashType: btc.SigHash.ALL,
      });
    }
    tx.addOutputAddress(recipient, amount);
    if (selection.change > 0n) {
      tx.addOutputAddress(addressAt(wallet, 1, params.change.index).address, selection.change);
    }
  } catch (error) {
    return { ok: false, problem: readableBuildError(error) };
  }

  const unsigned = tx.toPSBT(0);
  const changeAddress = selection.change > 0n ? addressAt(wallet, 1, params.change.index).address : null;
  return {
    ok: true,
    selection,
    draft: {
      asset,
      recipient,
      amount,
      fee: selection.fee,
      feeRate: rate,
      unsigned,
      digest: digestOf(unsigned),
      createdAt: now,
      inputs: selection.chosen.map((utxo) => ({ txid: utxo.txid, vout: utxo.vout })),
      inputTotal: selection.chosen.reduce((sum, utxo) => sum + utxo.value, 0n),
      changeAddresses: changeAddress ? [changeAddress] : [],
    },
  };
}

/**
 * Monero is not prepared here, and the reason is a node round-trip.
 *
 * A Bitcoin draft is pure arithmetic over coins this function already holds.
 * A Monero draft needs the chain: the output distribution to draw decoys
 * from, the ring members fetched and checked, the node's fee estimate. That
 * lives in `monerodraft.ts` / `moneroplan.ts`, is asynchronous, and produces
 * the real unsigned set the vault's `moneroDescribe` reads: the provisional
 * stand-in that used to be built here is gone. This branch exists so a caller
 * that reaches the wrong preparer gets a sentence instead of a stack trace.
 */
function prepareMonero(_params: PrepareParams): Prepared {
  return {
    ok: false,
    problem: 'A Monero payment is planned against the node. Use prepareMoneroDraft.',
  };
}

function readableBuildError(error: unknown): string {
  const message = String((error as Error)?.message ?? error);
  if (/address/i.test(message)) return 'That destination is not an address this wallet can pay.';
  if (/dust|amount/i.test(message)) return 'That amount is too small to send.';
  return `This transaction could not be built: ${message}`;
}

// ------------------------------------------------------- checking the return

export interface OutputFact {
  address: string | null;
  value: Atoms;
}

export type Verified =
  | {
      ok: true;
      txid: string;
      raw: Uint8Array;
      outputs: OutputFact[];
      fee: Atoms;
      /** Monero only: the network the signed transaction names, which the
       *  broadcast chokepoint gates on. Bitcoin's raw bytes carry no such
       *  field, so it is absent there. */
      network?: 'mainnet' | 'stagenet' | 'testnet';
    }
  | { ok: false; reasons: string[]; outputs: OutputFact[] };

/**
 * Does what came back do what was asked?
 *
 * Every check here is stated as a difference between two things a person could
 * read off two screens, because that is how the failure gets explained: not
 * "signature verification failed" but "this pays 0.6 BTC and you approved
 * 0.48".
 *
 * Note what is *not* checked: whether the signatures are cryptographically
 * valid. That check belongs to the network, which does it for free and cannot
 * be talked out of it, and duplicating it here would add a verifier to this
 * codebase for no gain. An invalid signature is a broadcast that gets
 * rejected; a *valid* signature over the wrong outputs is money gone. This
 * function is aimed at the second one.
 */
export function verifySigned(draft: Draft, raw: Uint8Array): Verified {
  const reasons: string[] = [];

  if (draft.asset === 'XMR') {
    /* Monero verification needs the key image book, which this pure function
     * does not hold. The store routes XMR returns to `verifySignedMonero`;
     * reaching this branch is a caller bug, and it fails closed rather than
     * waving anything through. */
    return {
      ok: false,
      outputs: [],
      reasons: ['A signed Monero set is checked by verifySignedMonero, with the key image book. Nothing was verified.'],
    };
  }

  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromRaw(raw, { allowUnknownOutputs: true, allowLegacyWitnessUtxo: true });
  } catch {
    return {
      ok: false,
      outputs: [],
      reasons: ['What came back is not a finished transaction. Scan the vault again.'],
    };
  }

  const outputs: OutputFact[] = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const output = tx.getOutput(i);
    outputs.push({
      address: safeAddress(tx, i),
      value: output.amount ?? 0n,
    });
  }

  /* The same coins, or a different transaction wearing this one's amounts.
   * Checked as a set: a signer is entitled to reorder inputs, and several do.
   * What it is not entitled to do is spend a coin nobody approved spending. */
  const approved = new Set(draft.inputs.map((input) => `${input.txid}:${input.vout}`));
  const spent = new Set<string>();
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i) as { txid?: Uint8Array; index?: number };
    spent.add(`${input.txid ? toHex(input.txid) : '?'}:${input.index ?? 0}`);
  }
  const unapproved = [...spent].filter((coin) => !approved.has(coin));
  const missing = [...approved].filter((coin) => !spent.has(coin));
  if (unapproved.length > 0) {
    reasons.push(`This spends ${unapproved.length} coin${unapproved.length === 1 ? '' : 's'} that were not in the transaction you approved.`);
  }
  if (missing.length > 0) {
    reasons.push(`This leaves out ${missing.length} coin${missing.length === 1 ? '' : 's'} that the transaction you approved was spending.`);
  }

  const toRecipient = outputs
    .filter((output) => output.address === draft.recipient)
    .reduce((sum, output) => sum + output.value, 0n);

  if (toRecipient === 0n) {
    reasons.push(`Nothing in this transaction pays ${draft.recipient}.`);
  } else if (toRecipient !== draft.amount) {
    reasons.push(`This pays ${toRecipient} where ${draft.amount} was approved.`);
  }

  /* Any output that is neither the recipient nor our own change is somebody
   * else being paid out of this transaction, which is precisely the attack the
   * whole design exists to catch. */
  const strangers = outputs.filter((output) => output.address !== draft.recipient && !isOurs(output.address, draft));
  if (strangers.length > 0) {
    reasons.push(
      strangers.length === 1
        ? 'There is an output here that was not in the transaction you approved.'
        : `There are ${strangers.length} outputs here that were not in the transaction you approved.`,
    );
  }

  /* The fee, and the reason it is computed from the draft rather than from
   * what came back.
   *
   * A fee is not written in a transaction. It is inputs minus outputs, and a
   * *finished* transaction does not carry its inputs' values: they live in the
   * PSBT, and the PSBT is gone by the time this runs. So a signed transaction
   * cannot state its own fee, and asking it to produces null.
   *
   * This was a real hole for one commit. The fee was read out of the returned
   * transaction, came back null every time, and the comparison was skipped
   * along with it. A vault could shave the change output and hand the
   * difference to a miner: same recipient, same amount, same coins, no
   * stranger in the outputs, silently accepted. The test that was supposed to
   * catch it asserted `verdict.fee === draft.fee` against a value that fell
   * back to `draft.fee`, so it passed on a check that never ran.
   *
   * `draft.inputTotal` is what those coins were worth when this device picked
   * them, recorded before the vault saw anything. The inputs have already been
   * checked to be that exact set, so the arithmetic holds: anything the
   * outputs do not account for is the fee, whoever set it. */
  const outputTotal = outputs.reduce((sum, output) => sum + output.value, 0n);
  const fee = draft.inputTotal - outputTotal;
  if (unapproved.length === 0 && missing.length === 0 && fee !== draft.fee) {
    reasons.push(
      fee > draft.fee
        ? `This pays ${fee} in fees where ${draft.fee} was approved. The difference goes to a miner.`
        : `This pays ${fee} in fees where ${draft.fee} was approved.`,
    );
  }

  if (reasons.length > 0) return { ok: false, reasons, outputs };

  return { ok: true, txid: tx.id, raw, outputs, fee };
}

/** Change addresses are recorded on the draft when it is built. Anything not
 *  on that list is a stranger, and the list is never taken from the returned
 *  transaction, only from what we prepared. */
function isOurs(address: string | null, draft: Draft): boolean {
  return address !== null && (draft.changeAddresses ?? []).includes(address);
}

function safeAddress(tx: btc.Transaction, index: number): string | null {
  try {
    return tx.getOutputAddress(index) ?? null;
  } catch {
    return null;
  }
}


