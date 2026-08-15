/**
 * `unsigned_tx_set`: the file a Monero watch-only wallet hands a cold signer.
 *
 * ## What this is and is not
 *
 * It **reads** the container. It does not sign it, and nothing here is a step
 * towards signing it by accident: reading a construction plan and building a
 * transaction from one are different jobs, and the second needs a confirmation
 * screen that re-derives every destination from the vault's own keys before a
 * person is asked to approve anything. `src/keys/monerobuild.ts` is where that
 * lives, on this project's own wire.
 *
 * What this buys today is that the vault stops saying "unsupported" to a file
 * it can in fact understand, and can instead say what is in it. That is a real
 * increment and it is also the honest ceiling on it.
 *
 * ## The layout, from wallet2.h:697
 *
 *     version           varint, currently 2
 *     txes              array of tx_construction_data
 *     new_transfers     a tuple: varint, varint, array of exported_transfer_details
 *
 * Versions 0 and 1 take different branches upstream and are refused here.
 * They are reachable only from files older than 2022, upstream itself gates
 * them behind `m_load_deprecated_formats`, and a reader for a format nobody
 * emits is a surface with no users.
 *
 * ## Amounts
 *
 * Every amount is a bigint of atomic units, 1e-12 XMR. They are never
 * converted to a number here. A `number` holds 2^53 exactly and Monero's
 * supply is past that, so a float somewhere in this path is a wrong balance
 * waiting for a large enough wallet.
 */

import { ArchiveError, BinaryArchive } from './binaryarchive';
import { decryptWithViewSecretKey } from './moneroexport';

/** `"Monero unsigned tx set"`, then a version byte. wallet2.cpp:114. */
export const UNSIGNED_TX_MAGIC = 'Monero unsigned tx set';
/** The version byte upstream currently writes. */
export const UNSIGNED_TX_VERSION_BYTE = 0x05;

/** The archive versions this reads. 0 and 1 are Boost-era and refused. */
export const SUPPORTED_ARCHIVE_VERSIONS = [2];

export interface RingMemberEntry {
  /** Global output index on the chain. A pair element, so a varint. */
  index: bigint;
  /** The one-time public key. */
  dest: Uint8Array;
  /** The amount commitment. */
  mask: Uint8Array;
}

export interface SourceEntry {
  outputs: RingMemberEntry[];
  /** Which member of `outputs` is the real one being spent. */
  realOutput: bigint;
  realOutTxKey: Uint8Array;
  realOutAdditionalTxKeys: Uint8Array[];
  realOutputInTxIndex: bigint;
  /** Atomic units. `FIELD`, so eight fixed bytes rather than a varint. */
  amount: bigint;
  rct: boolean;
  mask: Uint8Array;
}

export interface DestinationEntry {
  /** The address as the sender typed it, when the wallet kept it. */
  original: string;
  /** Atomic units. `VARINT_FIELD`, unlike the source amount above. */
  amount: bigint;
  spendPublic: Uint8Array;
  viewPublic: Uint8Array;
  isSubaddress: boolean;
  isIntegrated: boolean;
}

export interface ConstructionData {
  sources: SourceEntry[];
  changeDts: DestinationEntry;
  /** Every output including change, which is what the transaction will pay. */
  splittedDsts: DestinationEntry[];
  selectedTransfers: bigint[];
  extra: Uint8Array;
  unlockTime: bigint;
  useRct: boolean;
  useViewTags: boolean;
  rctType: number;
  bpVersion: number;
  /** What the sender asked for, before change was added. */
  dests: DestinationEntry[];
  subaddrAccount: number;
  subaddrIndices: number[];
}

export interface ExportedTransferDetails {
  pubkey: Uint8Array;
  internalOutputIndex: bigint;
  globalOutputIndex: bigint;
  txPubkey: Uint8Array;
  flags: number;
  amount: bigint;
  additionalTxKeys: Uint8Array[];
  subaddrMajor: number;
  subaddrMinor: number;
}

export interface UnsignedTxSet {
  version: number;
  txes: ConstructionData[];
  newTransfers: {
    first: bigint;
    second: bigint;
    details: ExportedTransferDetails[];
  };
}

/**
 * `construction_flags_`, wallet2.h:576.
 *
 * `use_rct` used to be a bool of its own and became a bit when view tags
 * arrived, which is why the reader has to know both shapes exist even though
 * only one is written now.
 */
const FLAG_USE_RCT = 1 << 0;
const FLAG_USE_VIEW_TAGS = 1 << 1;

function readDestination(ar: BinaryArchive): DestinationEntry {
  return {
    original: ar.readString('a destination address'),
    /* VARINT_FIELD(amount). The source entry's amount is fixed-width; see the
     * note at the top of binaryarchive.ts about why these two differ. */
    amount: ar.readVarintU64(),
    spendPublic: ar.readKey(),
    viewPublic: ar.readKey(),
    isSubaddress: ar.readBool(),
    isIntegrated: ar.readBool(),
  };
}

