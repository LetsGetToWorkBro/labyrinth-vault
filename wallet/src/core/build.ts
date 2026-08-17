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
import { canonicalBtcAddress, scriptForAddress } from './addresses';
import type { Utxo } from './chain';
import type { Asset, Atoms, Draft } from './model';
import { toHex } from './units';

// ------------------------------------------------------------- fee estimates

/**
 * Vbytes one output adds: 8 for the value, 1 for the script's length prefix,
 * and the script.
 *
 * The vault's `psbt.ts` sums exactly this, and the two halves have to agree.
 * They did not: this side charged 31 vbytes for every output, which is right
 * for P2WPKH and wrong for everything else the wallet will happily pay. A
 * taproot destination is 43, a legacy one 34. At the economy rate, which
 * `feeOptionsFrom` floors at 1 sat/vB because that is Core's own
 * `minrelaytxfee`, a 12-vbyte underestimate is a transaction quoted at 0.92
 * sat/vB, which is under the relay minimum and never reaches a mempool at all.
 */
export function outputVbytes(script: Uint8Array): number {
  return 9 + script.length;
}

/** A P2WPKH output. This wallet's own change is always this shape, because
 *  BIP84 is the only descriptor here. */
export const CHANGE_VBYTES = 31;

/**
 * The widest standard output, used when the destination is not known yet.
 *
 * P2TR and P2WSH both carry a 34-byte script, so 43. Overbudgeting is the safe
 * direction and it is not symmetrical: a budget that is too small makes SEND
 * MAX produce an amount this file's own `selectCoins` refuses, while a budget
 * that is too large sends a few sat to a miner and says so on the review
 * screen.
 */
export const WIDEST_OUTPUT_VBYTES = 43;

/** What an output for this destination costs, or the widest standard one when
 *  the destination cannot be decoded. `prepare` refuses such a destination a
 *  few lines later; this only has to avoid guessing low in the meantime. */
export function outputVbytesFor(address: string): number {
  const script = scriptForAddress(address);
  return script === null ? WIDEST_OUTPUT_VBYTES : outputVbytes(script);
}

/**
 * Virtual size of a native-segwit spend, in vbytes.
 *
 * Overhead 10.5, each P2WPKH input 68, and each output priced from its own
 * script rather than assumed. Rounded up, always: a fee estimate that rounds
 * down produces a transaction that is cheaper than it should be and sits
 * unconfirmed, which is a worse outcome than paying for half a vbyte.
 */
export function estimateVsize(inputs: number, outputs: readonly number[]): number {
  const outs = outputs.reduce((sum, vbytes) => sum + vbytes, 0);
  return Math.ceil(10.5 + 68 * inputs + outs);
}

