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
  },
});
