/**
 * The seam between the reader and the screen.
 *
 * `describePsbt` decides what a transaction says. A SwiftUI view draws it.
 * Between them is a serialization, and this file is it — the one definition
 * of what crosses, so that the two sides cannot quietly disagree about what a
 * transaction contains.
 *
 * ## Why this exists rather than "just pass the summary"
 *
 * `PsbtSummary` holds `bigint` and `Uint8Array`. Neither survives JSON, and
 * neither exists in Swift. Something has to convert, and the moment that
 * something is written twice — once in the bridge, once in a view that
 * "just needs the fee as a string" — there are two implementations of what a
 * satoshi is worth, and they will disagree on a value nobody tested.
 *
 * So: **every number a person reads is formatted here**, by `formatBtc`, which
 * has tests. The Swift side receives finished strings and renders them. It
 * does no arithmetic on money, no rounding, no unit conversion, and
 * `test/app-wiring.test.ts` fails if it starts.
 *
 * ## Why every output, always
 *
 * The first version of the Swift model had a single `destination` and a single
 * `change`. Most transactions do look like that, and a transaction that pays
 * two people would have shown one of them. Money would have left to an address
 * the person approving it never saw — which is the exact failure the
 * confirmation screen exists to prevent, arrived at through the data model
 * rather than through a lie in the PSBT.
 *
 * A transaction has *n* outputs. The wire carries *n* outputs. What the screen
 * does about a long list is a design problem, and design problems are allowed
 * to be hard; they are not allowed to be solved by dropping the data.
 */

import { formatBtc, type BtcWallet } from '../keys/bitcoin';
import { formatXmr } from '../keys/monero';
import { signingRandomCount, type VaultUnsignedSet } from '../keys/monerobuild';
import { outlineTx, type ReadResult } from '../keys/monerounsigned';
import type { Container } from '../keys/monerotx';
import { describePsbt, type DescribeOptions, type PsbtSummary, type PsbtWarning } from '../keys/psbt';

/** One previous output being spent. */
export interface WireInput {
  /** 1-based, because the screen says "INPUT 2". */
  position: number;
  txid: string;
  vout: number;
  /** Formatted BTC, or null when the PSBT did not say — which is fatal. */
  amount: string | null;
  address: string | null;
  mine: boolean;
  path: string | null;
}

/** One output being paid. */
export interface WireOutput {
  position: number;
  /**
   * Null when the script decodes to no address at all.
   *
   * The screen must render this case explicitly rather than showing a blank
   * where a destination goes; `describePsbt` already makes it fatal when the
   * output carries money, so the screen's job is to say why, not to decide.
   */
  address: string | null;
  /** Always present, so there is something to show when `address` is null. */
  scriptHex: string;
  amount: string;
  mine: boolean;
  path: string | null;
}

export interface WireWarning {
  code: string;
  fatal: boolean;
  message: string;
}

/**
 * Everything the confirmation screen is allowed to know.
 *
 * Deliberately flat and stringly-typed: it crosses a bridge as JSON, and a
 * shape that survives `JSON.stringify` without custom coders is a shape that
 * cannot be subtly mis-decoded on the far side.
 */
export interface WireSummary {
  ok: boolean;
  problem: string | null;
  /** Carried from review to approval to signing. The whole contract. */
  digest: string;
  /** Which keyring this was described against. */
  walletId: string;
  inputs: WireInput[];
  outputs: WireOutput[];
  /** Formatted BTC, every one of them. */
  spending: string;
  leaving: string;
  returning: string;
  /**
   * What the transaction costs *you*. This is the number a screen should put
   * next to the word "paying"; `leaving` is not, because in a collaborative
   * transaction it counts outputs somebody else funded.
   */
  yourNet: string;
  /** Null when it cannot be known, which is fatal and never a blank field. */
  fee: string | null;
  /** e.g. "68 sat/vB". Null when the fee is unknown. */
  feeRate: string | null;
  /** e.g. "~208 vB". An estimate, and worded as one. */
  vsize: string;
  /** The fee as a share of the payment, e.g. "0.03%". Null when either number
   *  is unknown, which includes a transaction that pays nobody. */
  feeShare: string | null;
  warnings: WireWarning[];
  /** True only when nothing fatal and every input is ours. */
  signable: boolean;
  /** The first fatal warning's code, or null. What the refusal screen keys on. */
  refusal: string | null;
}

/**
 * The fee as a percentage of what is being paid.
 *
 * Computed here rather than on the screen, like every other number, and null
 * rather than "0%" or "Infinity" when there is nothing being paid: a
 * consolidation has no meaningful share, and inventing one is worse than an
 * absent row.
 */
function feeShareOf(summary: PsbtSummary): string | null {
  if (summary.fee === null || summary.leaving <= 0n) return null;
  const share = (Number(summary.fee) / Number(summary.leaving)) * 100;
  return `${share < 0.01 ? share.toFixed(4) : share.toFixed(2)}%`;
}

function wireWarning(warning: PsbtWarning): WireWarning {
  return { code: warning.code, fatal: warning.fatal, message: warning.message };
}

