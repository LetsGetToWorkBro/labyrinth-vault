/*
 * `unsigned_tx_set`, against Monero's own binary archive.
 *
 * `test/fixtures/monero-unsigned-tx-set.json` holds two things that came out
 * of `oracle/src/unsignedtxset.cpp`: the bytes `binary_archive<true>` wrote,
 * and a JSON description of what went into it. That harness includes
 * `wallet/wallet2.h` and serializes the real `wallet2::unsigned_tx_set`, so
 * none of the layout is transcribed anywhere.
 *
 * The shape of the test is: turn `archive` into `meaning`. That is stronger
 * than a round trip, which only shows a reader and a writer agree with each
 * other, and it is the only form available here anyway, because this reads a
 * format it deliberately does not write.
 *
 * ## Two mistakes this caught, both invisible from the struct
 *
 * Reading `wallet2.h` gives the field order and the types and is not enough.
 * The framework decides the encoding, and it decided twice in ways the header
 * does not show:
 *
 *   - a `std::tuple` writes a leading count, exactly as a pair writes its `2`;
 *   - `serialize_tuple_element` is specialised so a `uint64_t` inside a tuple
 *     is a **varint**, while the same type as a struct field is eight fixed
 *     bytes.
 *
 * Both were wrong in the first version. The stream desynchronised twenty bytes
 * later and asked for an array of eighty-six keys with twenty-eight bytes
 * left, which is the good failure: loud, and nowhere near the actual mistake.
 * A reader checked only against itself would have been happy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { BinaryArchive, ArchiveError, MAX_ARRAY } from '../src/keys/binaryarchive';
import {
  outlineTx,
  readUnsignedTxSetArchive,
  readUnsignedTxSetFile,
  SUPPORTED_ARCHIVE_VERSIONS,
  UNSIGNED_TX_MAGIC,
} from '../src/keys/monerounsigned';
import { setNativeCnSlowHash } from '../src/keys/moneroexport';

interface Dest {
  original: string;
  amount: string;
  spendPublic: string;
  viewPublic: string;
  isSubaddress: boolean;
  isIntegrated: boolean;
}

const fixture: {
  archive: string;
  meaning: {
    txes: {
      sources: {
        ringSize: number;
        outputs: { index: number; dest: string; mask: string }[];
        realOutput: number;
        realOutTxKey: string;
        realOutAdditionalTxKeys: string[];
        realOutputInTxIndex: number;
        amount: string;
        rct: boolean;
        mask: string;
      }[];
      changeDts: Dest;
      splittedDsts: Dest[];
      selectedTransfers: number[];
      extra: string;
      unlockTime: string;
      useRct: boolean;
      useViewTags: boolean;
      rctType: number;
      bpVersion: number;
      dests: Dest[];
      subaddrAccount: number;
      subaddrIndices: number[];
    }[];
    newTransfers: {
      first: number;
      second: number;
      details: {
        pubkey: string;
        internalOutputIndex: number;
        globalOutputIndex: number;
        txPubkey: string;
        flags: number;
        amount: string;
        additionalTxKeys: string[];
        subaddrMajor: number;
        subaddrMinor: number;
      }[];
    };
  };
} = JSON.parse(readFileSync('test/fixtures/monero-unsigned-tx-set.json', 'utf8'));

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((p) => parseInt(p, 16)));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const archive = bytes(fixture.archive);
const want = fixture.meaning;

describe('reading what Monero wrote', () => {
  /* Same reason as the outline block below: read inside the tests, so a reader
   * that stops parsing fails by name instead of collapsing collection. */
  const read = () => readUnsignedTxSetArchive(archive);

  it('reads it at all', () => {
    const r = read();
    expect(r.problem ?? '').toBe('');
    expect(r.ok).toBe(true);
    expect(r.set!.version).toBe(2);
    expect(SUPPORTED_ARCHIVE_VERSIONS).toContain(r.set!.version);
  });

  it('recovers every source field, including the two amounts that differ', () => {
    const source = read().set!.txes[0]!.sources[0]!;
    const w = want.txes[0]!.sources[0]!;

    expect(source.outputs).toHaveLength(w.ringSize);
    expect(source.outputs.map((o) => Number(o.index))).toEqual(w.outputs.map((o) => o.index));
    expect(source.outputs.map((o) => hex(o.dest))).toEqual(w.outputs.map((o) => o.dest));
    expect(source.outputs.map((o) => hex(o.mask))).toEqual(w.outputs.map((o) => o.mask));

    expect(Number(source.realOutput)).toBe(w.realOutput);
    expect(hex(source.realOutTxKey)).toBe(w.realOutTxKey);
    expect(source.realOutAdditionalTxKeys.map(hex)).toEqual(w.realOutAdditionalTxKeys);
    expect(Number(source.realOutputInTxIndex)).toBe(w.realOutputInTxIndex);
    /* The fixed-width one. Its sibling in a destination is a varint. */
    expect(source.amount.toString()).toBe(w.amount);
    expect(source.rct).toBe(w.rct);
    expect(hex(source.mask)).toBe(w.mask);
  });

  it('recovers every destination, change and split alike', () => {
    const tx = read().set!.txes[0]!;
    const w = want.txes[0]!;

    const same = (got: (typeof tx)['changeDts'], expected: Dest, where: string) => {
      expect(got.original, `${where} original`).toBe(expected.original);
      expect(got.amount.toString(), `${where} amount`).toBe(expected.amount);
      expect(hex(got.spendPublic), `${where} spend key`).toBe(expected.spendPublic);
      expect(hex(got.viewPublic), `${where} view key`).toBe(expected.viewPublic);
      expect(got.isSubaddress, `${where} subaddress flag`).toBe(expected.isSubaddress);
      expect(got.isIntegrated, `${where} integrated flag`).toBe(expected.isIntegrated);
    };

    same(tx.changeDts, w.changeDts, 'change');
    expect(tx.splittedDsts).toHaveLength(w.splittedDsts.length);
    tx.splittedDsts.forEach((d, i) => same(d, w.splittedDsts[i]!, `split ${i}`));
    tx.dests.forEach((d, i) => same(d, w.dests[i]!, `dest ${i}`));

    /* The address the sender typed, kept verbatim by the wallet. A reader that
     * mishandled the string length would desynchronise everything after it. */
    expect(tx.splittedDsts[0]!.original.startsWith('4AdUnd')).toBe(true);
  });

  it('recovers the rest of the construction data', () => {
    const tx = read().set!.txes[0]!;
    const w = want.txes[0]!;
    expect(tx.selectedTransfers.map(Number)).toEqual(w.selectedTransfers);
    expect(hex(tx.extra)).toBe(w.extra);
    expect(tx.unlockTime.toString()).toBe(w.unlockTime);
    expect(tx.useRct).toBe(w.useRct);
    expect(tx.useViewTags).toBe(w.useViewTags);
    expect(tx.rctType).toBe(w.rctType);
    expect(tx.bpVersion).toBe(w.bpVersion);
    expect(tx.subaddrAccount).toBe(w.subaddrAccount);
    expect(tx.subaddrIndices).toEqual(w.subaddrIndices);
  });

  it('recovers the exported transfers, which are behind a tuple', () => {
    /* The tuple is where this reader was wrong twice. Its count byte and its
     * varint integers are both invisible in wallet2.h. */
    const nt = read().set!.newTransfers;
    expect(Number(nt.first)).toBe(want.newTransfers.first);
    expect(Number(nt.second)).toBe(want.newTransfers.second);

    const got = nt.details[0]!;
    const w = want.newTransfers.details[0]!;
    expect(hex(got.pubkey)).toBe(w.pubkey);
    expect(Number(got.internalOutputIndex)).toBe(w.internalOutputIndex);
    expect(Number(got.globalOutputIndex)).toBe(w.globalOutputIndex);
    expect(hex(got.txPubkey)).toBe(w.txPubkey);
    expect(got.flags).toBe(w.flags);
    expect(got.amount.toString()).toBe(w.amount);
    expect(got.additionalTxKeys.map(hex)).toEqual(w.additionalTxKeys);
    expect(got.subaddrMajor).toBe(w.subaddrMajor);
    expect(got.subaddrMinor).toBe(w.subaddrMinor);
  });

  it('consumed the archive exactly, with nothing left over', () => {
    /* The cheapest whole-file check there is. Any field read at the wrong
     * width leaves a remainder or runs off the end, so this catches a class of
     * mistake that per-field assertions can miss when two errors cancel. */
    expect(readUnsignedTxSetArchive(archive.slice(0, -1)).ok, 'a truncated archive read').toBe(false);
    const longer = new Uint8Array(archive.length + 1);
    longer.set(archive, 0);
    expect(readUnsignedTxSetArchive(longer).ok, 'trailing bytes were ignored').toBe(false);
  });
});

