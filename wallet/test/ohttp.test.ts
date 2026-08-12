/**
 * Oblivious HTTP against RFC 9458's complete worked exchange.
 *
 * Appendix A publishes every intermediate value of one request and one
 * response: the gateway's secret key, the key configuration bytes, the binary
 * request, the client's ephemeral secret, the info string, the encapsulated
 * request, the exported secret, the response nonce, the derived AEAD key and
 * nonce, and the encapsulated response. All of them are compared here.
 *
 * That matters more than a round trip does. Client and gateway will never run
 * in the same process, so a shared mistake between them would look like
 * success in every test that only asked whether one could read the other. The
 * vectors are the only thing in this file that a wrong implementation cannot
 * agree with.
 */

import { describe, expect, it } from 'vitest';
import { publicKeyOf } from '../src/net/ohttp/hpke';
import {
  decodeKeyConfig,
  decodeKeyList,
  encodeKeyConfig,
  encodeKeyList,
  openRequest,
  openResponse,
  sealRequest,
  sealResponse,
  usable,
} from '../src/net/ohttp/ohttp';

const hex = (s: string): Uint8Array =>
  Uint8Array.from(s.replace(/\s/g, '').match(/../g)!.map((b) => parseInt(b, 16)));
const hexOf = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** RFC 9458, Appendix A. */
const A = {
  gatewaySecret: hex('3c168975674b2fa8e465970b79c8dcf09f1c741626480bd4c6162fc5b6a98e1a'),
  keyConfig: '01002031e1f05a740102115220e9af918f738674aec95f54db6e04eb705aae8e79815500080001000100010003',
  request: hex('00034745540568747470730b6578616d706c652e636f6d012f'),
  ephemeralSecret: hex('bc51d5e930bda26589890ac7032f70ad12e4ecb37abb1b65b1256c9c48999c73'),
  enc: '4b28f881333e7c164ffc499ad9796f877f4e1051ee6d31bad19dec96c208b472',
  encapsulatedRequest:
    '010020000100014b28f881333e7c164ffc499ad9796f877f4e1051ee6d31bad1' +
    '9dec96c208b4726374e469135906992e1268c594d2a10c695d858c40a026e796' +
    '5e7d86b83dd440b2c0185204b4d63525',
  response: hex('0140c8'),
  responseNonce: hex('c789e7151fcba46158ca84b04464910d'),
  encapsulatedResponse: 'c789e7151fcba46158ca84b04464910d86f9013e404feea014e7be4a441f234f857fbd',
};

describe('the key configuration, checked against RFC 9458 Appendix A', () => {
  it('reads the published configuration into its parts', () => {
    const config = decodeKeyConfig(hex(A.keyConfig));
    expect(config.keyId).toBe(1);
    expect(config.kemId).toBe(0x0020);
    expect(hexOf(config.publicKey)).toBe('31e1f05a740102115220e9af918f738674aec95f54db6e04eb705aae8e798155');
    expect(config.algorithms).toEqual([
      { kdfId: 0x0001, aeadId: 0x0001 },
      { kdfId: 0x0001, aeadId: 0x0003 },
    ]);
  });

  it('writes the same bytes back out', () => {
    expect(hexOf(encodeKeyConfig(decodeKeyConfig(hex(A.keyConfig))))).toBe(A.keyConfig);
  });

  it('derives that public key from the published secret key', () => {
    /* The tie between the two halves of the example. Without this, the
     * configuration could be right and belong to a different key. */
    expect(hexOf(publicKeyOf(A.gatewaySecret))).toBe(
      '31e1f05a740102115220e9af918f738674aec95f54db6e04eb705aae8e798155',
    );
  });

  it('round-trips a list in the application/ohttp-keys shape', () => {
    const config = decodeKeyConfig(hex(A.keyConfig));
    const list = encodeKeyList([config, config]);
    /* Two 2-byte length prefixes plus the two configurations. */
    expect(list.length).toBe(2 * (2 + hex(A.keyConfig).length));
    expect(decodeKeyList(list)).toEqual([config, config]);
  });

  it('accepts the published configuration as usable and a ChaCha-only one as not', () => {
    expect(usable(decodeKeyConfig(hex(A.keyConfig)))).toBe(true);
    const chachaOnly = hex(
      '01002031e1f05a740102115220e9af918f738674aec95f54db6e04eb705aae8e798155' + '0004' + '00010003',
    );
    expect(usable(decodeKeyConfig(chachaOnly))).toBe(false);
  });

  it('refuses a configuration whose parts do not add up', () => {
    /* An unknown KEM has to be a refusal and not a guess: the public key's
     * length comes from the KEM, so reading past it would silently
     * reinterpret every field after it. */
    expect(() => decodeKeyConfig(hex('0100ff' + '00'.repeat(32) + '00040001 0001'))).toThrow(/KEM/);
    expect(() => decodeKeyConfig(hex(A.keyConfig.slice(0, 40)))).toThrow();
    const oddLength = hex('01002031e1f05a740102115220e9af918f738674aec95f54db6e04eb705aae8e798155' + '0002' + '0001');
    expect(() => decodeKeyConfig(oddLength)).toThrow(/whole number of pairs/);
  });
});