export function feeFor(inputs: number, outputs: readonly number[], rate: number): Atoms {
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
 * Where the next change output should go, read from the scan.
 *
 * The defect this replaces was an absolute index chosen in the store before
 * the scanner existed: change went to 1/24, and `discover.ts` walks the change
 * branch from zero and stops after `GAP_LIMIT` consecutive unused addresses.
 * Nothing at 0..23 was ever used, so the gap never reset, so 1/24 was never
 * queried and every change output the app made was invisible to it forever.
 * The coins were on the chain and the vault recognized them; only this half
 * could not see them.
 *
 * So the index is derived rather than chosen, exactly the way the receive
 * address already is: the first index on the change branch that the scan has
 * not seen a payment to. `ahead` is how many drafts have been prepared since
 * the last refresh, because two payments composed back to back must not land
 * change on one address, which would publish the link between them.
 *
 * Zero when the scan knows nothing. That is the correct answer rather than a
 * fallback: an unscanned wallet has used no change addresses, and starting at
 * zero is what keeps every one of them inside the window.
 */
export function nextChangeIndex(
  addresses: readonly { path: string | null; used: boolean }[],
  ahead = 0,
): number {
  let highestUsed = -1;
  let firstUnused: number | null = null;
  for (const entry of addresses) {
    if (entry.path === null) continue;
    const match = /^1\/(\d+)$/.exec(entry.path);
    if (!match) continue;
    const index = Number.parseInt(match[1]!, 10);
    if (!Number.isSafeInteger(index)) continue;
    if (entry.used) highestUsed = Math.max(highestUsed, index);
    else if (firstUnused === null || index < firstUnused) firstUnused = index;
  }

  /* Past every used one, not merely at the first gap. A wallet whose change at
   * 1/2 is used while 1/1 is free would otherwise reuse 1/1, and address reuse
   * is the thing this function exists to avoid. */
  const base = firstUnused !== null && firstUnused > highestUsed ? firstUnused : highestUsed + 1;
  return Math.max(0, base) + Math.max(0, ahead);
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
 *
 * **The no-change window, and why it is not only the single-coin case.** For
 * one commit the no-change spend existed only for a wallet whose payment fit
 * in one coin. Every other wallet fell through to a loop that tested against a
 * two-output fee and refused anything it could not leave change from, which
 * meant that `maxSendable`, which budgets one output because a sweep has no
 * change, produced a number this function rejected by exactly the width of the
 * change output. Pressing MAX and then REVIEW got a refusal from the wallet
 * that had computed the number. So the loop tests both shapes: cover the
 * payment with change, or cover it without one and let the remainder go to the
 * fee.
 */
export function selectCoins(
  utxos: readonly Utxo[],
  amount: Atoms,
  rate: number,
  /** Where the money is going, which decides what its output costs. Required
   *  rather than defaulted: a default is how every output came to be priced as
   *  P2WPKH, and a wrong fee here is a transaction that does not relay. */
  recipient: string,
): Selection {
  const none: Selection = { chosen: [], fee: 0n, change: 0n, changeToFee: false, problem: null };
  if (amount <= 0n) return { ...none, problem: 'Enter an amount.' };

  const paying = outputVbytesFor(recipient);
  const withChange = [paying, CHANGE_VBYTES];
  const withoutChange = [paying];

  const spendable = [...utxos].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const total = spendable.reduce((sum, utxo) => sum + utxo.value, 0n);
  if (total === 0n) return { ...none, problem: 'There is nothing to spend.' };

  /* One coin, no change, if any single coin lands in the window between "pays
   * the amount and its fee" and "leaves less than dust behind". */
  const singleFee = feeFor(1, withoutChange, rate);
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
    const fee = feeFor(chosen.length, withChange, rate);
    const leanFee = feeFor(chosen.length, withoutChange, rate);
    if (gathered >= amount + fee) {
      const change = gathered - amount - fee;
      if (change < DUST) {
        /* Change too small to be worth an output. Drop the output, recompute
         * without it, and let the remainder go to the fee. Saying so matters:
         * the review screen shows a fee larger than the one quoted, and an
         * unexplained number on a confirmation screen is how people learn to
         * stop reading them. */
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
    if (gathered >= amount + leanFee) {
      /* Enough for the payment but not for a change output on top of it, which
       * is the sweep: every coin in, one output out, and the few sat between
       * what is left and the lean fee go to the miner because there is nowhere
       * else for them to go. Taking it here rather than gathering another coin
       * is also the cheaper answer, since another input costs 68 vbytes and the
       * change output it would fund costs 31. */
      return {
        chosen,
        fee: gathered - amount,
        change: 0n,
        changeToFee: gathered - amount > leanFee,
        problem: null,
      };
    }
  }

  /* Quoted against the shape the wallet would actually have to build, which is
   * the no-change one: at this point every coin is in and there is still not
   * enough, so a change output was never on the table and charging for one
   * would overstate the shortfall. */
  const shortfall = amount + feeFor(chosen.length, withoutChange, rate) - gathered;
  return {
    ...none,
    problem: `That is more than this wallet holds, by ${shortfall} sat once the fee is counted.`,
  };
}

/**
 * The largest amount that can be sent, which is not the balance: the fee comes
 * out of it, and it is the number the SEND MAX control needs.
 *
 * `recipient` is optional because MAX is reachable before a destination has
 * been entered, and absent one the widest standard output is budgeted. That is
 * the safe direction: overbudgeting leaves a few sat that `selectCoins` hands
 * to the miner, while underbudgeting produces an amount `selectCoins` refuses,
 * which is a refusal from the wallet that computed the number.
 */
export function maxSendable(utxos: readonly Utxo[], rate: number, recipient?: string): Atoms {
  const paying = recipient === undefined || recipient === '' ? WIDEST_OUTPUT_VBYTES : outputVbytesFor(recipient);
  const total = utxos.reduce((sum, utxo) => sum + utxo.value, 0n);
  const fee = feeFor(utxos.length, [paying], rate);
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
  const { asset, amount, rate, utxos, now } = params;

  if (asset === 'XMR') return prepareMonero(params);

  /* One spelling of the destination from here to the broadcast button. An
   * uppercase bech32 address is valid, is what BIP173 recommends inside a QR,
   * and is what several senders hand over, but every re-encoding of it is
   * lowercase, including `getOutputAddress` on the transaction that comes back
   * from the vault. Recording the pasted form on the draft made `verifySigned`
   * refuse a byte-correct signature and accuse the vault of redirecting the
   * payment. Canonicalizing here fixes it for every caller, including the swap
   * flow, which fills the recipient in with no user involvement at all. */
  const recipient = canonicalBtcAddress(params.recipient);

  const selection = selectCoins(utxos, amount, rate, recipient);
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

  /* The comparison is on meaning, not on spelling, for the same reason the
   * header gives for comparing meaning rather than bytes. `getOutputAddress`
   * re-encodes every address lowercase, and BIP173 makes an uppercase bech32
   * address valid, so a draft holding the pasted form failed this check on a
   * transaction that was correct in every respect. `prepare` already stores
   * the canonical form; this is here so a draft built anywhere else cannot
   * reintroduce a refusal that blames the vault for the wallet's spelling. */
  const recipient = canonicalBtcAddress(draft.recipient);

  const toRecipient = outputs
    .filter((output) => output.address === recipient)
    .reduce((sum, output) => sum + output.value, 0n);

  if (toRecipient === 0n) {
    reasons.push(`Nothing in this transaction pays ${recipient}.`);
  } else if (toRecipient !== draft.amount) {
    reasons.push(`This pays ${toRecipient} where ${draft.amount} was approved.`);
  }

  /* Any output that is neither the recipient nor our own change is somebody
   * else being paid out of this transaction, which is precisely the attack the
   * whole design exists to catch. */
  const strangers = outputs.filter((output) => output.address !== recipient && !isOurs(output.address, draft));
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


