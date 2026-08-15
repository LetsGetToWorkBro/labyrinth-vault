/**
 * Catching one of Monero's own wallet files coming *back* from the vault.
 *
 * ## Why this wallet is a courier and not a reader
 *
 * The vault can write `Monero key image export`, the file Cake, Feather and
 * `monero-wallet-cli` import. It has no network, so the only way out is light,
 * and none of those wallets can read a QR code. Something has to stand between
 * the glass and a file on a disk, and this phone is the only device in the
 * room that is holding both a camera and a filesystem.
 *
 * So: catch the frames, write the bytes, hand the file to the share sheet.
 * This wallet does not open it and does not need to. It already has those key
 * images from `XMRKEYIMAGES`, on its own wire, matched to outputs by key
 * rather than by position — and opening the file would need CryptoNight, which
 * lives in the vault and not here. Carrying is the whole job.
 *
 * ## Why the judgement is in `core/`
 *
 * Every sentence below decides what somebody does next, and one of them
 * decides it about a file that determines whether their balance is right. The
 * container is recognised with the vault's own `readContainer`, through the
 * `@vault/*` path both halves share, so this wallet and the device that wrote
 * the file cannot come to disagree about what it is.
 */

import { readContainer, type ContainerKind } from '@vault/keys/monerotx';

export interface IncomingMoneroFile {
  /** Whether this is a file worth keeping. */
  ok: boolean;
  /** Plain words for it, when it was recognised at all. */
  what?: string;
  kind?: ContainerKind;
  /** What the screen says about it, in either direction. */
  note: string;
  /** The name to write it under, when it is worth keeping. */
  filename?: string;
}

/**
 * The name a wallet2 file is written under.
 *
 * `monero-wallet-cli` takes a path as an argument and imposes nothing, but the
 * defaults its own docs and every guide use are these, and a file that arrives
 * in somebody's Files app called `payload.bin` is a file they have to guess
 * about. No extension, because the CLI's own exports have none.
 */
const FILENAMES: Partial<Record<ContainerKind, string>> = {
  'key-image-export': 'key_images',
  'signed-tx-set': 'signed_monero_tx',
  'unsigned-tx-set': 'unsigned_monero_tx',
};

/**
 * Decide what to do with an `XMRFILE` payload that arrived over the camera.
 *
 * Pure, so the sentences are under test. Nothing here writes anything: the
 * caller does that on a tap, because a scan that silently drops files into a
 * documents directory is a scan with a side effect nobody asked for.
 */
export function receiveMoneroFile(bytes: Uint8Array): IncomingMoneroFile {
  const container = readContainer(bytes);
  if (!container) {
    return {
      ok: false,
      note:
        "Those codes carried a Monero wallet file and the bytes are not one. Nothing was saved. " +
        'Scanning again is the usual fix; a frame can arrive damaged in a way the checksum ' +
        'catches only for the payload as a whole.',
    };
  }

  if (container.kind === 'key-image-export') {
    return {
      ok: true,
      what: container.what,
      kind: container.kind,
      filename: FILENAMES['key-image-export']!,
      note:
        'That is a Monero key image export, written by your vault. Save it and import it into the ' +
        'Monero wallet that scanned these outputs: it is what turns a received total into a ' +
        'balance there. This wallet already has the same images on its own wire and does not ' +
        'need the file; it is carrying it for the other one.',
    };
  }

  if (container.kind === 'unsigned-tx-set') {
    /* Somebody has pointed the camera at this phone's own screen, or at
     * whatever they were about to show the vault. Saying "not for this wallet"
     * would be true and useless; saying which direction it goes is the thing
     * that gets them unstuck. */
    return {
      ok: false,
      what: container.what,
      kind: container.kind,
      note:
        'That is an unsigned transaction set, which travels the other way: it is a file you show ' +
        'the vault so it can tell you what the payment says. Nothing was saved. Use SHOW A MONERO ' +
        'FILE from the vault screen to send one across.',
    };
  }

  return {
    ok: false,
    what: container.what,
    kind: container.kind,
    note:
      `That is ${container.what}. Your vault does not write one of those, so it did not come from ` +
      'there, and this wallet has nothing to do with it. Nothing was saved.',
  };
}
