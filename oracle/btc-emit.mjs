/*
 * Regenerate the two Bitcoin fixtures from the wallets themselves.
 *
 *   ./oracle/btc.sh                        set up Electrum and the BBQr reference
 *   node oracle/btc-emit.mjs               write the fixtures
 *   node oracle/btc-emit.mjs --check       rebuild and diff, change nothing
 *
 * The Monero half of this rig (build.sh, emit.mjs) regenerates its fixtures
 * from Monero's C++. This is the same idea for Bitcoin, and it has one extra
 * step, because the two fixtures are not the same kind of thing:
 *
 *   - `descriptors.json` is entirely theirs. Every checksum is Electrum's
 *     `DescriptorChecksum` output.
 *   - `wallet-wires.json` is mixed. `electrumBase43` and `referenceFrames*`
 *     are theirs; `bbqrFrames` are *ours*, and what makes them trustworthy is
 *     that Coinkite's own `join_qrs` reassembles them into the original PSBT.
 *     So this does not merely copy their output, it hands them ours and
 *     records that they accepted it.
 *
 * That second case is the whole reason this file runs our TypeScript through
 * esbuild rather than reading the fixture: a check that regenerated our frames
 * from the fixture would be checking the fixture against itself.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PINNED = JSON.parse(readFileSync('oracle/PINNED.json', 'utf8'));
const WORK = 'oracle/.work';
const ELECTRUM = `${WORK}/electrum`;
const BBQR = `${WORK}/bbqr`;

if (!existsSync(`${ELECTRUM}/electrum`) || !existsSync(`${BBQR}/python`)) {
  console.error('oracle: no Bitcoin oracle. Run ./oracle/btc.sh first.');
  process.exit(1);
}

const check = process.argv.includes('--check');

/** Our own code, bundled so it can be called from here. */
async function ours() {
  const scratch = mkdtempSync(join(tmpdir(), 'oracle-'));
  const entry = join(scratch, 'entry.ts');
  writeFileSync(
    entry,
    `export { base43Encode, base43Frame } from ${JSON.stringify(join(process.cwd(), 'src/airgap/base43'))};
     export { bbqrEncode } from ${JSON.stringify(join(process.cwd(), 'src/airgap/bbqr'))};
     export { descriptorChecksum, bip84Descriptors, accountXpub } from ${JSON.stringify(join(process.cwd(), 'src/keys/descriptor'))};
     export { ZPUB_VERSIONS, openFromMnemonic } from ${JSON.stringify(join(process.cwd(), 'src/keys/bitcoin'))};`,
  );
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  return import(
    'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
  );
}

/** One shot of Python with both projects importable. */
function python(source) {
  return execFileSync('python3', ['-c', source], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: [ELECTRUM, `${BBQR}/python`].join(':') },
    maxBuffer: 64 * 1024 * 1024,
  });
}

const hex = (b) => Buffer.from(b).toString('hex');
const m = await ours();

// ---------------------------------------------------------------------------
// wallet-wires.json

/* The BBQr project's own PSBT corpus, which has the useful property of
 * containing transactions nobody here designed. Kept small enough to commit:
 * the 35 KB one verified during development and 179 frames tells the test
 * nothing that 21 does not. */
const CORPUS = ['1in2out.psbt', '1in10out.psbt', '1in20out.psbt', '1in100out.psbt'];

const wires = [];
for (const name of CORPUS) {
  const psbt = new Uint8Array(readFileSync(`${BBQR}/test_data/${name}`));
  const psbtHex = hex(psbt);
  const ourFrames = m.bbqrEncode(psbt, 'P');

  const report = JSON.parse(
    python(`
import json, sys
from electrum.bitcoin import base_encode
from bbqr import join_qrs
raw = bytes.fromhex(${JSON.stringify(psbtHex)})
ours = ${JSON.stringify(ourFrames)}
ft, joined = join_qrs(ours)
out = {
  'electrumBase43': base_encode(raw, base=43),
  'bbqrAccepted': (ft == 'P' and joined.hex() == raw.hex()),
}
import bbqr.split as S
CAP=[25,47,77,114,154,195,224,279,335,395,468,535,619,667,758,854,938,1046,1153,1249,
     1352,1460,1588,1704,1853,1990,2132,2223,2369,2520,2677,2840,3009,3183,3351,3537,3729,3927,4087,4296]
S.version_to_chars = lambda ver: CAP[ver-1]
if len(raw) < 2000:
    for enc, key in (('2','referenceFramesBase32'), ('H','referenceFramesHex')):
        _, parts = S.split_qrs(raw, 'P', encoding=enc, min_version=10, max_version=20)
        out[key] = parts
print(json.dumps(out))
`),
  );

  if (!report.bbqrAccepted) {
    console.error(`oracle: Coinkite's join_qrs did NOT accept our frames for ${name}`);
    process.exit(1);
  }

  const entry = {
    name,
    bytes: psbt.length,
    psbtHex,
    electrumBase43: report.electrumBase43,
    fitsOneQr: m.base43Frame(psbt) !== null,
    bbqrFrames: ourFrames,
  };
  if (report.referenceFramesBase32) {
    entry.referenceFramesBase32 = report.referenceFramesBase32;
    entry.referenceFramesHex = report.referenceFramesHex;
  }
  wires.push(entry);
}

