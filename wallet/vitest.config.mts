import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * The tests run against the same two roots the application does: this package,
 * and the vault's source above it. Nothing is copied down into the wallet to
 * make testing easier — a test suite that runs against a copy of the wire is a
 * test suite that will keep passing after the wire changes.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@vault': resolve(here, '../src'),
      '@': resolve(here, './src'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
