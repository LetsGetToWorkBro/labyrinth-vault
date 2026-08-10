/**
 * A stand-in for the vault, so the whole loop can be walked without one.
 *
 * ## Read this before anything else in the file
 *
 * There is a private key in here. It is the seed phrase published in BIP84 —
 * `abandon abandon … about` — the most widely printed key in Bitcoin, used by
 * every wallet's test suite, and the one `src/keys/bitcoin.ts` self-tests
 * against. It controls nothing, because everyone has it.
 *
 * It exists for one reason: this is a frontend, there is no second phone, and
 * the states after "the vault signed it" are the most important screens in the
 * application. A signature received, a checksum matched, a transaction that
 * does *not* match what was approved — those cannot be designed from
 * imagination or reviewed as static mockups. They have to be reachable.
 *
 * ## What keeps this from becoming the thing the product exists to prevent
 *
 * The rule the whole system rests on is that a private key never enters the
 * online half. This file is a deliberate, quarantined, labelled exception for
 * a build with no vault, and it is arranged so it cannot quietly stop being
 * one:
 *
 *   - it lives under `src/demo/`, and nothing outside `src/demo` and the
 *     screens' demo controls imports it;
 *   - every path into it is behind `DEMO`, which is a constant in this file;
 *   - the user interface never calls it silently. The control is visible, it
 *     is labelled `STAND-IN VAULT`, and the screen says in plain words that
 *     this device is signing for itself because there is no vault here;
 *   - it takes the words as an argument with no default, so no code path picks
 *     up a key by omission.
 *
 * When there is a real vault to scan, this file is deleted rather than
 * disabled. A demo signer left in a shipping wallet behind a flag is precisely
 * how a product like this fails, and it fails silently.
 */

import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import type { Draft } from '../core/model';

/** Whether the stand-in exists at all in this build. */
export const DEMO = true;

/** BIP84's published test vector. Empty, and everybody's. */
export const PUBLISHED_TEST_WORDS =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

export type StandinBehaviour =
  /** Sign what was asked, the way a vault would. */
  | 'sign'
  /** Sign a *different* transaction paying somebody else, so the mismatch
   *  screen can be reached the way it would really be reached: with valid,
   *  genuinely signed bytes that nobody approved. */
  | 'tamper'
  /** Return nothing, for the screen where a scan does not finish. */
  | 'silent';

/**
 * Produce the bytes a vault would hand back.
 *
 * Deliberately not sharing code with `verifySigned`: the checker and the thing
 * being checked should agree only by both being right.
 */
export function standInVault(draft: Draft, words: string, behaviour: StandinBehaviour = 'sign'): Uint8Array | null {
  if (!DEMO) return null;
  if (behaviour === 'silent') return null;
  if (draft.asset !== 'BTC') return null;

  const original = btc.Transaction.fromPSBT(draft.unsigned, {
    allowUnknown: true,
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });

  let tx = original;
  if (behaviour === 'tamper') {
    /* The attack, exactly: same coins, same amount, same fee, one different
     * destination, and a real signature over all of it. */
    const hostile = new btc.Transaction();
    for (let i = 0; i < original.inputsLength; i++) hostile.addInput(original.getInput(i));
    hostile.addOutputAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', draft.amount);
    for (let i = 1; i < original.outputsLength; i++) hostile.addOutput(original.getOutput(i));
    tx = btc.Transaction.fromPSBT(hostile.toPSBT(0), { allowUnknownOutputs: true });
  }

  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(words));
  for (let input = 0; input < tx.inputsLength; input++) {
    for (let index = 0; index < 12; index++) {
      const key = root.derive(`m/84'/0'/0'/0/${index}`).privateKey;
      /* SIGHASH_ALL and nothing else, which is what the vault pins too. */
      if (key && tx.signIdx(key, input, [btc.SigHash.ALL])) break;
    }
  }

  try {
    tx.finalize();
    return tx.extract();
  } catch {
    return null;
  }
}
