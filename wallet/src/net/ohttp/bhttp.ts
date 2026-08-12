/**
 * Binary HTTP, the known-length shape OHTTP carries.
 *
 * RFC 9292. An HTTP request or response as a byte string, so that it can be
 * sealed whole and handed to somebody who is not allowed to read it. Only the
 * known-length forms are here (framing indicators 0 and 1); the
 * indeterminate-length ones exist for streaming, and nothing in this product
 * streams through a relay.
 *
 * The integers are QUIC variable-length integers, which is where the odd
 * two-bit prefix comes from: the top two bits of the first byte say how many
 * bytes the whole number occupies, so small values cost one byte and the
 * encoding stays unambiguous.
 *
 * Truncation is part of the format rather than a shortcut. RFC 9292 lets an
 * encoder drop empty trailers, and empty content when the trailers are also
 * empty, and requires a decoder to read a missing section as zero length.
 * That is why RFC 9458's example request stops after the path and its example
 * response is three bytes.
 *
 * The split here is deliberate and not symmetric. **The decoder accepts
 * truncation; the encoder never produces it.** A decoder has to, because
 * that is a MUST in the RFC and real gateways send the short form. An encoder
 * does not have to, and the sections it would be dropping are two zero bytes,
 * so writing them out costs nothing and removes the question of whether some
 * other implementation reads the truncation rule as narrowly as it is
 * written. That is also what makes RFC 9292's own Figure 8 usable as a
 * byte-for-byte test of the encoder: the RFC prints the untruncated form.
 *
 * Reading a length is strict everywhere except those trailing sections. A
 * message that runs out halfway through the method or the authority is
 * damaged, not truncated, and returning an empty string for it would turn a
 * mangled request into a plausible one.
 */

export interface BRequest {
  method: string;
  scheme: string;
  authority: string;
  path: string;
  headers: [string, string][];
  body: Uint8Array;
}

export interface BResponse {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function varint(value: number): Uint8Array {
  if (value < 0) throw new Error('a length cannot be negative');
  if (value <= 63) return Uint8Array.from([value]);
  if (value <= 16383) return Uint8Array.from([0x40 | (value >> 8), value & 0xff]);
  if (value <= 1073741823) {
    return Uint8Array.from([0x80 | (value >> 24), (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
  }
  /* The eight-byte form. JavaScript numbers hold this exactly up to 2^53,
   * which is far past any message this product sends, and the high word is
   * written from the quotient rather than a shift so it does not wrap. */
  const high = Math.floor(value / 0x100000000);
  const low = value >>> 0;
  return Uint8Array.from([
    0xc0 | ((high >> 24) & 0x3f), (high >> 16) & 0xff, (high >> 8) & 0xff, high & 0xff,
    (low >> 24) & 0xff, (low >> 16) & 0xff, (low >> 8) & 0xff, low & 0xff,
  ]);
}

/** A cursor over the bytes, so every read moves one place and no other. */
class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.at >= this.bytes.length;
  }

  /** A length that has to be there. Running out here means damage. */
  varint(): number {
    if (this.done) throw new Error('a length was missing');
    const first = this.bytes[this.at]!;
    const length = 1 << (first >> 6);
    if (this.at + length > this.bytes.length) throw new Error('a length ran past the end');
    let value = first & 0x3f;
    for (let i = 1; i < length; i++) value = value * 256 + this.bytes[this.at + i]!;
    this.at += length;
    return value;
  }

  /** A length for a trailing section, which the encoder was allowed to drop. */
  varintOrZero(): number {
    return this.done ? 0 : this.varint();
  }

  take(length: number): Uint8Array {
    if (this.at + length > this.bytes.length) throw new Error('a field ran past the end');
    const out = this.bytes.slice(this.at, this.at + length);
    this.at += length;
    return out;
  }

  text(): string {
    return decoder.decode(this.take(this.varint()));
  }

  /** The rest, for a section whose length was already read. */
  slice(length: number): Reader {
    return new Reader(this.take(length));
  }
}

const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const field = (text: string): Uint8Array => {
  const raw = encoder.encode(text);
  return join(varint(raw.length), raw);
};

function fieldSection(headers: [string, string][]): Uint8Array {
  /* Field names are lowercase on the wire, which is what HTTP/2 and HTTP/3
   * already require and what keeps two encoders from producing different
   * bytes for the same message. */
  const body = join(...headers.map(([name, value]) => join(field(name.toLowerCase()), field(value))));
  return join(varint(body.length), body);
}

function readFieldSection(reader: Reader): [string, string][] {
  const length = reader.varintOrZero();
  if (length === 0) return [];
  const section = reader.slice(length);
  const headers: [string, string][] = [];
  while (!section.done) headers.push([section.text(), section.text()]);
  return headers;
}

/** A request, known-length: framing indicator 0. */
export function encodeRequest(request: BRequest): Uint8Array {
  return join(
    varint(0),
    field(request.method),
    field(request.scheme),
    field(request.authority),
    field(request.path),
    fieldSection(request.headers),
    varint(request.body.length),
    request.body,
    /* Trailers, always written and always empty. Nothing this product sends
     * has any, and see the note at the top for why they are still spelled
     * out rather than truncated away. */
    varint(0),
  );
}

export function decodeRequest(bytes: Uint8Array): BRequest {
  const reader = new Reader(bytes);
  const framing = reader.varint();
  if (framing !== 0) throw new Error(`expected a known-length request, got framing ${framing}`);
  const method = reader.text();
  const scheme = reader.text();
  const authority = reader.text();
  const path = reader.text();
  const headers = readFieldSection(reader);
  const bodyLength = reader.varintOrZero();
  const body = bodyLength === 0 ? new Uint8Array(0) : reader.take(bodyLength);
  return { method, scheme, authority, path, headers, body };
}

/** A response, known-length: framing indicator 1. */
export function encodeResponse(response: BResponse): Uint8Array {
  return join(
    varint(1),
    varint(response.status),
    fieldSection(response.headers),
    varint(response.body.length),
    response.body,
    varint(0),
  );
}

export function decodeResponse(bytes: Uint8Array): BResponse {
  const reader = new Reader(bytes);
  const framing = reader.varint();
  if (framing !== 1) throw new Error(`expected a known-length response, got framing ${framing}`);
  const status = reader.varint();
  /* Informational responses carry their own field section before the final
   * one. Nothing this product talks to sends them, and reading one as the
   * real response would be worse than saying so. */
  if (status >= 100 && status < 200) throw new Error('informational responses are not handled');
  const headers = readFieldSection(reader);
  const bodyLength = reader.varintOrZero();
  const body = bodyLength === 0 ? new Uint8Array(0) : reader.take(bodyLength);
  return { status, headers, body };
}
