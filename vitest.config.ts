import { defineConfig } from 'vitest/config';

/**
 * The vault's suite is `test/`, and only `test/`.
 *
 * There is a second application in this repository now (`wallet/`), with its
 * own package, its own dependencies and its own tests. Vitest's default is to
 * find every `*.test.ts` beneath the working directory, which would drag those
 * in here — where the wallet's `@vault/*` alias does not exist, and where a
 * failure would be reported against the vault.
 *
 * Keeping the boundary explicit matters more than the convenience: the tests
 * in `test/` are the ones that hold the claims on the front of the README, and
 * `npm test` at this root should mean exactly those, passing or failing on
 * their own terms. The wallet's suite runs from `wallet/`.
 */
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
    outputFile: { json: '.counts/vault.json' },
  },
});
