import { defineConfig } from 'vitest/config';

/** The Worker's own suite, kept apart from the vault's and the wallet's for
 *  the same reason theirs are kept apart from each other. */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