function readSource(ar: BinaryArchive): SourceEntry {
  /* Each output_entry is `std::pair<uint64_t, rct::ctkey>`: the varint 2, the
   * index as a pair element and therefore a varint, then 64 bytes of keys. */
  const outputs = ar.readArray('ring members', 66, () => {
    ar.expectPair();
    return {
      index: ar.readVarintU64(),
      dest: ar.readKey(),
      mask: ar.readKey(),
    };
  });

  return {
    outputs,
    /* FIELD(real_output): fixed eight bytes. */
    realOutput: ar.readU64(),
    realOutTxKey: ar.readKey(),
    realOutAdditionalTxKeys: ar.readArray('additional tx keys', 32, () => ar.readKey()),
    realOutputInTxIndex: ar.readU64(),
    amount: ar.readU64(),
    rct: ar.readBool(),
    mask: ar.readKey(),
    /* `multisig_kLRki` follows in the C++ struct and is four keys of zeroes
     * for a single-signature wallet. It is read and discarded rather than
     * skipped by length, so a file that puts something else there still
     * advances the cursor correctly. This vault does not do multisig and does
     * not interpret these. */
    ...(() => {
      ar.readKey();
      ar.readKey();
      ar.readKey();
      ar.readKey();
      return {};
    })(),
  };
}

function readConstructionData(ar: BinaryArchive): ConstructionData {
  const sources = ar.readArray('sources', 1, () => readSource(ar));
  const changeDts = readDestination(ar);
  const splittedDsts = ar.readArray('split destinations', 1, () => readDestination(ar));
  /* std::vector<size_t>: container elements, unsigned and wider than a byte,
   * so varints. */
  const selectedTransfers = ar.readArray('selected transfers', 1, () => ar.readVarintU64());
  /* std::vector<uint8_t>: one byte each, so a count and then raw bytes. */
  const extra = new Uint8Array(ar.readArray('extra', 1, () => ar.readU8()));
  const unlockTime = ar.readU64();

  /* `use_rct` became `construction_flags` when view tags arrived, and upstream
   * kept the field's position so old files still parse. Both bits come out of
   * the same byte. */
  const constructionFlags = ar.readU8();
  const useRct = (constructionFlags & FLAG_USE_RCT) !== 0;
  const useViewTags = (constructionFlags & FLAG_USE_VIEW_TAGS) !== 0;

  /* rct::RCTConfig: its own VERSION_FIELD(0), then two varints. */
  const rctConfigVersion = ar.readVarintNumber('an rct config version');
  if (rctConfigVersion !== 0) {
    throw new ArchiveError(`rct config version ${rctConfigVersion} is not one this reads`, ar.offset);
  }
  const rctType = ar.readVarintNumber('an rct range proof type');
  const bpVersion = ar.readVarintNumber('a bulletproof version');

  const dests = ar.readArray('destinations', 1, () => readDestination(ar));
  const subaddrAccount = ar.readU32();
  /* std::set<uint32_t>: container elements again, so varints. */
  const subaddrIndices = ar.readArray('subaddress indices', 1, () =>
    ar.readVarintNumber('a subaddress index'),
  );

  return {
    sources,
    changeDts,
    splittedDsts,
    selectedTransfers,
    extra,
    unlockTime,
    useRct,
    useViewTags,
    rctType,
    bpVersion,
    dests,
    subaddrAccount,
    subaddrIndices,
  };
}

function readExportedTransfer(ar: BinaryArchive): ExportedTransferDetails {
  const version = ar.readVarintNumber('an exported transfer version');
  if (version < 1) {
    throw new ArchiveError(`exported transfer version ${version} is refused upstream too`, ar.offset);
  }
  return {
    pubkey: ar.readKey(),
    internalOutputIndex: ar.readVarintU64(),
    globalOutputIndex: ar.readVarintU64(),
    txPubkey: ar.readKey(),
    flags: ar.readU8(),
    amount: ar.readVarintU64(),
    additionalTxKeys: ar.readArray('additional tx keys', 32, () => ar.readKey()),
    subaddrMajor: ar.readVarintNumber('a subaddress major index'),
    subaddrMinor: ar.readVarintNumber('a subaddress minor index'),
  };
}

export interface ReadResult {
  ok: boolean;
  set?: UnsignedTxSet;
  problem?: string;
}

/**
 * Read the archive body, without the `"Monero unsigned tx set\x05"` prefix and
 * without the encryption around it.
 *
 * Never throws. A signing device that crashes on a malformed file is a device
 * somebody can deny service to with a QR code, and every refusal here says
 * which byte it gave up at, because "could not read that" is not something a
 * person can act on.
 */
