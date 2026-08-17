import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

/** A module this package cannot load in Node, and the stand-in it loads
 *  instead. See test/harness/native/react-native.tsx for why these exist and
 *  what a test that passes against them does not prove. */
function harness(module: string, file = `${module}.tsx`): { find: string; replacement: string } {
  return { find: module, replacement: resolve(here, 'test/harness/native', file) };
}

/**
 * The tests run against the same two roots the application does: this package,
 * and the vault's source above it. Nothing is copied down into the wallet to
 * make testing easier — a test suite that runs against a copy of the wire is a
 * test suite that will keep passing after the wire changes.
 *
 * The native list below is the exception, and it is an exception of a
 * different kind: those are not this project's code and cannot run here at
 * all. `react-native`'s entry point is Flow source a Node loader will not
 * parse, and the six Expo modules are JavaScript faces over native frameworks.
 * Replacing them is what lets a screen be mounted; everything the application
 * itself owns still comes from the real file, including every line of `src/`.
 *
 * An array rather than an object: @rollup/plugin-alias matches an entry when
 * the specifier equals it or begins with it plus a slash, which is what keeps
 * `react-native` from swallowing `react-native-svg`, and the array form makes
 * the order that guarantees it explicit rather than dependent on key order.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: '@vault', replacement: resolve(here, '../src') },
      { find: '@', replacement: resolve(here, './src') },
      harness('react-native'),
      harness('react-native-reanimated'),
      harness('react-native-safe-area-context'),
      harness('react-native-svg'),
      harness('expo-status-bar'),
      harness('expo-camera'),
      harness('expo-clipboard', 'expo-clipboard.ts'),
      harness('expo-document-picker', 'expo-document-picker.ts'),
      harness('expo-file-system', 'expo-file-system.ts'),
      harness('expo-haptics', 'expo-haptics.ts'),
      harness('expo-local-authentication', 'expo-local-authentication.ts'),
      harness('expo-secure-store', 'expo-secure-store.ts'),
    ],
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
  },
});
