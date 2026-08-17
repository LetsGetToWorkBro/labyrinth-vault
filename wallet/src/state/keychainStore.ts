/**
 * The `Store` that is really the device keychain.
 *
 * Same split as `fileStore.ts` against `persist.ts`: this file has no
 * validation and `persistKeys.ts` has no import from `expo-secure-store`, so
 * the loading and saving logic runs under Node in tests while the thing the
 * app runs is the same code.
 *
 * `expo-secure-store` is Keychain Services on iOS. The keychain is not one of
 * Apple's required-reason APIs, so both apps' privacy manifests keep their
 * truthfully empty `NSPrivacyAccessedAPITypes`, which is the same bar
 * `fileStore.ts` was chosen against.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, both halves deliberate. Unlocked, because
 * the wallet reads the pairing at launch in the foreground and has no
 * background life that needs it. This-device-only, because a watch-only key
 * that quietly rides a backup onto the next phone is a copy nobody decided to
 * make; pairing again is one scan, and deciding is the point.
 */

import { deleteItemAsync, getItemAsync, setItemAsync, WHEN_UNLOCKED_THIS_DEVICE_ONLY } from 'expo-secure-store';
import type { Store } from './persist';

/**
 * Two items, and they are not allowed to become one.
 *
 * The pairing is a vault's watch-only keys. The spending record is this
 * wallet's own seed. They arrive by different routes, they mean different
 * things, and one of them can move money.
 *
 * Sharing a keychain item would make unpairing a vault delete a seed, which is
 * a wipe wearing the word "unpair", and it would make the two records overwrite
 * each other in whichever order they happened to be written. Separate names
 * cost nothing and there is no version of this where they should be merged.
 */
const PAIRING_KEY = 'labyrinth-pairing';
const SPENDING_KEY = 'labyrinth-spending-keys';

function itemStore(key: string): Store {
  const options = { keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return {
    async read(): Promise<string | null> {
      return getItemAsync(key, options);
    },
    async write(text: string): Promise<void> {
      await setItemAsync(key, text, options);
    },
    async clear(): Promise<void> {
      await deleteItemAsync(key, options);
    },
  };
}

/** The vault pairing: an account key and a view key, which cannot spend. */
export function keychainStore(): Store {
  return itemStore(PAIRING_KEY);
}

/**
 * This wallet's own spending keys.
 *
 * The same accessibility class as the pairing, and `keyvault.ts` is the file
 * that argues for it: a hot seed is protected by the device rather than by
 * something a person knows, and the hole that leaves, a phone taken while
 * unlocked, is closed by the Face ID prompt on every signature rather than by
 * a stronger keychain class.
 */
export function spendingKeyStore(): Store {
  return itemStore(SPENDING_KEY);
}