export function readUnsignedTxSetArchive(bytes: Uint8Array): ReadResult {
  const ar = new BinaryArchive(bytes);
  try {
    const version = ar.readVarintNumber('an archive version');
    if (!SUPPORTED_ARCHIVE_VERSIONS.includes(version)) {
      return {
        ok: false,
        problem:
          `This is an unsigned transaction set at archive version ${version}, and this build reads ` +
          `${SUPPORTED_ARCHIVE_VERSIONS.join(' and ')}. Versions below 2 are the Boost-era format, ` +
          `which Monero itself will not load without --load-deprecated-formats.`,
      };
    }

    const txes = ar.readArray('transactions', 1, () => readConstructionData(ar));

    /* std::tuple<uint64_t, uint64_t, vector<...>>.
     *
     * A tuple writes a leading count exactly as a pair does, `begin_array(3)`
     * in `serialization/tuple.h`, and its `uint64_t` elements go through
     * `serialize_tuple_element`, which is specialised to a varint. Both of
     * those were guessed wrong first time round and the oracle caught it: the
     * stream desynchronised twenty bytes later and asked for an array of 86
     * keys with 28 bytes left. Neither mistake is visible by reading the
     * struct, only by reading the framework. */
    ar.expectTuple(3);
    const first = ar.readVarintU64();
    const second = ar.readVarintU64();
    const details = ar.readArray('exported transfers', 1, () => readExportedTransfer(ar));

    ar.expectEnd();

    return { ok: true, set: { version, txes, newTransfers: { first, second, details } } };
  } catch (error) {
    if (error instanceof ArchiveError) return { ok: false, problem: error.message };
    return { ok: false, problem: 'That is not an unsigned transaction set this build can read.' };
  }
}

/** The magic and its version byte, as one prefix. */
const MAGIC_BYTES = (() => {
  const out = new Uint8Array(UNSIGNED_TX_MAGIC.length + 1);
  for (let i = 0; i < UNSIGNED_TX_MAGIC.length; i++) out[i] = UNSIGNED_TX_MAGIC.charCodeAt(i);
  out[UNSIGNED_TX_MAGIC.length] = UNSIGNED_TX_VERSION_BYTE;
  return out;
})();

/**
 * The whole file, as `dump_tx_to_str` writes it.
 *
 * Prefix, then `encrypt_with_view_secret_key` around the archive. The envelope
 * is the same one the key-image export uses, which is why it is shared rather
 * than written twice; see `decryptWithViewSecretKey`.
 *
 * Needs the view secret key, and therefore an unlocked vault and a build with
 * CryptoNight. Without either, this is a refusal with a reason rather than a
 * mis-parse: the key derivation refuses first.
 */
export function readUnsignedTxSetFile(
  file: Uint8Array,
  viewSecret: Uint8Array,
  kdfRounds = 1,
): ReadResult {
  if (file.length <= MAGIC_BYTES.length) {
    return { ok: false, problem: 'That file is too short to be an unsigned transaction set.' };
  }
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (file[i] !== MAGIC_BYTES[i]) {
      /* The version byte is part of the prefix upstream compares, so a v4 file
       * lands here rather than deeper in, and the message should say which
       * thing was wrong. */
      const named = i === UNSIGNED_TX_MAGIC.length;
      return {
        ok: false,
        problem: named
          ? `That is an unsigned transaction set at file version ${file[i]}, and this build reads ${UNSIGNED_TX_VERSION_BYTE}.`
          : 'That is not a Monero unsigned transaction set.',
      };
    }
  }

  const plaintext = decryptWithViewSecretKey(file.subarray(MAGIC_BYTES.length), viewSecret, kdfRounds);
  if (!plaintext) {
    return {
      ok: false,
      problem:
        'That unsigned transaction set could not be decrypted with this vault key. Either it ' +
        'belongs to another wallet, or this build has no CryptoNight.',
    };
  }
  return readUnsignedTxSetArchive(plaintext);
}

// ---------------------------------------------------------------------------
// Saying what is in it

export interface TxOutline {
  /** Atomic units the transaction consumes, from its ring sources. */
  spending: bigint;
  /** Atomic units paid to somebody who is not this wallet, per the plan. */
  paying: bigint;
  /** Atomic units coming back as change, per the plan. */
  change: bigint;
  /** Inputs minus outputs. */
  fee: bigint;
  ringSize: number;
  inputs: number;
  outputs: number;
  unlockTime: bigint;
  destinations: { amount: bigint; isSubaddress: boolean; original: string }[];
}

/**
 * Arithmetic over what the file claims, and nothing more.
 *
 * Everything here is the *sender's* description of their own transaction. It
 * is not verified against anything, cannot be, and must never be shown to a
 * person as though it were: a watch-only wallet that lies about a destination
 * produces a file that outlines beautifully. Verification means re-deriving
 * each output from the vault's keys, which is a signing-time job.
 *
 * The fee is computed rather than read, because the file does not carry one.
 * Inputs minus outputs is what a fee is.
 */
export function outlineTx(tx: ConstructionData): TxOutline {
  const spending = tx.sources.reduce((total, source) => total + source.amount, 0n);
  const change = tx.changeDts.amount;
  const outputs = tx.splittedDsts.reduce((total, dst) => total + dst.amount, 0n);

  return {
    spending,
    paying: outputs - change,
    change,
    fee: spending - outputs,
    ringSize: tx.sources[0]?.outputs.length ?? 0,
    inputs: tx.sources.length,
    outputs: tx.splittedDsts.length,
    unlockTime: tx.unlockTime,
    destinations: tx.dests.map((d) => ({
      amount: d.amount,
      isSubaddress: d.isSubaddress,
      original: d.original,
    })),
  };
}
