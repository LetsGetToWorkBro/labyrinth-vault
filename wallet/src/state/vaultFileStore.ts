/**
 * Putting a file the vault sent onto this phone's disk, so it can leave again.
 *
 * Kept apart from `core/vaultfile.ts` for the same reason `fileStore.ts` is
 * kept apart from `persist.ts`: that file decides *what* a payload is and what
 * to say about it, and has no import from `expo-file-system`, so its judgement
 * runs under Node in the test suite. This file is the three lines that touch a
 * filesystem, and there is nothing here to get wrong that a test could catch.
 *
 * ## The cache directory, not documents
 *
 * The opposite choice from `fileStore.ts`, and for the opposite reason. That
 * one keeps a wallet's own settings, which have to survive an update. This is
 * a courier's parcel: it exists to be handed to the share sheet and then to be
 * somebody else's problem. iOS emptying it under storage pressure is the
 * correct outcome for a key image export that has already been imported, and
 * leaving a file naming every output this account owns sitting in a backed-up
 * documents directory forever is not.
 */

import { File, Paths } from 'expo-file-system';

/** Where the file landed, for the share sheet. */
export interface SavedFile {
  uri: string;
  name: string;
}

/**
 * Write bytes under a name, overwriting whatever was there.
 *
 * Overwriting deliberately: two key image exports in a row are the same
 * answer, one of them stale, and `key_images (1)` in a Files app is how
 * somebody imports last week's.
 */
export function saveVaultFile(name: string, bytes: Uint8Array): SavedFile {
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  return { uri: file.uri, name };
}
