/*
 * The vendored C is what the manifest says it is.
 *
 * vendor/argon2 is third-party source compiled into the app and asked to
 * produce key material. It is pinned the same way the engine bundle is: every
 * byte hashed, the hashes committed, and this test failing the moment the two
 * disagree.
 *
 * This is not a defence against somebody hostile with commit access, who could
 * run scripts/pin-vendor.mjs as easily as anyone. It is a defence against the
 * quiet edit: a patch applied to fix a build and never mentioned, an upstream
 * bump half-copied, a file that drifted. Those do not announce themselves, and
 * in a directory nobody reads they can sit for a year. A red test is the
 * announcement.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROOT = 'vendor/argon2';

interface Manifest {
  upstream: string;
  commit: string;
  license: string;
  files: Record<string, string>;
}

const manifest: Manifest = JSON.parse(readFileSync(`${ROOT}/MANIFEST.json`, 'utf8'));

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name !== 'MANIFEST.json') out.push(path);
  }
  return out;
};

describe('the vendored Argon2 reference C', () => {
  const onDisk = walk(ROOT).sort().map((p) => p.slice(ROOT.length + 1));

  it('has every file the manifest pins, and no others', () => {
    expect(onDisk).toEqual(Object.keys(manifest.files).sort());
  });

  it('matches the manifest byte for byte', () => {
    const drifted: string[] = [];
    for (const [name, expected] of Object.entries(manifest.files)) {
      const actual = createHash('sha256')
        .update(readFileSync(`${ROOT}/${name}`))
        .digest('hex');
      if (actual !== expected) drifted.push(name);
    }
    expect(
      drifted,
      'these differ from the pinned hashes. If the change was deliberate, run node scripts/pin-vendor.mjs and say why in the commit',
    ).toEqual([]);
  });

  it('records where it came from and under what licence', () => {
    expect(manifest.upstream).toBe('https://github.com/P-H-C/phc-winner-argon2');
    expect(manifest.commit, 'the upstream commit is not a full sha').toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.license).toBe('CC0-1.0 OR Apache-2.0');
    expect(readFileSync(`${ROOT}/LICENSE`, 'utf8')).toMatch(/Creative Commons CC0|Apache/);
  });

  it('did not take the x86 SIMD path, which cannot build for a phone', () => {
    /* opt.c is the SSE/AVX implementation and ref.c is the portable one. The
     * app runs on ARM, so ref.c is the one that was taken, and taking both
     * would be an ambiguity about which code derived a key. */
    expect(onDisk).toContain('src/ref.c');
    expect(onDisk).not.toContain('src/opt.c');
    expect(onDisk).not.toContain('src/blake2/blamka-round-opt.h');
  });
});
