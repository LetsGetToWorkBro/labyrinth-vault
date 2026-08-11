/**
 * The paired watch-only keys, and why they live apart from everything else.
 *
 * ## Two stores, two sensitivities
 *
 * `persist.ts` keeps node addresses and a scan height in a plain JSON file,
 * and takes some care to store no keys, with a test holding it to that. This
 * file is where the keys go instead, and the split is the point:
 *
 *   - A node address is configuration. The worst it can do is be wrong.
 *   - An account key and a view key cannot spend, and they are still the
 *     watching half of somebody's finances: whoever reads them sees every
 *     payment that wallet ever receives, forever. That deserves the keychain,
 *     which is encrypted at rest, excluded from ordinary backups' plaintext,
 *     and gated by the device's own unlock.
 *
 * "Cannot spend" is why this is the keychain and not a passphrase prompt. The
 * threat that matters is a copy of the phone's filesystem; the keychain
 * answers that. A person with the unlocked phone in hand can already see the
 * balance on screen, so a second password here would protect nothing anyone
 * is attacking.
 *
 * ## Nothing read back is trusted, again
 *
 * The same rule as the node file, for the same reasons: everything loaded
 * goes back through `revalidatePairing`, which re-runs the acceptance checks
 * a camera scan gets. A stored zpub that no longer derives its own first
 * address, a view key that no longer matches its address, an unknown schema:
 * each one loads as nothing rather than as a guess.
 */

import { revalidatePairing, type Pairing } from '../core/pairing';
import type { Store } from './persist';

/** Bumped only if the shape changes in a way an old reader would misread. */
export const KEYS_SCHEMA = 1;

export async function loadPairing(store: Store): Promise<Pairing | null> {
  let text: string | null;
  try {
    text = await store.read();
  } catch {
    return null;
  }
  if (!text) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as { schema?: unknown; pairing?: unknown };
  if (body.schema !== KEYS_SCHEMA) return null;
  return revalidatePairing(body.pairing);
}

export async function savePairing(store: Store, pairing: Pairing): Promise<void> {
  try {
    await store.write(JSON.stringify({ schema: KEYS_SCHEMA, pairing }));
  } catch {
    /* A pairing that fails to save is a pairing that has to be scanned again
     * next launch, which is an inconvenience. Crashing the moment after a
     * successful scan is not. */
  }
}

export async function clearPairing(store: Store): Promise<void> {
  try {
    await store.clear();
  } catch {
    /* Forgetting is best-effort by nature: if the delete fails the next load
     * still revalidates, and a person can try again. */
  }
}
