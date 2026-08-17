/**
 * Key images for an account whose spend key is on this phone.
 *
 * ## The hole this fills
 *
 * A Monero coin is spendable only once the wallet holds its key image, because
 * an image is the only way to know the coin has not already been spent. The
 * wallet's image book had exactly one writer: `offerReply`, fed by an
 * XMRKEYIMAGES payload scanned off a vault's screen. That is correct for a
 * vault-paired account and it left a hot account with no route at all:
 * `moneroSpendable` filters to outputs covered by an image, so the set was
 * always empty, and a phone-only wallet was told to go and scan a vault it does
 * not have. The Monero signer was built, tested end to end, and unreachable.
 *
 * A hot account does not need the trip. Computing an image needs the spend
 * key, and on this account the spend key is right here. That is the whole
 * difference between the two, and it is the difference the airgap is *for*: the
 * vault does this across a room precisely because its key never comes to the
 * phone.
 *
 * ## Why it goes through the same payload the vault sends
 *
 * It would be shorter to write images straight into the book. It would also be
 * a second way in, and the first one carries checks: `offerReply` refuses
 * images for outputs this wallet has not seen, counts what the vault refused,
 * and keeps the book's accounting honest. A local path that skipped them would
 * be the place a bug lives, because it is the path nobody tests against a real
 * vault. So this produces the same bytes a vault produces and hands them to the
 * same door.
 */

import { computeKeyImages, encodeKeyImageReply, parseKeyImageRequest } from '@vault/keys/keyimages';
import { wipeWallet } from '@vault/keys/monero';
import { openMonero, canSignHere, type HotRecord, type Source } from './keyvault';


export type HotImages =
  /** The same bytes a vault would have drawn on its screen. */
  | { ok: true; payload: Uint8Array }
  | { ok: false; problem: string };

/**
 * Compute this account's key images, locally.
 *
 * `source` is checked first and for the same reason it is checked first
 * everywhere else: a vault account's spend key is not on this device, so there
 * is nothing here to compute from, and a function that tried would either fail
 * confusingly or, worse, succeed against the wrong keys. The refusal names
 * where that account's images do come from.
 */
export function hotKeyImages(
  source: Source,
  record: HotRecord,
  /** The XMROUTPUTS payload this wallet would have shown a vault. */
  requestPayload: Uint8Array,
): HotImages {
  if (!canSignHere(source)) {
    return {
      ok: false,
      problem:
        'This account was paired from a vault, so its spend key is not on this device. ' +
        'Its key images come back from the vault over the camera.',
    };
  }

  if (record.xmrSeed === null) {
    return {
      ok: false,
      problem: 'This phone holds no Monero keys. Restore your twenty-five words to spend from it.',
    };
  }

  /* Parsed by the vault's own parser rather than trusted, even though this app
   * built the bytes a moment ago. A local path that skipped the parse would be
   * the one place the wire format is not checked, which is the place a format
   * bug survives. */
  const parsed = parseKeyImageRequest(requestPayload);
  if (!parsed.ok) {
    return { ok: false, problem: parsed.problem };
  }
  if (parsed.request.outputs.length === 0) {
    /* Nothing found yet is not a failure. A scan that has seen no payments has
     * nothing to compute, and saying so plainly stops a screen reporting an
     * error for an empty wallet. */
    return { ok: false, problem: 'No Monero payments have been found for this account yet.' };
  }

  const wallet = openMonero(record);
  if (wallet === null) {
    return { ok: false, problem: 'The stored Monero keys could not be opened.' };
  }

  try {
    const reply = computeKeyImages(wallet, parsed.request);
    return { ok: true, payload: encodeKeyImageReply(reply) };
  } finally {
    /* In a `finally`, so a throw inside the computation still closes over the
     * spend key rather than leaving it alive in a rejected call. */
    wipeWallet(wallet);
  }
}
