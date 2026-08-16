/*
 * Regenerate the fixtures that came out of Monero's own crypto.
 *
 *   ./oracle/build.sh && node oracle/emit.mjs           write them
 *   node oracle/emit.mjs --check                        compare, change nothing
 *
 * `--check` is the one that matters. It rebuilds every fixture from the
 * harness and diffs against what is committed, so the claim "these numbers
 * came from Monero" stops being a sentence in a comment and becomes something
 * a reviewer can run. It is deliberately not part of `npm test`: that would
 * make the suite depend on a Monero checkout and a C++ toolchain, and a suite
 * with a heavy optional step is a suite people learn to skip.
 *
 * ## Why the inputs are what they are
 *
 * The keys are counted-up bytes rather than anything random. Two reasons, and
 * the second is the real one:
 *
 *   - a fixture regenerated from a fresh random key would differ every run,
 *     which makes `--check` impossible;
 *   - the RNG inside Monero is stubbed to a byte counter (oracle/src/rng-counter.c)
 *     so that `generate_signature` and `generate_ring_signature` are
 *     reproducible at all. Signatures draw a nonce; two correct
 *     implementations of the same signature scheme disagree byte for byte
 *     unless they are handed the same one. The counter is what lets the
 *     TypeScript be compared to the C rather than merely believed alongside it.
 *
 * None of these keys is secret and none should ever be used for anything. They
 * are test vectors.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PINNED = JSON.parse(readFileSync('oracle/PINNED.json', 'utf8'));
const KEYIMAGE = 'oracle/.work/keyimage';
const CRYPTONIGHT = 'oracle/.work/cryptonight';

if (!existsSync(KEYIMAGE)) {
  console.error('oracle: no harness. Run ./oracle/build.sh first.');
  process.exit(1);
}

const check = process.argv.includes('--check');

/* The counter the RNG stub produces, so the nonces the C consumed can be
 * handed to the TypeScript. Draw order inside the harness is: one 32-byte
 * scalar per ring signature, then the 8-byte ChaCha IV, then one 32-byte
 * scalar for the outer signature. Getting that order wrong shows up
 * immediately as a signature mismatch, which is why it is not commented as an
 * assumption but exercised by the fixture itself. */
const counter = (start, n) =>
  Buffer.from(Array.from({ length: n }, (_, i) => (start + i) & 0xff)).toString('hex');

const VIEW_SECRET = '0e0d0c0b0a090807060504030201000f0e0d0c0b0a0908070605040302010001';
const SPEND_SECRET = '1a1b1c1d1e1f202122232425262728292a2b2c2d2e2f30313233343536373801';
const EPHEMERAL = [
  '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f00',
  'a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf00',
];

/** One run of the harness, parsed into the fields it prints. */
function run(offset, ephemerals) {
  const out = execFileSync(KEYIMAGE, [VIEW_SECRET, SPEND_SECRET, String(offset), ...ephemerals], {
    encoding: 'utf8',
  });
  const fields = {};
  const lists = { out_pub: [], key_image: [], ring_sig: [], ring_ok: [] };
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [key, value] = [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)];
    if (key in lists) lists[key].push(value);
    else fields[key] = value;
  }
  return { ...fields, ...lists };
}

const cases = [
  { name: 'empty', offset: 0, ephemerals: [] },
  { name: 'two', offset: 7, ephemerals: EPHEMERAL },
].map(({ name, offset, ephemerals }) => {
  const r = run(offset, ephemerals);
  const images = ephemerals.length;
  const nonces = Array.from({ length: images }, (_, i) => counter(32 * i, 32));
  nonces.push(counter(32 * images + 8, 32)); // after the IV
  return {
    name,
    offset,
    viewPublic: r.view_pub,
    spendPublic: r.spend_pub,
    chachaKey: r.chacha_key,
    outPubs: r.out_pub,
    keyImages: r.key_image,
    ringSigs: r.ring_sig,
    nonces,
    iv: r.iv,
    plaintext: r.plaintext,
    file: r.file,
    /* Monero's own verifiers, run over Monero's own output.
     *
     * Reproducing a signature byte for byte proves two signers agree. It does
     * not prove the *verifier* accepts them, and the verifier is what decides
     * whether `wallet2::import_key_images` succeeds or throws "signature check
     * failed". These two flags are `crypto::check_ring_signature` on every
     * record and `crypto::check_signature` on the envelope, so the claim that
     * another wallet will accept this file rests on running wallet2's gate
     * rather than on reading wallet2.cpp.
     *
     * They are in the fixture rather than only in the harness output because
     * `npm test` cannot build C++; the committed answer is what the TypeScript
     * suite reads, and `--check` is what proves the answer is still that. */
    verified: {
      ringSignatures: r.ring_ok.map((value) => value === '1'),
      envelope: r.outer_ok === '1',
    },
  };
});