/** Convert a described transaction into the shape the screen renders. */
export function toWire(summary: PsbtSummary): WireSummary {
  const fatal = summary.warnings.find((warning) => warning.fatal);
  return {
    ok: summary.ok,
    problem: summary.problem ?? null,
    digest: summary.digest,
    walletId: summary.walletId,
    inputs: summary.inputs.map((input, i) => ({
      position: i + 1,
      txid: input.txid,
      vout: input.vout,
      amount: input.value === null ? null : formatBtc(input.value),
      address: input.address,
      mine: input.mine,
      path: input.path,
    })),
    outputs: summary.outputs.map((output, i) => ({
      position: i + 1,
      address: output.address,
      scriptHex: output.script,
      amount: formatBtc(output.value),
      mine: output.mine,
      path: output.path,
    })),
    spending: formatBtc(summary.spending),
    leaving: formatBtc(summary.leaving),
    returning: formatBtc(summary.returning),
    yourNet: formatBtc(summary.yourNet),
    fee: summary.fee === null ? null : formatBtc(summary.fee),
    feeRate: summary.feeRate === null ? null : `${summary.feeRate} sat/vB`,
    vsize: `~${summary.vsize} vB`,
    feeShare: feeShareOf(summary),
    warnings: summary.warnings.map(wireWarning),
    signable: summary.signable,
    refusal: fatal ? fatal.code : null,
  };
}

// ---------------------------------------------------------------- monero

/**
 * One output of a Monero set, as the confirmation screen renders it. The raw
 * piconero string rides along with the formatted amount because the signed
 * set that comes back is compared in raw units, and a comparison that had to
 * re-parse a display string would be a comparison with a parser in it.
 */
export interface WireMoneroOutput {
  position: number;
  address: string;
  amount: string;
  amountFormatted: string;
  change: boolean;
  /** A zero-amount self-output added only to satisfy the two-output consensus
   *  rule. Listed in the structure, never as a payee. */
  dummy: boolean;
}

/**
 * What the Monero confirmation screen is allowed to know. The counterpart of
 * `WireSummary`, shaped by what a Monero set actually supports: the fee is
 * stated in the set rather than left over, there is no per-input address to
 * show, and the ring is a privacy property the screen names without
 * pretending it is a safety one.
 */
export interface WireMoneroSummary {
  /** keccak of the payload bytes. Carried from review to approval to signing. */
  digest: string;
  network: string;
  inputCount: number;
  ringSize: number;
  outputs: WireMoneroOutput[];
  /** Piconero strings, and the same numbers formatted, from one formatter. */
  paying: string;
  payingFormatted: string;
  fee: string;
  feeFormatted: string;
  /**
   * Exactly how many bytes of fresh platform randomness `moneroSign` needs
   * for this set. Stated by the engine, which knows the formula, so the Swift
   * side never re-derives it and cannot drift from it.
   */
  randomBytes: number;
}

/** Convert a parsed unsigned set into the shape the screen renders. */
export function moneroToWire(set: VaultUnsignedSet, digest: string): WireMoneroSummary {
  /* A dummy output leaves the paying sum only when it genuinely carries
   * nothing; a "dummy" that carries money is counted as a payment, which is
   * the safe direction to be wrong in — it overstates what is leaving. */
  const paying = set.outputs
    .filter((output) => !output.change && !(output.dummy === true && BigInt(output.amount) === 0n))
    .reduce((sum, output) => sum + BigInt(output.amount), 0n);
  return {
    digest,
    network: set.network,
    inputCount: set.inputs.length,
    ringSize: set.ringSize,
    outputs: set.outputs.map((output, i) => ({
      position: i + 1,
      address: output.address,
      amount: output.amount,
      amountFormatted: formatXmr(BigInt(output.amount)),
      change: output.change,
      dummy: output.dummy === true && BigInt(output.amount) === 0n,
    })),
    paying: paying.toString(),
    payingFormatted: formatXmr(paying),
    fee: set.fee,
    feeFormatted: formatXmr(BigInt(set.fee)),
    randomBytes: signingRandomCount(set.inputs.length, set.ringSize, set.outputs.length) * 32,
  };
}

// ------------------------------------------------------- monero, wallet2's own
//
// A different thing from `WireMoneroSummary` above, and the difference is the
// entire reason it is a different shape.
//
// `WireMoneroSummary` describes a set the vault has *checked*: `moneroDescribe`
// re-derives the claimed change against this wallet's own address and refuses
// the whole set when they disagree, so a screen rendering it is rendering
// something the device stands behind, and the next lever on that screen signs.
//
// This describes a file `wallet2` wrote. Every number in it is the sending
// wallet's account of its own transaction. Nothing in the file is evidence for
// anything else in it, none of it is checked here, and none of it could be:
// a watch-only wallet that lies about a destination produces a file that reads
// beautifully. So there is no digest, because nothing downstream signs; there
// is no `signable`, because the answer is no and it is not a property of the
// file; and every field is named for the fact that the file *says* it.

