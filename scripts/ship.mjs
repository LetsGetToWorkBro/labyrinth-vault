/**
 * Bump the build numbers, both apps, together.
 *
 * TestFlight orders uploads by `CFBundleVersion` and rejects a repeat. It is
 * the single most forgettable thing in a release and the failure is at the
 * worst possible moment: after the archive, after the upload, after the wait.
 *
 * Both apps move at once, deliberately. They are two halves of one product and
 * a tester describing "build 7" should not have to say which app they mean.
 * The marketing version is left alone: that is a decision about what changed,
 * and a script has no opinion about that.
 *
 *   node scripts/ship.mjs           # show where both are
 *   node scripts/ship.mjs --bump    # raise both by one
 *   node scripts/ship.mjs --version 0.2.0
 */

import { readFileSync, writeFileSync } from 'node:fs';

const PROJECT = 'ios/project.yml';
const APP_JSON = 'wallet/app.json';

const args = process.argv.slice(2);
const bump = args.includes('--bump');
const versionAt = args.indexOf('--version');
const version = versionAt >= 0 ? args[versionAt + 1] : null;

if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`--version wants three numbers, got "${version}"`);
  process.exit(1);
}

/* Edited as text rather than parsed and rewritten. project.yml is full of
 * comments that explain why each field is what it is, and a YAML round trip
 * would throw all of them away to save a regular expression. */
let project = readFileSync(PROJECT, 'utf8');
const app = JSON.parse(readFileSync(APP_JSON, 'utf8'));

const readNumber = (text, key) => {
  const found = new RegExp(`${key}: "(\\d+)"`).exec(text);
  if (!found) throw new Error(`${key} is missing from ${PROJECT}`);
  return Number(found[1]);
};

const vaultBuild = readNumber(project, 'CFBundleVersion');
const vaultVersion = /CFBundleShortVersionString: "([\d.]+)"/.exec(project)?.[1];
const walletBuild = Number(app.expo.ios.buildNumber);
const walletVersion = app.expo.version;

if (!bump && !version) {
  console.log(`vault    ${vaultVersion} (${vaultBuild})   ${PROJECT}`);
  console.log(`wallet   ${walletVersion} (${walletBuild})   ${APP_JSON}`);
  if (vaultVersion !== walletVersion || vaultBuild !== walletBuild) {
    console.log('\nthe two have drifted apart, which is worth a look before an upload');
  }
  process.exit(0);
}

/* The next build is one past whichever is higher. If they have drifted, this
 * closes the gap rather than preserving it: two apps at different build
 * numbers is a conversation nobody wants to have with a tester. */
const nextBuild = bump ? Math.max(vaultBuild, walletBuild) + 1 : Math.max(vaultBuild, walletBuild);
const nextVersion = version ?? vaultVersion;

project = project
  .replace(/CFBundleVersion: "\d+"/, `CFBundleVersion: "${nextBuild}"`)
  .replace(/CURRENT_PROJECT_VERSION: \d+/, `CURRENT_PROJECT_VERSION: ${nextBuild}`)
  .replace(/CFBundleShortVersionString: "[\d.]+"/, `CFBundleShortVersionString: "${nextVersion}"`)
  .replace(/MARKETING_VERSION: [\d.]+/, `MARKETING_VERSION: ${nextVersion}`);
writeFileSync(PROJECT, project);

app.expo.version = nextVersion;
app.expo.ios.buildNumber = String(nextBuild);
writeFileSync(APP_JSON, JSON.stringify(app, null, 2) + '\n');

console.log(`both apps now ${nextVersion} (${nextBuild})`);
console.log('remember: the archive has to be made after this, not before it');