const fixture = {
  note:
    "Generated by Monero's own crypto, not by this repository. Regenerate with " +
    './oracle/build.sh && node oracle/emit.mjs, and check with --check. ' +
    'oracle/src/keyimage.cpp links crypto.cpp, crypto-ops.c and chacha.c from the tag ' +
    'below, with generate_random_bytes_thread_safe stubbed to a byte counter so the ' +
    'signatures are reproducible. The nonces are what that counter produced, and are ' +
    'fed to the TypeScript so the two can be compared byte for byte.',
  source: { repo: PINNED.upstream, tag: PINNED.tag },
  viewSecret: VIEW_SECRET,
  spendSecret: SPEND_SECRET,
  ephemeralSecrets: EPHEMERAL,
  cases,
};

// ---------------------------------------------------------------------------
// The unsigned transaction set
//
// This harness prints two things: the bytes Monero's own binary archive
// produced, and a JSON description of what went in. The TypeScript has to turn
// the first into the second, which is a stronger check than a round trip: a
// round trip only proves a reader and a writer agree with each other.

const UNSIGNED = 'oracle/.work/unsignedtxset';
let unsignedFixture = null;
if (existsSync(UNSIGNED)) {
  const printed = execFileSync(UNSIGNED, [], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  unsignedFixture = {
    note:
      "Generated by Monero's own binary archive, not by this repository. " +
      'oracle/src/unsignedtxset.cpp includes wallet/wallet2.h and serializes the real ' +
      'wallet2::unsigned_tx_set, so none of the layout is transcribed. `archive` is what ' +
      'binary_archive<true> wrote; `meaning` is what was put in. Regenerate with ' +
      './oracle/build.sh && node oracle/emit.mjs, and check with --check.',
    source: { repo: PINNED.upstream, tag: PINNED.tag },
    archive: /^archive (.+)$/m.exec(printed)[1],
    /* The whole file as `dump_tx_to_str` writes it: the prefix, then the
     * archive inside `encrypt_with_view_secret_key`. Same envelope as the
     * key-image export. */
    viewSecret: /^viewSecret (.+)$/m.exec(printed)[1],
    chachaKey: /^chachaKey (.+)$/m.exec(printed)[1],
    file: /^file (.+)$/m.exec(printed)[1],
    meaning: JSON.parse(/^meaning (.+)$/m.exec(printed)[1]),
  };
} else {
  console.error('oracle: no unsignedtxset harness; run ./oracle/build.sh');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The import, run by Monero's own wallet
//
// Everything above compares bytes: our writer against Monero's writer, our
// reader against Monero's archive. This section is the other kind of check.
// It builds a key-image export *with this repository's own code* and hands it
// to the real `tools::wallet2::import_key_images`, which is the function every
// wallet on the receiving end actually calls.
//
// That closes the one claim the byte comparison cannot reach.
// `import_key_images` pairs each record with `m_transfers[n + offset]` -- by
// position, with nothing in the file naming an output -- so a file whose
// records are in the wrong order, or whose offset is wrong by one, is still
// well formed and still fully signed and still wrong. Until this ran, the
// evidence for that was that I had read wallet2.cpp.
//
// Note which direction this goes: the TypeScript writes and the C++ judges.
// The other harnesses have the C++ write and the TypeScript match. Both are
// worth having, and this is the one that matches what a person does with the
// file.

const IMPORT = 'oracle/.work/importkeyimages';
let importFixture = null;
if (existsSync(IMPORT)) {
  importFixture = await emitImport();
} else {
  console.error('oracle: no importkeyimages harness; run ./oracle/build.sh');
  process.exit(1);
}

/**
 * This repository's own TypeScript, bundled and evaluated.
 *
 * `contents` is a module that re-exports whatever the caller needs, and it has
 * to be *one* module: each esbuild call produces an independent copy of every
 * module underneath it, so installing CryptoNight into one copy of
 * moneroexport.ts and then calling a writer that closed over a different copy
 * would install nothing, silently. scripts/emit-swift-fixtures.mjs learned
 * that the same way.
 */
async function loadVault(contents) {
  const compiled = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'neutral',
  });
  return import(
    'data:text/javascript;base64,' +
      Buffer.from(compiled.outputFiles[0].text).toString('base64')
  );
}