/** One payment a wallet2 file says it intends to make. */
export interface WireMoneroFilePayment {
  position: number;
  /**
   * The address as the sending wallet recorded it, or null when it kept none.
   *
   * `tx_destination_entry::original` is only populated when the wallet held on
   * to what a person typed. When it is empty the file still carries the two
   * public keys, and an address could be *constructed* from them — but not
   * honestly, because the network byte is not in the file, so the same keys
   * would render as a mainnet address in a stagenet transaction. A screen that
   * says the file did not record it is right; one that shows a confident
   * address for the wrong network is the failure this project is about.
   */
  address: string | null;
  /** "SUBADDRESS", "INTEGRATED" or "STANDARD", as the file classifies it. */
  kind: string;
  amountFormatted: string;
}

/** One transaction inside the file. A set can hold several. */
export interface WireMoneroFileTx {
  position: number;
  /** What the named inputs are worth in total, per the file. */
  spendingFormatted: string;
  /** Spending, less what comes back as change. */
  payingFormatted: string;
  changeFormatted: string;
  /** Inputs minus outputs. The file carries no fee field; that is what a fee
   *  is, and computing it here is the only way to show one. */
  feeFormatted: string;
  ringSize: number;
  inputCount: number;
  outputCount: number;
  /** "Immediately", or the block or time the file says it is locked until. */
  spendableNote: string;
  payments: WireMoneroFilePayment[];
}

/**
 * A wallet2 file, as the read-only screen renders it.
 *
 * `problem` and an empty `transactions` is a complete, valid answer: the file
 * was recognized and could not be opened, and saying which file it is and why
 * it did not open is more use than a blank refusal. Nothing here can be signed
 * either way, so there is no fail-closed decision resting on this shape.
 */
export interface WireMoneroFile {
  /** Plain words for the file, from the container's magic. */
  what: string;
  /** Whether the vault opened it. False leaves `transactions` empty. */
  readable: boolean;
  /** Why it did not open, or why this build will not try. Null on success. */
  problem: string | null;
  transactions: WireMoneroFileTx[];
  /** Every transaction's payments added up, so the screen can lead with one
   *  number when the file holds several. */
  payingFormatted: string;
  feeFormatted: string;
}

/**
 * Monero's unlock time, in words.
 *
 * Under `CRYPTONOTE_MAX_BLOCK_NUMBER` (500000000) the value is a block height
 * and above it a unix timestamp — one field, two meanings, decided by
 * magnitude. Formatted here rather than on the screen for the same reason
 * every amount is: one implementation, in the language with the tests.
 */
function spendableNoteFor(unlockTime: bigint): string {
  if (unlockTime === 0n) return 'Immediately';
  if (unlockTime < 500_000_000n) return `Not before block ${unlockTime}`;
  const at = new Date(Number(unlockTime) * 1000);
  if (Number.isNaN(at.getTime())) return `Not before unlock time ${unlockTime}`;
  return `Not before ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function paymentKind(destination: { isSubaddress: boolean; isIntegrated: boolean }): string {
  if (destination.isIntegrated) return 'INTEGRATED';
  return destination.isSubaddress ? 'SUBADDRESS' : 'STANDARD';
}

/**
 * Convert what the reader found into the shape the read-only screen renders.
 *
 * Takes the container as well as the read, so that a file this build will not
 * open is still described by name. Both paths produce the same shape; the
 * difference is `readable` and an empty list.
 */
export function moneroFileToWire(container: Container, read: ReadResult): WireMoneroFile {
  const set = read.ok ? read.set : undefined;
  const transactions = (set?.txes ?? []).map((tx, i) => {
    const outline = outlineTx(tx);
    return {
      position: i + 1,
      spendingFormatted: formatXmr(outline.spending),
      payingFormatted: formatXmr(outline.paying),
      changeFormatted: formatXmr(outline.change),
      feeFormatted: formatXmr(outline.fee),
      ringSize: outline.ringSize,
      inputCount: outline.inputs,
      outputCount: outline.outputs,
      spendableNote: spendableNoteFor(outline.unlockTime),
      payments: outline.destinations.map((destination, j) => ({
        position: j + 1,
        address: destination.original === '' ? null : destination.original,
        kind: paymentKind(destination),
        amountFormatted: formatXmr(destination.amount),
      })),
    };
  });

  /* Summed from the same outlines the rows were built from, rather than
   * re-derived, so the total on the screen cannot disagree with the numbers
   * above it. */
  const outlines = (set?.txes ?? []).map(outlineTx);
  return {
    what: container.what,
    readable: read.ok,
    problem: read.ok ? null : (read.problem ?? container.refusal),
    transactions,
    payingFormatted: formatXmr(outlines.reduce((total, one) => total + one.paying, 0n)),
    feeFormatted: formatXmr(outlines.reduce((total, one) => total + one.fee, 0n)),
  };
}

/** Read a PSBT and produce the screen's view of it, in one call. */
export function describeForScreen(
  psbt: Uint8Array,
  wallet: BtcWallet,
  options: DescribeOptions = {},
): WireSummary {
  return toWire(describePsbt(psbt, wallet, options));
}

/** The JSON that actually crosses the bridge. */
export function encodeForScreen(summary: WireSummary): string {
  return JSON.stringify(summary);
}
