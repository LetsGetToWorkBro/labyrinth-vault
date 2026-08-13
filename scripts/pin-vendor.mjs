/*
 * Re-pin the vendored C after a deliberate update, and only then.
 *
 * vendor/argon2 is third-party source compiled straight into the app. It gets
 * the same treatment as the engine bundle: every byte hashed, the hashes
 * committed, and a test that fails if the two ever disagree. The point is not
 * to stop a hostile edit — anyone who can edit the source can run this script
 * — it is that an accidental one, a stray patch or a half-applied upstream
 * bump, cannot pass unnoticed through review.
 *
 *   node scripts/pin-vendor.mjs
 *
 * Then read the diff. A changed hash with no changed upstream commit is the
 * thing worth stopping on.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = 'vendor/argon2';
const manifest = JSON.parse(readFileSync(`${root}/MANIFEST.json`, 'utf8'));

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name !== 'MANIFEST.json') out.push(path);
  }
  return out;
};

const files = {};
for (const path of walk(root).sort()) {
  files[path.slice(root.length + 1)] = createHash('sha256')
    .update(readFileSync(path))
    .digest('hex');
}

manifest.files = files;
writeFileSync(`${root}/MANIFEST.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(`pinned ${Object.keys(files).length} files under ${root}`);