async function emitImport() {
  const vault = await loadVault(`
    export { walletFromSeed, toHex, fromHex } from './src/keys/monero';
    export { computeKeyImages, keyImageFileFor, keyImageFileRandomBytes,
             KEYIMAGE_VERSION } from './src/keys/keyimages';
    export { setNativeCnSlowHash } from './src/keys/moneroexport';
  `);

  /* CryptoNight from the oracle's own harness, which build.sh has already held
   * to Monero's four official vectors. The vault normally gets this from
   * vendor/cryptonight on the phone; both are the same upstream C at the same
   * pin, and the point here is that wallet2 has to be able to decrypt what
   * comes out, which it cannot if the KDF is a stub. */
  vault.setNativeCnSlowHash((data) =>
    vault.fromHex(execFileSync(CRYPTONIGHT, [vault.toHex(data)], { encoding: 'utf8' }).trim()),
  );

  const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const STRANGER_SEED = new Uint8Array(32).fill(9);
  const wallet = vault.walletFromSeed(SEED);
  const stranger = vault.walletFromSeed(STRANGER_SEED);
  const viewSecret = vault.toHex(wallet.viewSecret);
  const spendSecret = vault.toHex(wallet.spendSecret);

  /* Seven outputs of padding in front of two real ones, so the offset in the
   * file is not zero. Zero is the case where getting the offset wrong is
   * invisible, which makes it the wrong case to test with. */
  const COUNT = 2;
  const PAD = 7;

  const described = harness(['describe', viewSecret, spendSecret, String(COUNT), String(PAD)]);
  const outputs = [...described.text.matchAll(/^output (\w+) (\d+) (\w+)$/gm)].map((m) => ({
    tx: m[1],
    index: Number(m[2]),
    key: m[3],
  }));
  if (outputs.length !== COUNT) {
    console.error('oracle: the import harness described the wrong number of outputs');
    process.exit(1);
  }

  const images = vault.computeKeyImages(wallet, {
    v: vault.KEYIMAGE_VERSION,
    chain: 'xmr',
    outputs,
  });
  if (images.refused.length) {
    /* The vault re-derives every output from its own keys before it will touch
     * one. If it refuses these, the two sides disagree about the derivation
     * itself, which is a much bigger finding than anything below. */
    console.error("oracle: the vault refused outputs Monero's own crypto derived for its account");
    process.exit(1);
  }

  /* A fixed path rather than a temporary one, and a relative path rather than
   * an absolute one, because wallet2 puts the filename it was given into its
   * error messages. Those messages go in the fixture, so a per-run temporary
   * directory would make the fixture stop reproducing for a reason that has
   * nothing to do with Monero. Everything under .work is git-ignored. */
  const scratch = 'oracle/.work/import';
  mkdirSync(scratch, { recursive: true });

  /** A file this repository wrote, for these outputs in this order, at this offset. */
  function fileFor(order, offset) {
    const chosen = order.map((i) => outputs[i]);
    const random = Uint8Array.from(
      { length: vault.keyImageFileRandomBytes(chosen.length) },
      (_, i) => (i * 3 + 5) & 0xff,
    );
    const made = vault.keyImageFileFor(
      wallet,
      { v: vault.KEYIMAGE_VERSION, chain: 'xmr', outputs: chosen, offset },
      random,
    );
    if (!made.ok) {
      console.error(`oracle: the vault would not write the file: ${made.problem}`);
      process.exit(1);
    }
    return { random: vault.toHex(random), bytes: made.file };
  }

  function harness(args) {
    const text = execFileSync(IMPORT, args, { encoding: 'utf8' });
    const one = (key) => (new RegExp(`^${key} (.+)$`, 'm').exec(text) ?? [])[1] ?? null;
    return {
      text,
      outcome: one('outcome'),
      detail: one('detail'),
      imported: one('imported'),
      transferKeyImages: [...text.matchAll(/^transfer_ki (\w+)$/gm)].map((m) => m[1]),
    };
  }

  const CASES = [
    {
      name: 'accepted',
      what: 'the file as the vault writes it, aimed at the transfers it names',
      order: [0, 1],
      offset: PAD,
      account: 'wallet',
      expect: 'no_connection_to_daemon',
    },
    {
      name: 'records-reversed',
      what: 'the same two records, swapped. Every signature in it is still valid',
      order: [1, 0],
      offset: PAD,
      account: 'wallet',
      expect: 'signature_check_failed',
    },
    {
      name: 'offset-one-short',
      what: 'the right records, claiming to start one transfer earlier than they do',
      order: [0, 1],
      offset: PAD - 1,
      account: 'wallet',
      expect: 'signature_check_failed',
    },
    {
      name: 'offset-one-long',
      what: 'the right records, claiming to start one transfer later than they do',
      order: [0, 1],
      offset: PAD + 1,
      account: 'wallet',
      expect: 'wallet_internal_error',
    },
    {
      name: 'another-account',
      what: "the same file, offered to somebody else's wallet",
      order: [0, 1],
      offset: PAD,
      account: 'stranger',
      expect: 'wallet_internal_error',
    },
    {
      name: 'same-view-key-other-spend-key',
      what: 'a wallet that can open the envelope but is not this account',
      order: [0, 1],
      offset: PAD,
      account: 'half-stranger',
      expect: 'wallet_internal_error',
    },
  ];

  const cases = CASES.map((each) => {
    const { random, bytes } = fileFor(each.order, each.offset);
    const path = join(scratch, `${each.name}.bin`);
    writeFileSync(path, bytes);
    const keys = {
      wallet: [viewSecret, spendSecret],
      stranger: [vault.toHex(stranger.viewSecret), vault.toHex(stranger.spendSecret)],
      'half-stranger': [viewSecret, vault.toHex(stranger.spendSecret)],
    }[each.account];
    const run = harness(['import', ...keys, String(COUNT), String(PAD), path]);
    if (run.outcome !== each.expect) {
      console.error(
        `oracle: case ${each.name} expected ${each.expect} and wallet2 said ${run.outcome}: ${run.detail}`,
      );
      process.exit(1);
    }
    return {
      name: each.name,
      what: each.what,
      order: each.order,
      offset: each.offset,
      account: each.account,
      randomness: random,
      file: vault.toHex(bytes),
      outcome: run.outcome,
      detail: run.detail,
      imported: run.imported === null ? null : Number(run.imported),
      transferKeyImages: run.transferKeyImages,
    };
  });

  return {
    note:
      "Verdicts from Monero's own tools::wallet2::import_key_images, on files this " +
      'repository wrote. oracle/src/importkeyimages.cpp links wallet2.cpp from the tag ' +
      'below and hands each file to a watch-only wallet holding the outputs named here. ' +
      '`outcome` is what wallet2 did with it. no_connection_to_daemon is the accepting ' +
      'outcome: every offline gate passed and the call went on to ask a daemon which ' +
      'images were already spent, and there is no daemon. Regenerate with ' +
      './oracle/build.sh && node oracle/emit.mjs, and check with --check.',
    source: { repo: PINNED.upstream, tag: PINNED.tag },
    wallet: {
      seed: vault.toHex(SEED),
      strangerSeed: vault.toHex(STRANGER_SEED),
      viewSecret,
      spendSecret,
      viewPublic: wallet.viewPublic,
      spendPublic: wallet.spendPublic,
      address: (/^address (.+)$/m.exec(described.text) ?? [])[1],
      /* The one CryptoNight answer the writer needs, so the TypeScript suite
       * can rebuild these exact files without a C compiler. */
      chachaKey: execFileSync(CRYPTONIGHT, [viewSecret], { encoding: 'utf8' }).trim(),
    },
    pad: PAD,
    outputs,
    keyImages: images.images.map((entry) => entry.image),
    cases,
  };
}

