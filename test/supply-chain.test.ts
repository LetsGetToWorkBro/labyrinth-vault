/**
 * The dependency list is part of the attack surface, so it is part of the
 * tests.
 *
 * Wallet code gets attacked through its dependencies more often than through
 * its cryptography, because that is the cheap way in: compromise one npm
 * account, publish a patch release, and every project that trusted a version
 * *range* installs the payload on its next fresh install. This project closes
 * that door twice over:
 *
 *   - every dependency is pinned to an exact version, so `npm install` can
 *     only ever produce the bytes that were reviewed. Upgrades happen as
 *     visible diffs to package.json, never as a side effect of installing;
 *   - the runtime dependencies are only the audited noble/scure cryptography
 *     family. Not "mostly" — only. A new scope appearing in the list is a
 *     decision someone should have to defend in review, so it fails here.
 *
 * The lockfile check is the third leg: every runtime package must carry an
 * integrity hash, so a tampered registry response fails installation instead
 * of becoming the build.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
  packages: Record<string, { integrity?: string; version?: string }>;
};

describe('what this project is allowed to depend on', () => {
  it('pins every dependency to one exact version, no ranges', () => {
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(version, `${name} is "${version}", which is a range, not a version`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('keeps the runtime list to the audited cryptography family, and nothing else', () => {
    const names = Object.keys(pkg.dependencies ?? {});
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name, `${name} is not a @noble or @scure package`).toMatch(/^@(noble|scure)\//);
    }
  });

  it('has an integrity hash in the lockfile for every runtime package', () => {
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const entry = lock.packages[`node_modules/${name}`];
      expect(entry, `${name} missing from the lockfile`).toBeDefined();
      expect(entry!.integrity, `${name} has no integrity hash`).toMatch(/^sha512-/);
      expect(entry!.version).toBe(pkg.dependencies![name]);
    }
  });

  it('keeps the whole transitive runtime closure inside the same family', () => {
    /* The packages depend on each other (@scure/bip32 uses @noble/curves, the
     * signer uses micro-packed for serialisation) and all of it is the same
     * author's audited family. What must never happen silently is the closure
     * growing a stranger: one `npm install left-pad` deep in a dependency and
     * the review surface is no longer what everybody thinks it is. So the
     * closure is walked here, from the named dependencies outward, and every
     * package it reaches has to be on the list and integrity-hashed. */
    const allowed = /^(@noble\/|@scure\/|micro-packed$)/;
    const queue = Object.keys(pkg.dependencies ?? {});
    const seen = new Set<string>();
    while (queue.length > 0) {
      const name = queue.pop()!;
      if (seen.has(name)) continue;
      seen.add(name);
      expect(name, `${name} reached from the runtime closure`).toMatch(allowed);
      const entry = lock.packages[`node_modules/${name}`] as
        | { integrity?: string; dependencies?: Record<string, string> }
        | undefined;
      expect(entry, `${name} missing from the lockfile`).toBeDefined();
      expect(entry!.integrity, `${name} has no integrity hash`).toMatch(/^sha512-/);
      queue.push(...Object.keys(entry!.dependencies ?? {}));
    }
    // The walk found the closure, not just the roots.
    expect(seen.size).toBeGreaterThan(Object.keys(pkg.dependencies ?? {}).length);
  });
});