const wiresFixture = {
  note:
    'Generated by the wallets themselves, not by this repository. Regenerate with ' +
    './oracle/btc.sh && node oracle/btc-emit.mjs, and check with --check. electrumBase43 is ' +
    "the output of Electrum's electrum.bitcoin.base_encode(base=43). bbqrFrames are ours, and " +
    "every one of them was handed to Coinkite BBQr's reference join_qrs and came back as the " +
    'original PSBT before this file was written. referenceFrames* are the BBQr reference ' +
    "split_qrs output, for our decoder to read. PSBTs are the BBQr project's test corpus.",
  electrum: { repo: PINNED.bitcoin.electrum.repo, commit: PINNED.bitcoin.electrum.commit },
  bbqr: { repo: PINNED.bitcoin.bbqr.repo, spec: PINNED.bitcoin.bbqr.spec },
  vectors: wires,
};

// ---------------------------------------------------------------------------
// descriptors.json

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const wallet = m.openFromMnemonic(MNEMONIC);
const made = m.bip84Descriptors(wallet.zpub, m.ZPUB_VERSIONS, wallet.masterFingerprint);
const bodies = [
  'raw(deadbeef)',
  made.receive.split('#')[0],
  made.change.split('#')[0],
  made.combined.split('#')[0],
  'pkh([deadbeef/1/2h/3/4h]0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798)',
];

const descriptorReport = JSON.parse(
  python(`
import json
from electrum.descriptor import DescriptorChecksum, parse_descriptor
bodies = ${JSON.stringify(bodies)}
finished = ${JSON.stringify([made.receive, made.change, made.combined])}
for d in finished:
    parse_descriptor(d)          # raises if Electrum will not read it
print(json.dumps([{'body': b, 'checksum': DescriptorChecksum(b)} for b in bodies]))
`),
);

const descriptorFixture = {
  note:
    "Checksums generated by Electrum's own electrum.descriptor.DescriptorChecksum, not by this " +
    'repository, and every finished descriptor below was fed back to Electrum parse_descriptor ' +
    'when this was written. Regenerate with ./oracle/btc.sh && node oracle/btc-emit.mjs. ' +
    "`raw(deadbeef)#89f8spxm` is BIP-380's published example and is here as an anchor neither " +
    "Electrum nor we chose. The seed is BIP-39's own test vector, so the zpub is BIP-84's " +
    'published account key and the fingerprint 73c5da0a is the one every wallet reports for it.',
  source: { electrum: PINNED.bitcoin.electrum.commit, bip: 'BIP-380' },
  mnemonic: MNEMONIC,
  zpub: wallet.zpub,
  xpub: m.accountXpub(wallet.zpub, m.ZPUB_VERSIONS),
  masterFingerprint: wallet.masterFingerprint,
  descriptors: made,
  checksums: descriptorReport,
};

// ---------------------------------------------------------------------------

let failed = false;
for (const [path, value] of [
  ['test/fixtures/wallet-wires.json', wiresFixture],
  ['test/fixtures/descriptors.json', descriptorFixture],
]) {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (!check) {
    writeFileSync(path, text);
    console.log(`oracle: wrote ${path}`);
    continue;
  }
  if (readFileSync(path, 'utf8') === text) {
    console.log(`oracle: ${path} reproduces exactly`);
  } else {
    console.error(`oracle: ${path} does NOT reproduce. Do not re-pin without knowing why.`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