// ---------------------------------------------------------------------------
// CLSAG, and a whole transaction, judged by Monero
//
// The Monero project ships no fixed CLSAG vector: its own tests generate
// random keys, sign, and verify. So for as long as this repository would not
// compile `ringct/rctSigs.cpp`, `clsagSign` and `clsagVerify` were each
// other's only witness -- and a prover and a verifier that share a mistake
// agree perfectly. Two shared mistakes in the aggregation hash survived every
// round trip and every tamper test in the suite until this ran.
//
// Both fixtures are recorded here rather than only in the harness output
// because `npm test` cannot build C++, and the committed answer is what the
// TypeScript suite reads.

const CLSAG = 'oracle/.work/clsag';
const VERIFYTX = 'oracle/.work/verifytx';
for (const [path, what] of [[CLSAG, 'clsag'], [VERIFYTX, 'verifytx']]) {
  if (!existsSync(path)) {
    console.error(`oracle: no ${what} harness; run ./oracle/build.sh`);
    process.exit(1);
  }
}
const { clsagFixture, verifyFixture } = await emitSigning();

async function emitSigning() {
  const vault = await loadVault(`
    export { clsagSign, clsagVerify } from './src/keys/monerosign';
    export { commit } from './src/keys/monerocrypto';
    export { signMoneroSpend, signingRandomCount } from './src/keys/monerobuild';
    export { commitmentMask, derivationToScalar, derivePublicKey,
             generateKeyDerivation } from './src/keys/monerocrypto';
    export { fromHex, publicFromSecret, reduceScalar, toHex,
             walletFromSeed } from './src/keys/monero';
  `);
  const { toHex, fromHex } = vault;

  /* Counted-up bytes with the top nibble cleared, so every scalar is already
   * below the group order and no reduction has to be described twice. */
  const scalar = (seed) => {
    const b = new Uint8Array(32);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < 32; i++) {
      x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; b[i] = x & 0xff;
    }
    b[31] &= 0x0f;
    return b;
  };
  const nonce = (start) =>
    Uint8Array.from({ length: 32 }, (_, i) => (start + i) & 0xff);

  const run = (harness, args) => execFileSync(harness, args, { encoding: 'utf8' });
  const one = (text, key) => (new RegExp(`^${key} (.+)$`, 'm').exec(text) ?? [])[1] ?? null;
  const all = (text, key) =>
    [...text.matchAll(new RegExp(`^${key} (.+)$`, 'gm'))].map((m) => m[1]);

  // -- one CLSAG, both directions -------------------------------------------

  const RING = 4;
  const INDEX = 2;
  const AMOUNT = 12_345_678n;
  const secret = scalar(0x1111);
  const inMask = scalar(0x2222);
  const outMask = scalar(0x3333);

  const ring = [];
  for (let i = 0; i < RING; i++) {
    if (i === INDEX) {
      ring.push({ key: toHex(vault.publicFromSecret(secret)), commitment: toHex(vault.commit(AMOUNT, inMask)) });
    } else {
      /* A decoy is any pair of valid points as far as a ring signature is
       * concerned; whether they are on a chain is a question for a node. */
      ring.push({
        key: toHex(vault.publicFromSecret(scalar(0x4000 + i * 2))),
        commitment: toHex(vault.publicFromSecret(scalar(0x4001 + i * 2))),
      });
    }
  }
  const pseudoOut = vault.commit(AMOUNT, outMask);
  const message = scalar(0x7777);
  /* z = inMask - outMask, the commitment-to-zero secret. `proveRctCLSAGSimple`
   * derives it from the two masks itself, which is why the harness is handed
   * the masks and this side is handed z. */
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const little = (bytes) => {
    let n = 0n;
    for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
    return n;
  };
  const bytesOf = (n) => Uint8Array.from({ length: 32 }, () => { const b = Number(n & 0xffn); n >>= 8n; return b; });
  const z = bytesOf((((little(inMask) - little(outMask)) % L) + L) % L);

  const inputs = [
    `message ${toHex(message)}`,
    `secret ${toHex(secret)}`,
    `mask ${toHex(inMask)}`,
    `out ${toHex(outMask)}`,
    `offset ${toHex(pseudoOut)}`,
    `index ${INDEX}`,
    ...ring.map((m) => `ring ${m.key} ${m.commitment}`),
  ];
  const scratch = 'oracle/.work/signing';
  mkdirSync(scratch, { recursive: true });
  const inputPath = join(scratch, 'clsag.txt');
  writeFileSync(inputPath, inputs.join('\n') + '\n');

  const signed = run(CLSAG, ['sign', inputPath]);
  const monero = {
    c1: one(signed, 'c1'),
    s: all(signed, 's'),
    keyImage: one(signed, 'I'),
    dInv8: one(signed, 'D'),
  };
  if (one(signed, 'self_ok') !== '1') {
    console.error("oracle: Monero would not verify its own CLSAG. The harness is wrong, not the code.");
    process.exit(1);
  }

  /* The same nonces the counter handed the C: alpha first, then one fake
   * response per ring member after the real one, wrapping. Getting that order
   * wrong shows up as a different c1, which is why it is exercised rather
   * than asserted in a comment. */
  const nonces = Array.from({ length: RING + 1 }, (_, i) => nonce(32 * i));
  const ours = vault.clsagSign(message, ring, { p: secret, z, index: INDEX }, pseudoOut, nonces);

  writeFileSync(
    join(scratch, 'clsag-ours.txt'),
    [
      ...inputs,
      `sig_c1 ${ours.c1}`,
      ...ours.s.map((s) => `sig_s ${s}`),
      `sig_I ${ours.keyImage}`,
      `sig_D ${ours.dInv8}`,
    ].join('\n') + '\n',
  );
  const verdict = one(run(CLSAG, ['verify', join(scratch, 'clsag-ours.txt')]), 'verified');

  // -- a whole transaction, through the deserializer and both verifiers ------

  const sender = vault.walletFromSeed(scalar(0xa11ce), 'stagenet');
  const receiver = vault.walletFromSeed(scalar(0xb0b), 'stagenet');

  /** An output the sender owns, made the way a payer makes one. */
  const fund = (amount, indexInTx, seed) => {
    const txSecret = scalar(seed);
    const derivation = vault.generateKeyDerivation(fromHex(sender.viewPublic), txSecret);
    const mask = vault.commitmentMask(vault.derivationToScalar(derivation, indexInTx));
    return {
      txPublicKey: toHex(vault.publicFromSecret(txSecret)),
      key: toHex(vault.derivePublicKey(derivation, indexInTx, fromHex(sender.spendPublic))),
      commitment: toHex(vault.commit(amount, mask)),
      indexInTx,
      amount,
    };
  };

  const PAYMENT = 750_000_000_000n;
  const CHANGE = 249_280_000_000n;
  const FEE = 720_000_000n;
  const REAL = 4;
  const funded = fund(PAYMENT + CHANGE + FEE, 1, 0xfeed);
  const txRing = [];
  for (let i = 0; i < 16; i++) {
    const globalIndex = 1_000_000 + i * 7;
    if (i === REAL) txRing.push({ globalIndex, key: funded.key, commitment: funded.commitment });
    else txRing.push({
      globalIndex,
      key: toHex(vault.publicFromSecret(scalar(0x9000 + i * 2))),
      commitment: toHex(vault.publicFromSecret(scalar(0x9001 + i * 2))),
    });
  }
  const set = {
    v: 1,
    chain: 'xmr',
    network: 'stagenet',
    inputs: [{
      txPublicKey: funded.txPublicKey,
      indexInTx: funded.indexInTx,
      globalIndex: 1_000_000 + REAL * 7,
      amount: funded.amount.toString(),
      ring: txRing,
      realPosition: REAL,
    }],
    outputs: [
      { address: receiver.address, amount: PAYMENT.toString(), change: false, dummy: false },
      { address: sender.address, amount: CHANGE.toString(), change: true, dummy: false },
    ],
    fee: FEE.toString(),
    ringSize: 16,
  };
  const need = vault.signingRandomCount(set.inputs.length, set.ringSize, set.outputs.length);
  const txRandom = Array.from({ length: need }, (_, i) => scalar(0x5151 + i));
  const built = vault.signMoneroSpend(sender, set, txRandom);
  if (!built.ok) {
    console.error(`oracle: the vault would not sign the transaction: ${built.problem}`);
    process.exit(1);
  }

  /** The stand-in chain: what sits at each global output index. */
  const chainRows = (members) => members.map((m) => `out ${m.globalIndex} ${m.key} ${m.commitment}`);

  const verifyCase = (name, what, rows, txHex) => {
    const path = join(scratch, `${name}.txt`);
    writeFileSync(path, [`tx ${txHex}`, ...rows].join('\n') + '\n');
    const printed = run(VERIFYTX, [path]);
    return {
      name,
      what,
      parsed: one(printed, 'parsed') === '1',
      txid: one(printed, 'txid'),
      prefixHash: one(printed, 'prefix_hash'),
      preClsagHash: one(printed, 'pre_mlsag_hash'),
      rctType: printed.includes('rct_type') ? Number(one(printed, 'rct_type')) : null,
      weight: printed.includes('weight') ? Number(one(printed, 'weight')) : null,
      keyImages: all(printed, 'key_image'),
      semanticsOk: one(printed, 'semantics_ok') === '1',
      nonSemanticsOk: one(printed, 'non_semantics_ok') === '1',
    };
  };

  /* One decoy replaced, so the chain and the signer disagree about a ring
   * member the transaction points at. Every signature in the file is still
   * valid; it is simply valid against a ring nobody has. This is the case
   * that shows the verifier is checking against the chain rather than being
   * handed back the signer's own assumptions. */
  const wrongRing = txRing.map((m, i) =>
    i === (REAL === 0 ? 1 : 0) ? { ...m, key: toHex(vault.publicFromSecret(scalar(0xdead))) } : m);

  /* One byte of the last CLSAG response flipped. It is 32 bytes inside the
   * prunable section, so the transaction still deserializes and still has the
   * same shape; only the signature is wrong. */
  const tampered = (() => {
    const bytes = fromHex(built.tx.hex);
    const at = bytes.length - 32 - 32 - 32 - 1; // inside the last s scalar
    bytes[at] ^= 1;
    return toHex(bytes);
  })();

  const cases = [
    verifyCase('accepted', 'the transaction as the vault built it, against the chain it named',
      chainRows(txRing), built.tx.hex),
    verifyCase('wrong-ring-member', 'the same transaction, where the chain holds a different decoy',
      chainRows(wrongRing), built.tx.hex),
    verifyCase('flipped-signature-byte', 'one bit of one CLSAG response inverted',
      chainRows(txRing), tampered),
  ];
  const accepted = cases[0];
  if (!accepted.parsed || !accepted.semanticsOk || !accepted.nonSemanticsOk) {
    console.error(
      'oracle: Monero refused a transaction this repository built. That is the finding, not a ' +
      'harness failure. Run oracle/.work/verifytx with VERIFYTX_LOG=1 for its reason.',
    );
    process.exit(1);
  }
  for (const each of cases.slice(1)) {
    if (each.nonSemanticsOk) {
      console.error(`oracle: case ${each.name} was supposed to be refused and was not`);
      process.exit(1);
    }
  }

  return {
    clsagFixture: {
      note:
        "A CLSAG from Monero's own prover, which the Monero project does not ship. " +
        'oracle/src/clsag.cpp calls rct::proveRctCLSAGSimple with the RNG stubbed to a byte ' +
        'counter, so the signature is reproducible and the same counter bytes can be handed to ' +
        'src/keys/monerosign.ts as its nonces. `verified` is rct::verRctCLSAGSimple on the ' +
        "signature *this repository* made, which is the direction that matters: a prover and a " +
        'verifier that share a mistake agree perfectly. Regenerate with ./oracle/build.sh && ' +
        'node oracle/emit.mjs, and check with --check.',
      source: { repo: PINNED.upstream, tag: PINNED.tag },
      ringSize: RING,
      realIndex: INDEX,
      amount: AMOUNT.toString(),
      secret: toHex(secret),
      inputMask: toHex(inMask),
      outputMask: toHex(outMask),
      z: toHex(z),
      message: toHex(message),
      pseudoOut: toHex(pseudoOut),
      ring,
      nonces: nonces.map(toHex),
      monero,
      /* Monero's verdict on ours. Both are recorded because the pair is the
       * evidence: the vector says our prover agrees with theirs, and this says
       * their verifier agrees with our prover. */
      oursVerified: verdict === '1',
      ours,
    },
    verifyFixture: {
      note:
        "Verdicts from Monero's own consensus verifiers on a transaction this repository built. " +
        'oracle/src/verifytx.cpp links ringct/rctSigs.cpp and runs parse_and_validate_tx_from_blob, ' +
        'rct::verRctSemanticsSimple (the Bulletproof+ range proofs and the commitment balance) and ' +
        'rct::verRctNonSemanticsSimple (every CLSAG, against the ring the offsets point at). The ' +
        'ring is built from the transaction\'s own key offsets against the `chain` table below, ' +
        'the way a daemon builds it. Regenerate with ./oracle/build.sh && node oracle/emit.mjs, ' +
        'and check with --check.',
      source: { repo: PINNED.upstream, tag: PINNED.tag },
      seeds: { sender: toHex(scalar(0xa11ce)), receiver: toHex(scalar(0xb0b)) },
      set,
      randomness: txRandom.map(toHex),
      built: {
        hex: built.tx.hex,
        txid: built.tx.txid,
        weight: built.tx.weight,
        fee: built.tx.fee,
        keyImages: built.tx.keyImages,
      },
      chain: txRing,
      wrongRingChain: wrongRing,
      tamperedHex: tampered,
      cases,
    },
  };
}