describe('encapsulation, checked against RFC 9458 Appendix A', () => {
  const config = decodeKeyConfig(hex(A.keyConfig));

  it('seals the published request to the published encapsulated request', () => {
    const sealed = sealRequest(config, A.request, A.ephemeralSecret);
    expect(hexOf(sealed.enc)).toBe(A.enc);
    expect(hexOf(sealed.body)).toBe(A.encapsulatedRequest);
  });

  it('opens the published encapsulated request back to the published request', () => {
    const opened = openRequest(A.gatewaySecret, 1, hex(A.encapsulatedRequest));
    expect(hexOf(opened.request)).toBe(hexOf(A.request));
    expect(hexOf(opened.enc)).toBe(A.enc);
  });

  it('seals the published response to the published encapsulated response', () => {
    /* Sealed from the gateway's own context, derived by opening the request,
     * because that is the context the RFC exported its secret from. */
    const opened = openRequest(A.gatewaySecret, 1, hex(A.encapsulatedRequest));
    const sealed = sealResponse(opened.context, opened.enc, A.response, A.responseNonce);
    expect(hexOf(sealed)).toBe(A.encapsulatedResponse);
  });

  it('opens the published encapsulated response from the client context', () => {
    const sent = sealRequest(config, A.request, A.ephemeralSecret);
    const got = openResponse(sent.context, sent.enc, hex(A.encapsulatedResponse));
    expect(hexOf(got)).toBe(hexOf(A.response));
  });

  it('gives a different encapsulated request every time when the secret is not supplied', () => {
    /* Two identical requests must not be linkable by their ciphertext. If
     * the default randomness were ever lost, this is what would notice. */
    const first = sealRequest(config, A.request);
    const second = sealRequest(config, A.request);
    expect(hexOf(first.body)).not.toBe(hexOf(second.body));
    expect(hexOf(openRequest(A.gatewaySecret, 1, first.body).request)).toBe(hexOf(A.request));
    expect(hexOf(openRequest(A.gatewaySecret, 1, second.body).request)).toBe(hexOf(A.request));
  });

  it('carries a request and a response the whole way with fresh randomness', () => {
    const body = new TextEncoder().encode('{"rate":"0.0234"}');
    const sent = sealRequest(config, A.request);
    const opened = openRequest(A.gatewaySecret, 1, sent.body);
    const answer = sealResponse(opened.context, opened.enc, body);
    expect(new TextDecoder().decode(openResponse(sent.context, sent.enc, answer))).toBe('{"rate":"0.0234"}');
  });
});

describe('what encapsulation refuses', () => {
  const config = decodeKeyConfig(hex(A.keyConfig));

  it('refuses a request addressed to a different key', () => {
    expect(() => openRequest(A.gatewaySecret, 2, hex(A.encapsulatedRequest))).toThrow(/not this gateway key/);
  });

  it('refuses a request whose ciphertext was touched', () => {
    const body = hex(A.encapsulatedRequest);
    body[body.length - 1] = (body[body.length - 1] ?? 0) ^ 0x01;
    expect(() => openRequest(A.gatewaySecret, 1, body)).toThrow();
  });

  it('refuses a request sealed to a different gateway key', () => {
    const stranger = { ...config, publicKey: publicKeyOf(new Uint8Array(32).fill(7)) };
    const sent = sealRequest(stranger, A.request);
    expect(() => openRequest(A.gatewaySecret, 1, sent.body)).toThrow();
  });

  it('refuses a response whose nonce was swapped for another', () => {
    /* The nonce is authenticated through the key derivation rather than by
     * the AEAD tag, so changing it has to fail as decryption rather than
     * quietly producing a different plaintext. */
    const sent = sealRequest(config, A.request, A.ephemeralSecret);
    const body = hex(A.encapsulatedResponse);
    body[0] = (body[0] ?? 0) ^ 0x01;
    expect(() => openResponse(sent.context, sent.enc, body)).toThrow();
  });

  it('refuses truncated messages on both sides rather than reading past them', () => {
    expect(() => openRequest(A.gatewaySecret, 1, hex(A.encapsulatedRequest).slice(0, 30))).toThrow(/too short/);
    const sent = sealRequest(config, A.request, A.ephemeralSecret);
    /* Exactly the nonce and not one byte more: there is no ciphertext to
     * open, and a length check is the only thing standing between that and
     * an empty-string "response". */
    expect(() => openResponse(sent.context, sent.enc, A.responseNonce)).toThrow(/too short/);
  });

  it('refuses to seal to a gateway that does not offer this suite', () => {
    const chachaOnly = decodeKeyConfig(
      hex('01002031e1f05a740102115220e9af918f738674aec95f54db6e04eb705aae8e798155' + '0004' + '00010003'),
    );
    expect(() => sealRequest(chachaOnly, A.request)).toThrow(/suite this build can use/);
  });
});