describe('the outline a person would be shown', () => {
  /* Computed inside each test rather than in the describe body. A describe
   * body runs at collection time, so a reader that stopped parsing would throw
   * there and vitest would report "no tests" for the whole file: technically a
   * failure, and a much worse diagnostic than a named assertion. That is not
   * hypothetical, it is what the mutation checks for this file produced before
   * this was moved. */
  const outline = () => outlineTx(readUnsignedTxSetArchive(archive).set!.txes[0]!);

  it('adds up the way the file claims', () => {
    /* 3 XMR in, 2.4 out, 0.5 back as change, so 0.1 of fee. Atomic units
     * throughout: a number would hold these exactly today and stop doing so
     * for a large enough wallet, which is the worst kind of limit. */
    const o = outline();
    expect(o.spending).toBe(3_000_000_000_000n);
    expect(o.paying).toBe(2_400_000_000_000n);
    expect(o.change).toBe(500_000_000_000n);
    expect(o.fee).toBe(100_000_000_000n);
    expect(o.spending).toBe(o.paying + o.change + o.fee);
  });

  it('reports the shape of the spend', () => {
    const o = outline();
    expect(o.inputs).toBe(1);
    expect(o.outputs).toBe(2);
    expect(o.ringSize).toBe(2);
    expect(o.destinations[0]!.isSubaddress).toBe(true);
  });

  it('is arithmetic over a claim and says so where it matters', () => {
    /* The file is the sender's description of their own transaction. Nothing
     * here verifies it and nothing can: a watch-only wallet that lied about a
     * destination produces a file that outlines beautifully. The comment in
     * the source is the guard; this asserts it stays there, because the day it
     * is deleted is the day somebody treats the outline as approval. */
    const source = readFileSync('src/keys/monerounsigned.ts', 'utf8');
    expect(source).toMatch(/not verified against anything|cannot be, and must never be shown/);
  });
});

