/*
 * The vendored C is what the manifest says it is.
 *
 * Everything under vendor/ is third-party source compiled into the app and
 * asked to produce or protect key material. It is pinned the same way the
 * engine bundle is: every byte hashed, the hashes committed, and this test
 * failing the moment the two disagree.
 *
 * This is not a defence against somebody hostile with commit access, who could
 * run scripts/pin-vendor.mjs as easily as anyone. It is a defence against the
 * quiet edit: a patch applied to fix a build and never mentioned, an upstream
 * bump half-copied, a file that drifted. Those do not announce themselves, and
 * in a directory nobody reads they can sit for a year. A red test is the
 * announcement.
 *
 * There is a second job here that only vendor/cryptonight needs. That tree is
 * not purely upstream: three files in it are ours, and each is a seam where
 * code could be added that a reader would charge to Monero. So the manifest
 * names them and this test checks the naming against the disk in both
 * directions — an `ours` entry that is not there, and a file that is there and
 * is not at an upstream path, both fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

interface Manifest {
  upstream: string;
  commit: string;
  license: string;
  ours?: string[];
  buildDefines?: Record<string, string>;
  files: Record<string, string>;
}

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name !== 'MANIFEST.json') out.push(path);
  }
  return out;
};

const read = (root: string) => {
  const manifest: Manifest = JSON.parse(readFileSync(`${root}/MANIFEST.json`, 'utf8'));
  const onDisk = walk(root)
    .sort()
    .map((p) => p.slice(root.length + 1));
  return { manifest, onDisk };
};

/* The checks that mean the same thing for every vendored tree. Run over each
 * of them, so a third one added later cannot be pinned less carefully than the
 * first two by anybody who simply forgot. */
describe.each([
  ['vendor/argon2', 'https://github.com/P-H-C/phc-winner-argon2', 'CC0-1.0 OR Apache-2.0'],
  ['vendor/cryptonight', 'https://github.com/monero-project/monero', 'BSD-3-Clause'],
])('%s', (root, upstream, license) => {
  const { manifest, onDisk } = read(root);

  it('has every file the manifest pins, and no others', () => {
    expect(onDisk).toEqual(Object.keys(manifest.files).sort());
  });

  it('matches the manifest byte for byte', () => {
    const drifted: string[] = [];
    for (const [name, expected] of Object.entries(manifest.files)) {
      const actual = createHash('sha256')
        .update(readFileSync(`${root}/${name}`))
        .digest('hex');
      if (actual !== expected) drifted.push(name);
    }
    expect(
      drifted,
      'these differ from the pinned hashes. If the change was deliberate, run node scripts/pin-vendor.mjs and say why in the commit',
    ).toEqual([]);
  });

  it('records where it came from and under what licence', () => {
    expect(manifest.upstream).toBe(upstream);
    expect(manifest.commit, 'the upstream commit is not a full sha').toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.license).toBe(license);
    expect(readFileSync(`${root}/LICENSE`, 'utf8')).toMatch(
      /Creative Commons CC0|Apache|Redistribution and use/,
    );
  });
});

describe('the vendored Argon2 reference C', () => {
  const { onDisk } = read('vendor/argon2');

  it('did not take the x86 SIMD path, which cannot build for a phone', () => {
    /* opt.c is the SSE/AVX implementation and ref.c is the portable one. The
     * app runs on ARM, so ref.c is the one that was taken, and taking both
     * would be an ambiguity about which code derived a key. */
    expect(onDisk).toContain('src/ref.c');
    expect(onDisk).not.toContain('src/opt.c');
    expect(onDisk).not.toContain('src/blake2/blamka-round-opt.h');
  });
});

describe('the vendored CryptoNight', () => {
  const { manifest, onDisk } = read('vendor/cryptonight');

  it('keeps upstream paths, so the diff against a Monero checkout is a plain one', () => {
    /* The value of this is entirely in it being boring. A reviewer who wants
     * to know whether slow-hash.c was touched clones the tag in the manifest
     * and runs diff; nothing has to be explained to them first. */
    expect(onDisk).toContain('src/crypto/slow-hash.c');
    expect(onDisk).toContain('contrib/epee/src/memwipe.c');
  });

  it('names every file of ours, and nothing outside an upstream path goes unnamed', () => {
    const ours = manifest.ours ?? [];
    expect(ours.length, 'vendor/cryptonight has files that are not upstream').toBeGreaterThan(0);

    for (const name of ours) expect(onDisk, `${name} is claimed but not present`).toContain(name);

    /* The two prefixes are the ones Monero itself uses. Anything at another
     * path was put there by us and has to say so — that is the whole point of
     * having declared the split rather than leaving a reader to guess which
     * of thirty-four files upstream would recognise. */
    const unclaimed = onDisk.filter(
      (p) =>
        p !== 'LICENSE' &&
        !p.startsWith('src/crypto/') &&
        !p.startsWith('contrib/epee/') &&
        !ours.includes(p),
    );
    expect(unclaimed, 'these are not at an upstream path and are not declared in `ours`').toEqual([]);
  });

  it('did not vendor the runtime code generator', () => {
    /* CryptonightR_JIT.c writes machine code into an mmap'd page and jumps to
     * it. It is reached only at variant 4, which this build cannot ask for,
     * and iOS refuses W^X to third-party apps regardless — so the .c is out
     * and only the header it needs to compile against is in. If the .c ever
     * appears here, somebody has changed what this dependency is. */
    expect(onDisk).toContain('src/crypto/CryptonightR_JIT.h');
    expect(onDisk).not.toContain('src/crypto/CryptonightR_JIT.c');
    expect(onDisk).not.toContain('src/crypto/CryptonightR_template.S');
    expect(onDisk).not.toContain('src/crypto/rx-slow-hash.c');
  });

  it('did not vendor the elliptic curve, which stays in one language', () => {
    /* src/keys/monerotx.ts does the scalar and point arithmetic. Two
     * implementations of a KDF is a cross-check, because RFC 9106 has vectors
     * that answer to neither of ours; two implementations of key-image
     * derivation would be two chances to be wrong about the same secret. */
    expect(onDisk).not.toContain('src/crypto/crypto-ops.c');
    expect(onDisk).not.toContain('src/crypto/chacha.c');
  });

  it('says which defines select the implementation, because they change which code runs', () => {
    const defines = manifest.buildDefines ?? {};
    expect(Object.keys(defines).sort()).toEqual(['FORCE_USE_HEAP', 'NO_AES']);
  });
});
