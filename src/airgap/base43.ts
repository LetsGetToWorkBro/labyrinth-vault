/**
 * Base43: the only animated-QR-free wire Electrum has, and the reason the
 * "SPARROW · ELECTRUM" label on the UR picker was a lie.
 *
 * ## What Electrum actually does
 *
 * Nothing in Electrum reads BC-UR. There is no `crypto-psbt`, no `bcur`, no
 * fountain decoder; a search of the source for any of it returns nothing. What
 * it has is `Transaction.to_qr_data`, which base43-encodes the serialized PSBT
 * into one static QR, and `convert_raw_tx_to_hex`, which on the way back in
 * tries, in order:
 *
 *     hex  ->  base64 (only if it starts `cHNidP`)  ->  base43  ->  raw bytes
 *
 * (`electrum/transaction.py`.) So a signer that emits only UR is a signer
 * Electrum cannot talk to at all, which is what this app was doing while
 * naming Electrum on the button.
 *
 * ## Why 43 and not 64
 *
 * The alphabet is `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$*+-./:`, which is the
 * QR **alphanumeric** character set minus space and percent. QR packs that
 * mode at 5.5 bits per character against 8 for byte mode, so base43 in a QR is
 * denser than base64 in a QR despite being a worse encoding on paper. That is
 * the whole of the design, and it is the same reason BBQr uses base32.
 *
 * Electrum will take base64 too, and `psbtBase64` in bbqr.ts covers the
 * wallets that want it. Base43 is offered first because it is the one that
 * fits in a smaller code.
 *
 * ## The ceiling, which is Electrum's and not ours
 *
 * There is no animated form. A PSBT that does not fit in one QR cannot reach
 * Electrum over a camera by any route, so `base43Frame` returns null rather
 * than emitting a code no scanner will resolve, and the screen says why. A
 * quiet truncation here would look like a broken camera.
 */

/** Electrum's alphabet, in Electrum's order. `__b43chars` in `bitcoin.py`. */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$*+-./:';

/**
 * The most alphanumeric characters a QR code can carry: version 40 at error
 * correction level L.
 *
 * Electrum's own reader gives up past 30,000 characters, but that limit is
 * never the binding one — no QR code holds that much. This is the real
 * ceiling, and it is quoted from the QR standard's capacity table rather than
 * measured, because it is a property of the format and not of any encoder.
 */
export const MAX_ALPHANUMERIC_QR_CHARS = 4296;

/**
 * Bytes to base43.
 *
 * Leading zero bytes are carried as leading `'0'` characters rather than
 * disappearing into the integer, which is the base58 convention and is what
 * Electrum's `base_encode` does. It matters here: a PSBT never starts with a
 * zero byte, but a wire that silently drops leading zeros is one that works
 * until the day it is pointed at something else.
 */
export function base43Encode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;

  let num = 0n;
  for (let i = leadingZeros; i < bytes.length; i++) num = num * 256n + BigInt(bytes[i]!);

  let out = '';
  while (num > 0n) {
    const digit = Number(num % 43n);
    num /= 43n;
    out = ALPHABET[digit]! + out;
  }

  return ALPHABET[0]!.repeat(leadingZeros) + out;
}

/**
 * Base43 back to bytes, or null if a character is not in the alphabet.
 *
 * Null rather than a throw, and rather than skipping the character: this
 * decodes something a camera saw, and a camera that misreads one symbol must
 * not produce bytes that look like a transaction.
 */
export function base43Decode(text: string): Uint8Array | null {
  let leadingZeros = 0;
  while (leadingZeros < text.length && text[leadingZeros] === ALPHABET[0]) leadingZeros++;

  let num = 0n;
  for (let i = leadingZeros; i < text.length; i++) {
    const digit = ALPHABET.indexOf(text[i]!);
    if (digit < 0) return null;
    num = num * 43n + BigInt(digit);
  }

  const body: number[] = [];
  while (num > 0n) {
    body.unshift(Number(num % 256n));
    num /= 256n;
  }

  const out = new Uint8Array(leadingZeros + body.length);
  out.set(body, leadingZeros);
  return out;
}

/**
 * The single frame to animate at Electrum, or null if it cannot be one frame.
 *
 * Returned as a one-element array so that callers hand it to the same QR
 * aperture as every other wire, and as null rather than an oversized string
 * because the alternative is a QR that no scanner resolves and nothing that
 * explains why.
 */
export function base43Frame(psbt: Uint8Array): string[] | null {
  const encoded = base43Encode(psbt);
  return encoded.length <= MAX_ALPHANUMERIC_QR_CHARS ? [encoded] : null;
}