describe('what the reader refuses', () => {
  it('refuses an archive version it does not read', () => {
    const v0 = new Uint8Array(archive);
    v0[0] = 0;
    const read = readUnsignedTxSetArchive(v0);
    expect(read.ok).toBe(false);
    expect(read.problem).toMatch(/archive version 0/);
    /* And it says why, rather than "unsupported": versions below 2 are the
     * Boost-era format that Monero itself will not load by default. */
    expect(read.problem).toMatch(/deprecated-formats|Boost/);
  });

  it('never throws, whatever it is handed', () => {
    /* A signing device that crashes on a malformed file is one somebody can
     * deny service to with a sticker. Every path returns a refusal. */
    const cases = [
      new Uint8Array(0),
      new Uint8Array([0xff]),
      new Uint8Array(64).fill(0xff),
      archive.slice(0, 5),
      archive.slice(3),
    ];
    for (const [i, input] of cases.entries()) {
      const read = readUnsignedTxSetArchive(input);
      expect(read.ok, `case ${i} was accepted`).toBe(false);
      expect(typeof read.problem, `case ${i} gave no reason`).toBe('string');
    }
  });

  it('says which byte it gave up at', () => {
    /* "Could not read that" is not something anybody can act on. */
    expect(readUnsignedTxSetArchive(archive.slice(0, 40)).problem).toMatch(/at byte \d+/);
  });

  it('names the container it is for, so a screen can say what was scanned', () => {
    expect(UNSIGNED_TX_MAGIC).toBe('Monero unsigned tx set');
  });
});

