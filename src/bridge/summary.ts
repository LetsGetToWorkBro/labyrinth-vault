/**
 * The seam between the reader and the screen.
 *
 * `describePsbt` decides what a transaction says. A SwiftUI view draws it.
 * Between them is a serialisation, and this file is it — the one definition
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
