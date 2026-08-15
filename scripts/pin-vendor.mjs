/*
 * Re-pin the vendored C after a deliberate update, and only then.
 *
 * Everything under vendor/ is third-party source compiled straight into the
 * app. It gets the same treatment as the engine bundle: every byte hashed, the
 * hashes committed, and a test that fails if the two ever disagree. The point
 * is not to stop a hostile edit — anyone who can edit the source can run this
 * script — it is that an accidental one, a stray patch or a half-applied
 * upstream bump, cannot pass unnoticed through review.
 *
 *   node scripts/pin-vendor.mjs
 *
 * Then read the diff. A changed hash with no changed upstream commit is the
 * thing worth stopping on.
 *
 * Both trees also carry an `ours` list: the handful of files in them that are
 * not upstream at all. vendor/cryptonight has three, and each one is a place
 * where somebody could put code that upstream would never be blamed for, so
 * the list is short by design and test/vendor.test.ts checks it against what
 * is actually on disk rather than trusting it.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const roots = ['vendor/argon2', 'vendor/cryptonight'];

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name !== 'MANIFEST.json') out.push(path);
  }
  return out;
};

for (const root of roots) {
  const manifest = JSON.parse(readFileSync(`${root}/MANIFEST.json`, 'utf8'));

  const files = {};
  for (const path of walk(root).sort()) {
    files[path.slice(root.length + 1)] = createHash('sha256')
      .update(readFileSync(path))
      .digest('hex');
  }

  manifest.files = files;
  writeFileSync(`${root}/MANIFEST.json`, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`pinned ${Object.keys(files).length} files under ${root}`);
}
