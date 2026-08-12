/**
 * Binary HTTP against RFC 9292's printed bytes.
 *
 * The encoder is checked against Figure 8, which is a real request with real
 * header fields, so a wrong varint boundary or a field written in the wrong
 * order shows up as a mismatch. The decoder is checked against the truncated
 * forms the RFCs actually put on the wire, because that is the shape a real
 * gateway will send back and a decoder that only ever read its own encoder's
 * output would fail the first time it met one.
 */

import { describe, expect, it } from 'vitest';
import { decodeRequest, decodeResponse, encodeRequest, encodeResponse, varint } from '../src/net/ohttp/bhttp';

const hex = (s: string): Uint8Array =>
  Uint8Array.from(s.replace(/\s/g, '').match(/../g)!.map((b) => parseInt(b, 16)));
const hexOf = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/**
 * RFC 9292, Figure 8: the known-length encoding of the Figure 7 request,
 * copied in the RFC's own four-byte groups so it can be compared against the
 * page rather than retyped.
 */
const FIGURE_8 = [
  '00034745 54056874 74707300 0a2f6865',
  '6c6c6f2e 74787440 6c0a7573 65722d61',
  '67656e74 34637572 6c2f372e 31362e33',
  '206c6962 6375726c 2f372e31 362e3320',
  '4f70656e 53534c2f 302e392e 376c207a',
  '6c69622f 312e322e 3304686f 73740f77',
  '77772e65 78616d70 6c652e63 6f6d0f61',
  '63636570 742d6c61 6e677561 67650665',
  '6e2c206d 690000',
].join('');

describe('binary HTTP, checked against RFC 9292', () => {
  it('encodes the RFC 9292 Figure 7 request to the Figure 8 bytes', () => {
    const encoded = encodeRequest({
      method: 'GET',
      scheme: 'https',
      authority: '',
      path: '/hello.txt',
      headers: [
        ['User-Agent', 'curl/7.16.3 libcurl/7.16.3 OpenSSL/0.9.7l zlib/1.2.3'],
        ['Host', 'www.example.com'],
        ['Accept-Language', 'en, mi'],
      ],
      body: new Uint8Array(0),
    });
    expect(hexOf(encoded)).toBe(hexOf(hex(FIGURE_8)));
  });

  it('reads its own Figure 8 bytes back to the same message', () => {
    const decoded = decodeRequest(hex(FIGURE_8));
    expect(decoded.method).toBe('GET');
    expect(decoded.scheme).toBe('https');
    expect(decoded.authority).toBe('');
    expect(decoded.path).toBe('/hello.txt');
    /* Lowercase on the wire, which is what the encoder wrote. */
    expect(decoded.headers).toEqual([
      ['user-agent', 'curl/7.16.3 libcurl/7.16.3 OpenSSL/0.9.7l zlib/1.2.3'],
      ['host', 'www.example.com'],
      ['accept-language', 'en, mi'],
    ]);
    expect(decoded.body.length).toBe(0);
  });

  it('reads the truncated request from RFC 9458, where every trailing section is gone', () => {
    /* Field section, content and trailers are all absent. This is the shape
     * OHTTP's own example uses, so tolerating it is not a nicety. */
    const decoded = decodeRequest(hex('00034745540568747470730b6578616d706c652e636f6d012f'));
    expect(decoded).toEqual({
      method: 'GET',
      scheme: 'https',
      authority: 'example.com',
      path: '/',
      headers: [],
      body: new Uint8Array(0),
    });
  });

  it('reads the three-byte response from RFC 9458', () => {
    const decoded = decodeResponse(hex('0140c8'));
    expect(decoded.status).toBe(200);
    expect(decoded.headers).toEqual([]);
    expect(decoded.body.length).toBe(0);
  });

  it('round-trips a response with headers and a body', () => {
    const body = new TextEncoder().encode('{"rate":"0.0234"}');
    const encoded = encodeResponse({
      status: 200,
      headers: [['Content-Type', 'application/json']],
      body,
    });
    const decoded = decodeResponse(encoded);
    expect(decoded.status).toBe(200);
    expect(decoded.headers).toEqual([['content-type', 'application/json']]);
    expect(new TextDecoder().decode(decoded.body)).toBe('{"rate":"0.0234"}');
  });

  it('encodes the varint boundaries where the byte count changes', () => {
    /* One below and one above each threshold, because an off-by-one at a
     * boundary is the failure this encoding invites. */
    expect(hexOf(varint(0))).toBe('00');
    expect(hexOf(varint(63))).toBe('3f');
    expect(hexOf(varint(64))).toBe('4040');
    expect(hexOf(varint(16383))).toBe('7fff');
    expect(hexOf(varint(16384))).toBe('80004000');
    expect(hexOf(varint(1073741823))).toBe('bfffffff');
    expect(hexOf(varint(1073741824))).toBe('c000000040000000');
  });

  it('refuses a message that stops halfway through its control data', () => {
    /* Framing, method, scheme, and then nothing. That is damage, not
     * truncation: only the trailing sections may be dropped, and reading an
     * empty authority here would turn a mangled request into a plausible
     * one aimed at the wrong place. */
    expect(() => decodeRequest(hex('00034745540568747470 73'))).toThrow(/missing/);
    /* And one that stops inside a field it did announce a length for. */
    expect(() => decodeRequest(hex('00034745540568747470 730b 6578616d706c65'))).toThrow(/past the end/);
  });

  it('refuses the wrong framing indicator in either direction', () => {
    expect(() => decodeRequest(hex('0140c8'))).toThrow(/known-length request/);
    expect(() => decodeResponse(hex('00034745540568747470730b6578616d706c652e636f6d012f'))).toThrow(
      /known-length response/,
    );
  });

  it('refuses an informational response rather than reading it as the real one', () => {
    expect(() => decodeResponse(hex('014064'))).toThrow(/informational/);
  });
});