const outputs = [
  ['test/fixtures/monero-keyimages.json', fixture],
  ['test/fixtures/monero-unsigned-tx-set.json', unsignedFixture],
  ['test/fixtures/monero-import-key-images.json', importFixture],
  ['test/fixtures/monero-clsag.json', clsagFixture],
  ['test/fixtures/monero-verify-tx.json', verifyFixture],
];

let anyDiffered = false;
for (const [PATH, value] of outputs) {
  const text = JSON.stringify(value, null, 2) + '\n';

  if (!check) {
    writeFileSync(PATH, text);
    console.log(`oracle: wrote ${PATH}`);
    continue;
  }

  const committed = readFileSync(PATH, 'utf8');
  if (committed === text) {
    console.log(`oracle: ${PATH} reproduces exactly from Monero ${PINNED.tag}`);
    continue;
  }
  anyDiffered = true;
  if (PATH.endsWith('monero-unsigned-tx-set.json')) {
    const a = JSON.parse(committed);
    if (a.archive !== value.archive) console.error('oracle: the archive bytes differ');
    if (JSON.stringify(a.meaning) !== JSON.stringify(value.meaning)) {
      console.error('oracle: the meaning differs');
    }
    console.error(`oracle: ${PATH} does NOT reproduce. Do not re-pin without knowing why.`);
    continue;
  }
  diffByCase(JSON.parse(committed), value, PATH);
}
process.exit(anyDiffered ? 1 : 0);

function diffByCase(a, b, PATH) {

  /* A field-level diff rather than "they differ", because the useful question
   * is always which value moved. */
  for (const key of Object.keys(a)) {
    if (key === 'cases') continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      console.error(`oracle: ${key} differs`);
      console.error(`  committed ${JSON.stringify(a[key]).slice(0, 96)}`);
      console.error(`  oracle    ${JSON.stringify(b[key]).slice(0, 96)}`);
    }
  }
  for (const [i, want] of a.cases.entries()) {
    const got = b.cases[i];
    for (const key of Object.keys(want)) {
      if (JSON.stringify(want[key]) !== JSON.stringify(got?.[key])) {
        console.error(`oracle: case ${want.name}: ${key} differs`);
        console.error(`  committed ${JSON.stringify(want[key]).slice(0, 96)}`);
        console.error(`  oracle    ${JSON.stringify(got?.[key]).slice(0, 96)}`);
      }
    }
  }
  console.error(`oracle: ${PATH} does NOT reproduce. Do not re-pin without knowing why.`);
}
