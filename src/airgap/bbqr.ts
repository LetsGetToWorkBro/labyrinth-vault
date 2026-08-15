/**
 * BBQr: what Coldcard animates, because Coldcard does not read BC-UR.
 *
 * ## Why a third QR format
 *
 * ur.ts covers the Blockchain Commons half of the world: Sparrow, Keystone,
 * Passport, BlueWallet. base43.ts covers Electrum, which reads no animated
 * format at all. Neither reaches a Coldcard Q: a search of the Coldcard
 * firmware for `ur:` finds nothing, and its scanner takes BBQr or a bare
 * single QR and that is the list.
 *
 * BBQr is Coinkite's, specified at bbqr.info, and it is not Coldcard-only —
 * Sparrow, Nunchuk and BlueWallet all decode it. So this is the frame format
 * with the widest reach of the three, and the one to reach for when the other
 * two do not fit.
 *
 * ## The format, which is eight characters and then a body
 *
 *     B$          fixed
 *     2           encoding: H hex, 2 base32, Z deflate-then-base32
 *     P           file type: P PSBT, T transaction, J JSON, U text, C CBOR
 *     05          total parts, two digits base 36
 *     00          which part this is, two digits base 36
 *     ...         the body
 *
 * Everything in that is inside the QR alphanumeric character set, which is the
 * point: alphanumeric mode packs 5.5 bits per character where byte mode packs
 * 8, so base32-in-alphanumeric beats base64-in-bytes despite base32 being the
 * worse encoding on paper. Same trick as Electrum's base43.
 *
 * ## Why encoding `2` and not `Z`
 *
 * `Z` is deflate at `wbits=10` before the base32, and the spec is explicit
 * that a *sender* may choose: "For QR creators, they are free to pick the
 * encoding they prefer", and "Always use the Zlib encoding to save space, but
 * if you don't want to implement it... don't." Receivers must implement all
 * three.
 *
 * So `2` costs some frames and buys not having a DEFLATE implementation in
 * this repository. That is not laziness about size — it is that
 * `test/supply-chain.test.ts` holds the dependency list to the audited
 * noble/scure family, and the alternative to a new dependency is several
 * hundred lines of compressor whose bugs would be indistinguishable from a
 * camera misread. A PSBT is mostly keys and hashes anyway, which is the case
 * the spec itself warns compresses badly.
 *
 * ## What this file is not
 *
 * It is not a checksum layer. BBQr deliberately has none, because a QR code
 * carries its own error correction and a symbol that decodes decodes
 * correctly. And as everywhere else in this project: a payload that
 * reassembles is not a payload that is safe to sign.
 */

/** RFC 4648 base32, which is what BBQr's `2` and `Z` encodings use. */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Two digits of base 36, upper case, as the header wants them. */
const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The header is always this long, and the body starts right after it. */
export const BBQR_HEADER_LENGTH = 8;

/**
 * The file types this app has any business emitting or accepting.
 *
 * The registry has more (`X` executable, `B` binary, and Coldcard's own
 * key-teleport codes). They are left out because a signing device that will
 * animate an arbitrary blob at you is a signing device with a category of bug
 * this one does not need.
 */
export const BBQR_TYPES = {
  psbt: 'P',
  transaction: 'T',
  json: 'J',
  text: 'U',
  cbor: 'C',
} as const;

export type BbqrType = (typeof BBQR_TYPES)[keyof typeof BBQR_TYPES];

const KNOWN_TYPES: string[] = Object.values(BBQR_TYPES);

/**
 * Body characters per frame.
 *
 * 320 base32 characters is 200 bytes, which is the fragment size ur.ts already
 * chose for the same screen and the same camera. One number for both wires
 * rather than two that drift; if it is wrong it is wrong visibly and in one
 * place.
 *
 * It must stay a multiple of 8. Base32 packs five bytes into eight characters,
 * and BBQr requires every part except the last to decode to a whole number of
 * bytes, so a part length off the 8-character grid produces frames that a
 * conforming receiver is right to reject.
 */
export const BBQR_BODY_CHARS = 320;

/** 36 * 36 two-digit base-36 codes, and the last index must fit. */
const MAX_PARTS = 36 * 36;

// ---------------------------------------------------------------------------
// Base32, without padding

