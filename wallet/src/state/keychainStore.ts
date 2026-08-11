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

const KEY = 'labyrinth-pairing';

export function keychainStore(): Store {
  const options = { keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return {
    async read(): Promise<string | null> {
      return getItemAsync(KEY, options);
    },
    async write(text: string): Promise<void> {
      await setItemAsync(KEY, text, options);
    },
    async clear(): Promise<void> {
      await deleteItemAsync(KEY, options);
    },
  };
}
