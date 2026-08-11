/**
 * The `Store` that is really a file, kept apart from the logic that uses it.
 *
 * `persist.ts` has no import from `expo-file-system` and this file has no
 * validation in it. That split is the reason `test/persist.test.ts` can drive
 * the real loading and saving code under Node, where there is no filesystem
 * module and no phone, and still be testing what the app runs.
 *
 * `expo-file-system` rather than `AsyncStorage`, and the reason is in
 * `persist.ts`: `AsyncStorage` is `NSUserDefaults`, which is one of Apple's
 * required-reason APIs, and both apps currently declare an empty
 * `NSPrivacyAccessedAPITypes`. That declaration is true today and worth the
 * small effort of keeping true.
 */

import { Directory, File, Paths } from 'expo-file-system';
import type { Store } from './persist';

/**
 * The app's own documents directory, which is backed up and survives updates.
 *
 * Not the cache directory. iOS empties that under storage pressure without
 * warning, and a wallet that silently forgot which node it uses would send its
 * owner back to the fixture data with no explanation.
 */
const FILE = 'labyrinth-wallet.json';

export function fileStore(): Store {
  const target = () => new File(Paths.document, FILE);

  return {
    async read(): Promise<string | null> {
      const file = target();
      if (!file.exists) return null;
      return file.textSync();
    },

    async write(text: string): Promise<void> {
      const directory = new Directory(Paths.document);
      if (!directory.exists) directory.create({ intermediates: true });
      const file = target();
      if (!file.exists) file.create({ overwrite: true });
      file.write(text);
    },

    async clear(): Promise<void> {
      const file = target();
      if (file.exists) file.delete();
    },
  };
}