function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  /* The leftover bits are left-aligned into one final character. No `=`: BBQr
   * forbids the padding character outright, and it is not in the QR
   * alphanumeric set to begin with. */
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Uint8Array | null {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = BASE32.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  /* Whatever is left is the left-aligned tail of the last character and must
   * be zero. A non-zero remainder means the text was truncated mid-symbol, so
   * refuse rather than hand back bytes that are one bit short of a key. */
  if (bits >= 5 || (buffer & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

function base36Pair(n: number): string {
  return BASE36[Math.floor(n / 36)]! + BASE36[n % 36]!;
}

function readBase36Pair(text: string): number | null {
  const high = BASE36.indexOf(text[0]!);
  const low = BASE36.indexOf(text[1]!);
  if (high < 0 || low < 0) return null;
  return high * 36 + low;
}

// ---------------------------------------------------------------------------
// Encoding

/**
 * Split a payload into BBQr frames.
 *
 * Every frame carries the same number of body characters except the last, and
 * that is required rather than tidy: a receiver that sees any frame but the
 * last one first can size its buffer immediately, which is what lets a
 * hardware wallet with 200 KB of RAM accept a 100 KB PSBT.
 *
 * Returns null if the payload would need more than 1,296 frames, which is what
 * two base-36 digits can count.
 */
export function bbqrEncode(
  payload: Uint8Array,
  type: BbqrType,
  bodyChars: number = BBQR_BODY_CHARS,
): string[] | null {
  if (bodyChars % 8 !== 0 || bodyChars < 8) return null;

  const encoded = base32Encode(payload);
  /* An empty payload is still one frame. A series claiming zero parts is not
   * representable in the header and no receiver expects it. */
  const parts = Math.max(1, Math.ceil(encoded.length / bodyChars));
  if (parts > MAX_PARTS) return null;

  const frames: string[] = [];
  for (let i = 0; i < parts; i++) {
    const body = encoded.slice(i * bodyChars, (i + 1) * bodyChars);
    frames.push(`B$2${type}${base36Pair(parts)}${base36Pair(i)}${body}`);
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Decoding

export interface BbqrPart {
  encoding: string;
  type: string;
  parts: number;
  index: number;
  body: string;
}

/**
 * Parse one frame's header, or null.
 *
 * Everything here is a refusal rather than a repair. This runs on whatever a
 * camera resolved, and the cost of guessing at a malformed header is a
 * reassembled payload that is subtly not the one on the other screen.
 */
export function bbqrParsePart(frame: string): BbqrPart | null {
  if (frame.length < BBQR_HEADER_LENGTH) return null;
  if (frame.slice(0, 2) !== 'B$') return null;

  const encoding = frame[2]!;
  const type = frame[3]!;
  if (!KNOWN_TYPES.includes(type)) return null;

  const parts = readBase36Pair(frame.slice(4, 6));
  const index = readBase36Pair(frame.slice(6, 8));
  if (parts === null || index === null) return null;
  if (parts < 1 || index < 0 || index >= parts) return null;

  return { encoding, type, parts, index, body: frame.slice(BBQR_HEADER_LENGTH) };
}

export interface BbqrMessage {
  type: string;
  bytes: Uint8Array;
}

/**
 * Reassemble a complete BBQr series.
 *
 * Returns null unless every frame agrees on encoding, type and count, every
 * index is present exactly once, and the body decodes. Duplicates of the same
 * index are allowed and ignored only when they are identical — two different
 * bodies claiming the same position mean two different messages got mixed, and
 * picking one would be a coin flip over what gets signed.
 *
 * `Z` is refused with the rest: this reader has no DEFLATE, and pretending
 * otherwise would hand back compressed bytes as if they were a PSBT.
 */
export function bbqrDecode(frames: string[]): BbqrMessage | null {
  if (frames.length === 0) return null;

  const first = bbqrParsePart(frames[0]!);
  if (!first) return null;
  if (first.encoding !== '2' && first.encoding !== 'H') return null;

  const bodies = new Map<number, string>();
  for (const frame of frames) {
    const part = bbqrParsePart(frame);
    if (!part) return null;
    if (part.encoding !== first.encoding) return null;
    if (part.type !== first.type) return null;
    if (part.parts !== first.parts) return null;

    const seen = bodies.get(part.index);
    if (seen !== undefined && seen !== part.body) return null;
    bodies.set(part.index, part.body);
  }

  if (bodies.size !== first.parts) return null;

  let joined = '';
  for (let i = 0; i < first.parts; i++) {
    const body = bodies.get(i);
    if (body === undefined) return null;
    joined += body;
  }

  const bytes = first.encoding === 'H' ? hexDecode(joined) : base32Decode(joined);
  if (!bytes) return null;
  return { type: first.type, bytes };
}

/** BBQr's `H` encoding is upper-case hex, and only upper-case. */
function hexDecode(text: string): Uint8Array | null {
  if (text.length % 2 !== 0) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    const pair = text.slice(i * 2, i * 2 + 2);
    if (!/^[0-9A-F]{2}$/.test(pair)) return null;
    out[i] = parseInt(pair, 16);
  }
  return out;
}