describe('the archive primitives', () => {
  it('refuses a non-canonical varint', () => {
    /* Monero's own `read_varint` returns EVARINT_REPRESENT for a zero byte in
     * any position but the first. Accepting it would mean two different byte
     * strings decode to the same value, which is malleability in a file that
     * gets signed over. */
    expect(() => new BinaryArchive(Uint8Array.from([0x80, 0x00])).readVarintU64()).toThrow(
      ArchiveError,
    );
    /* The canonical encoding of the same value is one byte. */
    expect(new BinaryArchive(Uint8Array.from([0x00])).readVarintU64()).toBe(0n);
  });

  it('refuses a varint too long for 64 bits', () => {
    const tooLong = new Uint8Array(11).fill(0xff);
    expect(() => new BinaryArchive(tooLong).readVarintU64()).toThrow(ArchiveError);
  });

  it('reads fixed integers little-endian', () => {
    const ar = new BinaryArchive(Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0]));
    expect(ar.readU64()).toBe(1n);
    expect(ar.readU32()).toBe(2);
  });

  it('refuses a bool that is not a bool', () => {
    /* C++ treats any non-zero byte as true. Here it means the offset is wrong,
     * and continuing from a wrong offset is how a parser invents a
     * transaction. */
    expect(() => new BinaryArchive(Uint8Array.from([2])).readBool()).toThrow(ArchiveError);
    expect(new BinaryArchive(Uint8Array.from([1])).readBool()).toBe(true);
  });

  it('refuses an array longer than the bytes that could hold it', () => {
    /* The count comes before the elements, so a hostile file can claim a
     * million of something. Checked against what is actually left, before
     * anything is allocated. */
    const ar = new BinaryArchive(Uint8Array.from([0x0a, 0x01]));
    expect(() => ar.readCount('things', 32)).toThrow(ArchiveError);
    expect(MAX_ARRAY).toBeGreaterThan(1000);
  });

  it('checks the count a pair and a tuple write', () => {
    expect(() => new BinaryArchive(Uint8Array.from([3])).expectPair()).toThrow(/claimed 3/);
    expect(() => new BinaryArchive(Uint8Array.from([2])).expectTuple(3)).toThrow(/not 3/);
    expect(() => new BinaryArchive(Uint8Array.from([2])).expectPair()).not.toThrow();
  });
});

describe('the whole file, envelope and all', () => {
  /* `dump_tx_to_str` wraps the archive in `encrypt_with_view_secret_key`, the
   * same envelope the key-image export uses: an 8-byte IV, ChaCha20 under a
   * CryptoNight-derived key, and a signature over cn_fast_hash(iv||ciphertext).
   *
   * The fixture carries the finished file and the view secret that made it, so
   * this exercises the path a scanned file actually takes rather than the
   * archive alone. It also means Stage 2's CryptoNight work and this reader
   * are checked together, which is how they will be used. */
  const whole: { file: string; viewSecret: string; chachaKey: string } = fixture as never;

  beforeEach(() => setNativeCnSlowHash((data) => {
    /* Answers only for the one view secret the fixture pins, so an unexpected
     * input fails loudly. Not circular: CryptoNightVectorTests.swift holds the
     * real vendored C to a chacha key from the same oracle. */
    if (hex(data) === whole.viewSecret) return bytes(whole.chachaKey);
    throw new Error('the shim has no CryptoNight answer for that input');
  }));
  afterEach(() => setNativeCnSlowHash(null));

  it('reads the encrypted file end to end', () => {
    const read = readUnsignedTxSetFile(bytes(whole.file), bytes(whole.viewSecret));
    expect(read.problem ?? '').toBe('');
    expect(read.ok).toBe(true);
    const o = outlineTx(read.set!.txes[0]!);
    expect(o.spending).toBe(3_000_000_000_000n);
    expect(o.fee).toBe(100_000_000_000n);
  });

  it('refuses a file that is not one', () => {
    expect(readUnsignedTxSetFile(bytes(whole.file).slice(4), bytes(whole.viewSecret)).problem)
      .toMatch(/not a Monero unsigned transaction set/);
  });

  it('names the file version it does not read', () => {
    const wrong = bytes(whole.file);
    wrong[UNSIGNED_TX_MAGIC.length] = 4;
    expect(readUnsignedTxSetFile(wrong, bytes(whole.viewSecret)).problem)
      .toMatch(/file version 4/);
  });

  it('refuses a file that belongs to another wallet', () => {
    /* A wrong key decrypts to noise, and noise does not parse as an archive
     * that consumes every byte. That is a weaker claim than authentication and
     * it is the true one; the module says so where it decrypts. */
    const other = new Uint8Array(32).fill(9);
    setNativeCnSlowHash(() => new Uint8Array(32).fill(3));
    const read = readUnsignedTxSetFile(bytes(whole.file), other);
    expect(read.ok).toBe(false);
  });

  it('refuses outright when the build has no CryptoNight', () => {
    setNativeCnSlowHash(null);
    const read = readUnsignedTxSetFile(bytes(whole.file), bytes(whole.viewSecret));
    expect(read.ok).toBe(false);
    expect(read.problem).toMatch(/CryptoNight/);
  });
});
