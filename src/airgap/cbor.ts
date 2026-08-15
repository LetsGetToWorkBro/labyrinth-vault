/**
 * Just enough CBOR for BC-UR.
 *
 * UR wraps its payload in CBOR, and its multi-part frames are a CBOR array of
 * five items. That is the entire vocabulary this file needs: unsigned
 * integers, byte strings, and one array. Maps, tags, text, floats, negative
 * numbers, indefinite lengths and the rest of RFC 8949 are not implemented,
 * because a signing device that accepts a richer grammar than it needs is
 * offering a parser to whoever is holding the other screen.
 *
 * Reading is therefore deliberately strict: anything outside the vocabulary,
 * any length prefix longer than it had to be, or any trailing byte after the
 * top-level item, is null rather than a best effort. On this wire an
 * unexpected shape is a misread frame, and the answer to a misread frame is
 * always to scan it again.
 */

/** The only things that can appear in a payload this file will read. */
export type CborValue = number | Uint8Array | CborValue[];

/**
 * What this file will *write*, which is deliberately more than it will read.
 *
 * The narrow reader above is a security argument and it still holds: a signing
 * device that accepts a richer grammar than it needs is offering a parser to
 * whoever is holding the other screen. Writing a richer grammar offers nobody
 * anything. Nothing parses what we emit except the wallet the person chose,
 * and the alternative to emitting maps and tags is not emitting `crypto-hdkey`
 * at all, which means no way to pair with Sparrow or Electrum by camera.
 *
 * So: maps, tags and booleans on the way out only. `cborRead` is untouched and
 * still refuses every one of them.
 */
export type CborWritable =
  | number
  | boolean
  | Uint8Array
  | CborWritable[]
  /** Ordered pairs, because BC-UR's maps have small integer keys in order. */
  | { map: Array<[number, CborWritable]> }
  | { tag: number; value: CborWritable };

// ---------------------------------------------------------------------------
// Writing

function head(major: number, length: number, out: number[]): void {
  const type = major << 5;
  if (length < 24) {
    out.push(type | length);
  } else if (length < 0x100) {
    out.push(type | 24, length);
  } else if (length < 0x10000) {
    out.push(type | 25, (length >>> 8) & 0xff, length & 0xff);
  } else {
    out.push(
      type | 26,
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
    );
  }
}

function write(value: CborValue, out: number[]): void {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error(`cbor: cannot write ${value}`);
    }
    head(0, value, out);
    return;
  }
  if (value instanceof Uint8Array) {
    head(2, value.length, out);
    for (const byte of value) out.push(byte);
    return;
  }
  if (Array.isArray(value)) {
    head(4, value.length, out);
    for (const item of value) write(item, out);
    return;
  }
  throw new Error('cbor: cannot write that');
}

export function cborEncode(value: CborValue): Uint8Array {
  const out: number[] = [];
  write(value, out);
  return new Uint8Array(out);
}

/** Major types beyond the reader's vocabulary, for output only. */
const MAJOR_MAP = 5;
const MAJOR_TAG = 6;

function writeRich(value: CborWritable, out: number[]): void {
  if (value === true || value === false) {
    // Major 7, simple values 21 and 20.
    out.push(0xe0 | (value ? 21 : 20));
    return;
  }
  if (typeof value === 'number' || value instanceof Uint8Array) {
    write(value as CborValue, out);
    return;
  }
  if (Array.isArray(value)) {
    head(4, value.length, out);
    for (const item of value) writeRich(item, out);
    return;
  }
  if ('map' in value) {
    head(MAJOR_MAP, value.map.length, out);
    for (const [key, item] of value.map) {
      head(0, key, out);
      writeRich(item, out);
    }
    return;
  }
  head(MAJOR_TAG, value.tag, out);
  writeRich(value.value, out);
}

/**
 * Encode a structure with maps and tags in it, for BC-UR's registry types.
 *
 * Separate from `cborEncode` so that the narrow type stays the one used by
 * everything on the receiving path, and reaching for this is a visible choice.
 */
export function cborWrite(value: CborWritable): Uint8Array {
  const out: number[] = [];
  writeRich(value, out);
  return new Uint8Array(out);
}

/** The common case: wrap raw bytes as a CBOR byte string. */
export function cborBytes(payload: Uint8Array): Uint8Array {
  return cborEncode(payload);
}

// ---------------------------------------------------------------------------
// Reading

interface Cursor {
  at: number;
}

function readHead(bytes: Uint8Array, cursor: Cursor): { major: number; length: number } | null {
  if (cursor.at >= bytes.length) return null;
  const initial = bytes[cursor.at++]!;
  const major = initial >>> 5;
  const info = initial & 31;
  if (info < 24) return { major, length: info };

  const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
  // 27 is a 64-bit length, and 28-31 are reserved or indefinite. Neither
  // appears in a UR frame, and neither is worth a code path here.
  if (width === 0) return null;
  if (cursor.at + width > bytes.length) return null;

  let length = 0;
  for (let i = 0; i < width; i++) length = length * 256 + bytes[cursor.at++]!;

  /* Canonical form only. A frame that spells 3 as `1a 00 00 00 03` is not one
   * any encoder produces, so it is a damaged read rather than a long-winded
   * one, and accepting it would mean two byte strings decode to the same
   * value. */
  const minimal = length < 24 ? 0 : length < 0x100 ? 1 : length < 0x10000 ? 2 : 4;
  if (width !== minimal) return null;
  return { major, length };
}

function read(bytes: Uint8Array, cursor: Cursor, depth: number): CborValue | null {
  if (depth > 4) return null; // nothing legitimate here nests
  const header = readHead(bytes, cursor);
  if (!header) return null;

  if (header.major === 0) return header.length;

  if (header.major === 2) {
    if (cursor.at + header.length > bytes.length) return null;
    const out = bytes.slice(cursor.at, cursor.at + header.length);
    cursor.at += header.length;
    return out;
  }

  if (header.major === 4) {
    const items: CborValue[] = [];
    for (let i = 0; i < header.length; i++) {
      const item = read(bytes, cursor, depth + 1);
      if (item === null) return null;
      items.push(item);
    }
    return items;
  }

  return null;
}

/** Read one CBOR item, or null if it is not one this file speaks. */
export function cborDecode(bytes: Uint8Array): CborValue | null {
  const cursor: Cursor = { at: 0 };
  const value = read(bytes, cursor, 0);
  if (value === null) return null;
  // Trailing bytes mean the frame was not what it claimed to be.
  if (cursor.at !== bytes.length) return null;
  return value;
}
