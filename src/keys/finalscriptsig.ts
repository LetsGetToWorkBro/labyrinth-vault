/**
 * The empty field that decides whether Electrum will broadcast.
 *
 * ## The defect
 *
 * When the vault finalizes a native segwit input it writes
 * `PSBT_IN_FINAL_SCRIPTWITNESS` (key 0x08) and nothing else, because a native
 * segwit input has no scriptSig and `@scure/btc-signer` drops a zero-length
 * `PSBT_IN_FINAL_SCRIPTSIG` (key 0x07) when it serializes. Defensible: BIP-174
 * says a finalizer produces that field only if the input has a scriptSig, and
 * this one does not.
 *
 * Electrum disagrees, in code:
 *
 *     def is_complete(self) -> bool:
 *         if self.script_sig is not None and self.witness is not None:
 *             return True
 *
 * (`electrum/transaction.py`, `PartialTxInput.is_complete`.) `script_sig` is
 * None when the key is absent, so a finalized transaction from this vault
 * reads to Electrum as still needing a signature, and the Broadcast button
 * does not appear. The signature is right there in the witness; Electrum will
 * not look at it.
 *
 * This was found by handing a real signed PSBT to Electrum's own parser rather
 * than by reading its documentation, and it is not a QR problem: it breaks the
 * file path and the hex path in exactly the same way.
 *
 * ## Why writing the empty field is the correct fix and not a workaround
 *
 * Electrum's own finalizer does this:
 *
 *     if txin.is_native_segwit():
 *         return b""
 *
 * (`Transaction.input_script`.) It sets the scriptSig to empty and serializes
 * it. So an empty 0x07 is what Electrum produces itself, and what every
 * Electrum-signed PSBT in the world already carries. We are matching the
 * ecosystem rather than appeasing one reader.
 *
 * ## Why this is byte surgery instead of an API call
 *
 * `tx.updateInput(i, { finalScriptSig: new Uint8Array(0) })` is accepted by
 * `@scure/btc-signer` and then discarded at `toPSBT()`, which was checked
 * rather than assumed. There is no way through the library, so the field is
 * added to the serialized bytes afterwards.
 *
 * That is a real risk in a signing device, so the boundaries are tight: this
 * inserts one zero-length record into an input's key-value map and touches
 * nothing else. It never edits a witness, a signature, an amount or an output,
 * it refuses rather than guesses on anything it does not fully parse, and
 * `test/finalscriptsig.test.ts` asserts that the transaction id is identical
 * before and after. A PSBT field is metadata about a transaction; the
 * transaction is what the id covers, and it does not move.
 */

/** `psbt\xff`. */
const MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff];

const KEY_FINAL_SCRIPTSIG = 0x07;
const KEY_FINAL_SCRIPTWITNESS = 0x08;

/** A record's key and value are each length-prefixed with a compact size. */
interface Cursor {
  at: number;
}

function readCompactSize(bytes: Uint8Array, cursor: Cursor): number | null {
  if (cursor.at >= bytes.length) return null;
  const first = bytes[cursor.at++]!;
  if (first < 0xfd) return first;

  /* PSBT lengths above 0xfc are legal and this file has no business seeing
   * one: it walks only as far as the input maps, and a key longer than 252
   * bytes there means something is going on that is better refused than
   * parsed. Returning null aborts the whole rewrite and the original bytes go
   * out untouched. */
  return null;
}

/**
 * Walk one key-value map to its `0x00` terminator.
 *
 * Returns the offset of the terminator and which of the keys of interest were
 * seen, or null if the map does not parse.
 */
function scanMap(
  bytes: Uint8Array,
  cursor: Cursor,
): { end: number; hasFinalScriptSig: boolean; hasFinalWitness: boolean } | null {
  let hasFinalScriptSig = false;
  let hasFinalWitness = false;

  for (;;) {
    if (cursor.at >= bytes.length) return null;
    if (bytes[cursor.at] === 0x00) {
      const end = cursor.at;
      cursor.at++;
      return { end, hasFinalScriptSig, hasFinalWitness };
    }

    const keyLength = readCompactSize(bytes, cursor);
    if (keyLength === null || keyLength < 1) return null;
    if (cursor.at + keyLength > bytes.length) return null;

    const keyType = bytes[cursor.at]!;
    if (keyType === KEY_FINAL_SCRIPTSIG) hasFinalScriptSig = true;
    if (keyType === KEY_FINAL_SCRIPTWITNESS) hasFinalWitness = true;
    cursor.at += keyLength;

    const valueLength = readCompactSize(bytes, cursor);
    if (valueLength === null) return null;
    if (cursor.at + valueLength > bytes.length) return null;
    cursor.at += valueLength;
  }
}

/**
 * Add an empty `PSBT_IN_FINAL_SCRIPTSIG` to every input that has a final
 * witness and no final scriptSig.
 *
 * Returns the input unchanged if there is nothing to add, or if anything at
 * all does not parse. Never throws: this sits on the path a signature takes
 * home, and a PSBT that goes out slightly less compatible is a much better
 * failure than one that does not go out.
 */
export function withEmptyFinalScriptSig(psbt: Uint8Array): Uint8Array {
  for (let i = 0; i < MAGIC.length; i++) {
    if (psbt[i] !== MAGIC[i]) return psbt;
  }

  const cursor: Cursor = { at: MAGIC.length };

  /* The global map, walked only to find where the input maps start. The number
   * of inputs is not read from `PSBT_GLOBAL_UNSIGNED_TX` here: the input maps
   * run until the output maps begin, and this walks them one at a time and
   * stops when the bytes run out, which needs no count to be correct. */
  if (!scanMap(psbt, cursor)) return psbt;

  const insertAt: number[] = [];
  while (cursor.at < psbt.length) {
    const map = scanMap(psbt, cursor);
    if (!map) return psbt;
    if (map.hasFinalWitness && !map.hasFinalScriptSig) insertAt.push(map.end);
    /* The output maps follow the input maps with nothing between them, so this
     * walks into them too. That is harmless: an output map carries neither of
     * the two keys, so it can never be selected for an insertion. */
  }

  if (insertAt.length === 0) return psbt;

  /* One record, three bytes: key length 1, key type 0x07, value length 0. */
  const RECORD = [0x01, KEY_FINAL_SCRIPTSIG, 0x00];
  const out = new Uint8Array(psbt.length + insertAt.length * RECORD.length);

  let read = 0;
  let write = 0;
  for (const at of insertAt) {
    out.set(psbt.subarray(read, at), write);
    write += at - read;
    out.set(RECORD, write);
    write += RECORD.length;
    read = at;
  }
  out.set(psbt.subarray(read), write);
  return out;
}
