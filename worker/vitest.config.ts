import { defineConfig } from 'vitest/config';

/** The Worker's own suite, kept apart from the vault's and the wallet's for
 *  the same reason theirs are kept apart from each other. */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    /**
     * A JSON report beside the default one, so the count is a fact rather than
     * something read off a terminal.
     *
     * `scripts/test-counts.mjs` reads it and compares against the number
     * CLAUDE.md documents for this suite. Written from the config rather than
     * a CI flag so that a person running the suite the ordinary way produces
     * it too: a check that only exists in CI is a check that tells you about a
     * mistake after you pushed it. The directory is ignored by git.
     */
    reporters: ['default', 'json'],
    outputFile: { json: '.counts/worker.json' },
  },
});
