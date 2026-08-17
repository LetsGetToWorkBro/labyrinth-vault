/**
 * Signing on this device, for the accounts whose keys are on it.
 *
 * ## No new cryptography, on purpose
 *
 * Every signer this file reaches for already exists and is already checked
 * against somebody else's code. Bitcoin is `@vault/keys/psbt`, whose signatures
 * are verified against BIP84's published vector. Monero is
 * `@vault/keys/monerobuild`, which `wallet/scripts/stagenet-send.ts` has been
 * driving end to end since it was written, and whose primitives are pinned to
 * Monero's own test vectors. `wallet/tsconfig.json` maps `@vault/*` at the
 * vault's `src/`, so this is the same code the airgapped half runs, not a
 * second implementation of it.
 *
 * What is new here is the *ordering*, and that is the whole file.
 *
 * ## The order, and why each step is where it is
 *
 *   1. `canSignHere`. First, absolutely, before anything else is read. A vault
 *      account is refused here whatever else this phone is holding.
 *   2. The Face ID gate. Before a key is opened, not after: an authorization
 *      that runs after the seed is already in memory is a formality.
 *   3. Open, sign, close. The wallet object exists for the length of one
 *      signature and is wiped in a `finally`, so a throw between opening and
 *      returning does not leave a spend key alive in a rejected promise.
 *
 * ## What this deliberately does not do
 *
 * It does not check the result. The signed bytes go back to the caller and
 * through `verifySigned` exactly as if they had arrived over a camera from a
 * vault, which is the one gate into a broadcastable state. A local signer that
 * marked its own work as verified would be the second route into `ready`, and
 * the property `session.ts` holds is that there is only one.
 *
 * It also does not draw its own randomness. The scalars are a parameter for
 * the same reason `makeHotRecord` takes its entropy as one: a signer that
 * reaches for a CSPRNG cannot be run against a known answer, and Monero
 * signing consumes a precise count of scalars that a test needs to be able to
 * fix.
 */

import { describePsbt, signPsbt } from '@vault/keys/psbt';
import { encodeSignedTx, parseUnsignedSet, signingRandomCount, signMoneroSpend } from '@vault/keys/monerobuild';
import { wipeWallet } from '@vault/keys/monero';
import { canSignHere, closeBitcoin, openBitcoin, openMonero, type HotRecord, type Source } from './keyvault';
import type { Draft } from './model';

export type HotSigned =
  /** The signed bytes, for the caller to put through `verifySigned`. */
  | { ok: true; raw: Uint8Array }
  | { ok: false; problem: string };

/** What the Face ID prompt answered. Supplied by the caller, so every branch
 *  below runs under Node and the refusals can actually be read in a test. */
export type GateResult = { ok: true } | { ok: false; problem: string };

export interface HotSignParams {
  /** Where the account's keys are. Checked first and refused if not `hot`. */
  source: Source;
  /** The keys themselves. */
  record: HotRecord;
  /** What was composed, reviewed, and is about to be signed. */
  draft: Draft;
  /** The Face ID prompt. Awaited before any key is opened. */
  gate: () => Promise<GateResult>;
  /** `count` scalars of 32 bytes each, from the platform CSPRNG in the app. */
  scalars: (count: number) => Uint8Array[];
}

export async function signHere(params: HotSignParams): Promise<HotSigned> {
  const { source, record, draft, gate, scalars } = params;

  /* First, and not merely early. Every other check in this function is about
   * whether a signature can be made; this one is about whether it may be, and
   * a `may` that runs after a `can` is a `may` somebody reorders. */
  if (!canSignHere(source)) {
    return {
      ok: false,
      problem:
        'This account was paired from a vault, so its keys are not on this device. ' +
        'Your vault signs for it.',
    };
  }

  /* Before the seed is touched. `signgate.ts` decides whether to prompt and
   * what to refuse; this only cares that the answer came back yes. */
  const allowed = await gate();
  if (!allowed.ok) return { ok: false, problem: allowed.problem };

  return draft.asset === 'BTC' ? signBitcoin(record, draft) : signMonero(record, draft, scalars);
}

/**
 * Bitcoin, through the vault's own PSBT signer.
 *
 * `signPsbt` takes the approval as an argument and re-checks its digest
 * against the bytes it is signing. That is not ceremony imported for its own
 * sake: it is the check that makes "described one PSBT, signed another"
 * impossible to write, and it is worth as much on this side as on the vault.
 * The summary is computed here, from these bytes, immediately before signing.
 */
function signBitcoin(record: HotRecord, draft: Draft): HotSigned {
  const wallet = openBitcoin(record);
  if (wallet === null) {
    return {
      ok: false,
      problem: 'This phone holds no Bitcoin keys. Restore your twelve words to spend from it.',
    };
  }

  try {
    const approval = describePsbt(draft.unsigned, wallet);
    if (!approval.ok) {
      return { ok: false, problem: approval.problem ?? 'That transaction could not be read.' };
    }

    const signed = signPsbt(draft.unsigned, wallet, approval);
    if (!signed.ok || !signed.hex) {
      return {
        ok: false,
        problem: signed.problem ?? 'Signing produced no finished transaction.',
      };
    }
    return { ok: true, raw: hexToBytes(signed.hex) };
  } finally {
    /* In a `finally`, so a throw anywhere above still closes over the key
     * rather than leaving it alive inside a rejected promise. */
    closeBitcoin(wallet);
  }
}

/**
 * Monero, through the same path `stagenet-send.ts` drives.
 *
 * The unsigned set is parsed rather than trusted, by the vault's own parser,
 * because these bytes were built by this app and a signer that trusts its
 * caller's framing is a signer with no opinion about what it is signing.
 */
function signMonero(
  record: HotRecord,
  draft: Draft,
  scalars: (count: number) => Uint8Array[],
): HotSigned {
  const wallet = openMonero(record);
  if (wallet === null) {
    return {
      ok: false,
      problem: 'This phone holds no Monero keys. Restore your twenty-five words to spend from it.',
    };
  }

  try {
    const parsed = parseUnsignedSet(draft.unsigned);
    if (!parsed.ok) return { ok: false, problem: parsed.problem };

    const need = signingRandomCount(
      parsed.set.inputs.length,
      parsed.set.ringSize,
      parsed.set.outputs.length,
    );
    const random = scalars(need);
    if (random.length !== need) {
      /* A short draw is a silent weakening of a signature rather than a
       * failure, so it is made loud. */
      return {
        ok: false,
        problem: `Signing needs ${need} random values and was given ${random.length}.`,
      };
    }

    const signed = signMoneroSpend(wallet, parsed.set, random);
    if (!signed.ok) return { ok: false, problem: signed.problem };
    return { ok: true, raw: encodeSignedTx(signed.tx) };
  } finally {
    wipeWallet(wallet);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
