/**
 * Oblivious HTTP, both halves of it.
 *
 * RFC 9458. The point of the whole exercise is that no single machine ever
 * holds both halves of the fact worth hiding:
 *
 *   - the **relay**, run by somebody who is not us, sees the phone's IP
 *     address and a blob it cannot read;
 *   - the **gateway**, which is our Worker, decrypts the request and sees the
 *     trade, and sees the relay's address where the phone's would have been;
 *   - the exchange or the chain node sees the gateway, as it does today.
 *
 * Nobody in that chain can say who asked for what. That is a different and
 * much stronger claim than the one the relay makes on its own, which is only
 * that it writes nothing down. "We store nothing" is a promise. This is an
 * arrangement in which the promise is not needed.
 *
 * ## Both sides live in one file on purpose
 *
 * The client half runs on the phone and the gateway half runs in the Worker,
 * and they never run in the same process. They are written together anyway,
 * because the failure they have to avoid is disagreement: a header the client
 * builds one way and the gateway parses another is not a crash, it is a
 * decryption failure at the far end of a network with nothing useful to say
 * about why. Sharing the constants and the framing means the only way for
 * them to disagree is for both to be wrong in the same direction, which the
 * vectors below catch.
 *
 * ## What is checked
 *
 * RFC 9458 Appendix A is a complete worked exchange: gateway key, key
 * configuration, binary request, client ephemeral secret, info string,
 * encapsulated request, exported secret, response nonce, derived key and
 * nonce, and encapsulated response. `test/ohttp.test.ts` reproduces every one
 * of those byte strings. The ephemeral secret and the response nonce are
 * arguments here rather than drawn inside, which is what makes that possible;
 * callers that are not tests leave them out and get the platform CSPRNG.
 */

import { concat, i2osp, keySchedule, open, seal, exportSecret, decap, encap } from './hpke';
import { AEAD_AES_128_GCM, KDF_HKDF_SHA256, KEM_X25519_HKDF_SHA256 } from './hpke';
import type { Context } from './hpke';
import { gcm } from '@noble/ciphers/aes.js';
import { extract, expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const EMPTY = new Uint8Array(0);

/** Nenc for X25519, and Nk and Nn for AES-128-GCM. */
const Nenc = 32;
const Nk = 16;
const Nn = 12;

/** The response key derivation uses max(Nn, Nk) for both secret and nonce. */
const Nresponse = Math.max(Nn, Nk);

/** RFC 9458 4.3, and the exporter context from 4.4. */
const REQUEST_LABEL = 'message/bhttp request';
const RESPONSE_LABEL = 'message/bhttp response';

export interface Algorithm {
  kdfId: number;
  aeadId: number;
}

export interface KeyConfig {
  keyId: number;
  kemId: number;
  publicKey: Uint8Array;
  algorithms: Algorithm[];
}

/** The one combination this code implements, and the one every gateway must. */
export const SUPPORTED: Algorithm = { kdfId: KDF_HKDF_SHA256, aeadId: AEAD_AES_128_GCM };

export function encodeKeyConfig(config: KeyConfig): Uint8Array {
  const algorithms = concat(
    ...config.algorithms.map((a) => concat(i2osp(a.kdfId, 2), i2osp(a.aeadId, 2))),
  );
  return concat(
    i2osp(config.keyId, 1),
    i2osp(config.kemId, 2),
    config.publicKey,
    i2osp(algorithms.length, 2),
    algorithms,
  );
}

function read16(bytes: Uint8Array, at: number): number {
  if (at + 2 > bytes.length) throw new Error('the key configuration ended early');
  return (bytes[at]! << 8) | bytes[at + 1]!;
}

/**
 * One key configuration, from its own bytes.
 *
 * The public key's length comes from the KEM identifier, not from a length
 * field, which is why an unknown KEM has to be a refusal rather than a guess:
 * there is no way to skip past a key whose size is not known, and reading on
 * would silently reinterpret the rest of the structure.
 */
export function decodeKeyConfig(bytes: Uint8Array): KeyConfig {
  if (bytes.length < 3) throw new Error('the key configuration is too short');
  const keyId = bytes[0]!;
  const kemId = read16(bytes, 1);
  if (kemId !== KEM_X25519_HKDF_SHA256) {
    throw new Error(`this build only knows KEM ${KEM_X25519_HKDF_SHA256}, the configuration says ${kemId}`);
  }
  const publicKey = bytes.slice(3, 3 + Nenc);
  if (publicKey.length !== Nenc) throw new Error('the public key is the wrong length');
  const length = read16(bytes, 3 + Nenc);
  const at = 5 + Nenc;
  if (length % 4 !== 0) throw new Error('the algorithm list is not a whole number of pairs');
  if (at + length > bytes.length) throw new Error('the algorithm list runs past the end');
  const algorithms: Algorithm[] = [];
  for (let i = 0; i < length; i += 4) {
    algorithms.push({ kdfId: read16(bytes, at + i), aeadId: read16(bytes, at + i + 2) });
  }
  return { keyId, kemId, publicKey, algorithms };
}

/** The `application/ohttp-keys` list: each configuration behind a 2-byte length. */
export function encodeKeyList(configs: KeyConfig[]): Uint8Array {
  return concat(
    ...configs.map((config) => {
      const encoded = encodeKeyConfig(config);
      return concat(i2osp(encoded.length, 2), encoded);
    }),
  );
}

/**
 * The same list, read back.
 *
 * A collection that does not parse cleanly is discarded whole rather than
 * salvaged. RFC 9458 asks for that, and the reason is worth keeping in mind:
 * two clients that recovered different subsets of a damaged list would send
 * distinguishable traffic, which is a way to sort people into groups, which
 * is the exact thing this protocol exists to prevent.
 */
export function decodeKeyList(bytes: Uint8Array): KeyConfig[] {
  const configs: KeyConfig[] = [];
  let at = 0;
  while (at < bytes.length) {
    const length = read16(bytes, at);
    at += 2;
    if (at + length > bytes.length) throw new Error('a key configuration runs past the end of the list');
    configs.push(decodeKeyConfig(bytes.slice(at, at + length)));
    at += length;
  }
  return configs;
}

/** Whether a configuration offers the suite this code can actually use. */
export function usable(config: KeyConfig): boolean {
  return (
    config.kemId === KEM_X25519_HKDF_SHA256 &&
    config.algorithms.some((a) => a.kdfId === SUPPORTED.kdfId && a.aeadId === SUPPORTED.aeadId)
  );
}

function header(keyId: number, algorithm: Algorithm): Uint8Array {
  return concat(
    i2osp(keyId, 1),
    i2osp(KEM_X25519_HKDF_SHA256, 2),
    i2osp(algorithm.kdfId, 2),
    i2osp(algorithm.aeadId, 2),
  );
}

/** `info` is the label, a zero byte, then the header. Both sides build it. */
function requestInfo(hdr: Uint8Array): Uint8Array {
  return concat(utf8(REQUEST_LABEL), new Uint8Array([0x00]), hdr);
}

const randomBytes = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));

/**
 * What a client keeps after sealing: the bytes to send, and what it needs to
 * open the answer.
 *
 * The context and `enc` are not incidental. The response is encrypted under a
 * key derived from this exchange, so a client that threw them away could send
 * a request it could never read the reply to.
 */
export interface SealedRequest {
  body: Uint8Array;
  context: Context;
  enc: Uint8Array;
}

/** Client side: a binary HTTP request in, an `message/ohttp-req` body out. */
export function sealRequest(
  config: KeyConfig,
  request: Uint8Array,
  ephemeralSecret: Uint8Array = randomBytes(32),
): SealedRequest {
  if (!usable(config)) throw new Error('that gateway does not offer a suite this build can use');
  const hdr = header(config.keyId, SUPPORTED);
  const { sharedSecret, enc } = encap(config.publicKey, ephemeralSecret);
  const context = keySchedule(sharedSecret, requestInfo(hdr));
  /* Sequence zero, and only ever zero: one request per context. A second
   * Seal on the same context would be a second message, and this protocol
   * does not have those. */
  const ct = seal(context, 0, EMPTY, request);
  return { body: concat(hdr, enc, ct), context, enc };
}

export interface OpenedRequest {
  request: Uint8Array;
  context: Context;
  enc: Uint8Array;
  keyId: number;
}

/**
 * Gateway side: an `message/ohttp-req` body in, the binary HTTP back.
 *
 * Everything that could be wrong is checked before any key is touched, and
 * every failure is the same shape: a thrown error the caller turns into a
 * flat rejection. A gateway that answered differently for "unknown key id"
 * and "decryption failed" would be telling whoever probed it which keys
 * exist, and this one has no reason to.
 */
export function openRequest(secretKey: Uint8Array, keyId: number, body: Uint8Array): OpenedRequest {
  if (body.length < 7 + Nenc) throw new Error('the encapsulated request is too short');
  const hdr = body.slice(0, 7);
  const gotKeyId = hdr[0]!;
  const kemId = read16(hdr, 1);
  const kdfId = read16(hdr, 3);
  const aeadId = read16(hdr, 5);
  if (gotKeyId !== keyId) throw new Error('that is not this gateway key');
  if (kemId !== KEM_X25519_HKDF_SHA256) throw new Error('unsupported KEM');
  if (kdfId !== SUPPORTED.kdfId || aeadId !== SUPPORTED.aeadId) throw new Error('unsupported KDF or AEAD');

  const enc = body.slice(7, 7 + Nenc);
  const ct = body.slice(7 + Nenc);
  const context = keySchedule(decap(enc, secretKey), requestInfo(hdr));
  return { request: open(context, 0, EMPTY, ct), context, enc, keyId };
}

/**
 * The response key, which both sides derive the same way from what they
 * already have.
 *
 * Note what is *not* here: the HPKE sequence number and the base nonce. The
 * response does not reuse the request's AEAD context, it uses an exported
 * secret salted with a fresh nonce, so that a gateway which somehow reused a
 * request context could not also reuse a response key. The Extract and Expand
 * are plain HKDF with plain "key" and "nonce" labels, not HPKE's labeled
 * pair, which is the one place in this file where the obvious guess is wrong.
 */
function responseKey(context: Context, enc: Uint8Array, responseNonce: Uint8Array): {
  key: Uint8Array;
  nonce: Uint8Array;
} {
  const secret = exportSecret(context, RESPONSE_LABEL, Nresponse);
  const prk = extract(sha256, secret, concat(enc, responseNonce));
  return {
    key: expand(sha256, prk, utf8('key'), Nk),
    nonce: expand(sha256, prk, utf8('nonce'), Nn),
  };
}

/** Gateway side: a binary HTTP response in, an `message/ohttp-res` body out. */
export function sealResponse(
  context: Context,
  enc: Uint8Array,
  response: Uint8Array,
  responseNonce: Uint8Array = randomBytes(Nresponse),
): Uint8Array {
  if (responseNonce.length !== Nresponse) throw new Error('the response nonce is the wrong length');
  const { key, nonce } = responseKey(context, enc, responseNonce);
  return concat(responseNonce, gcm(key, nonce).encrypt(response));
}

/** Client side, the last step: the answer, or an error if it was touched. */
export function openResponse(context: Context, enc: Uint8Array, body: Uint8Array): Uint8Array {
  if (body.length <= Nresponse) throw new Error('the encapsulated response is too short');
  const responseNonce = body.slice(0, Nresponse);
  const { key, nonce } = responseKey(context, enc, responseNonce);
  return gcm(key, nonce).decrypt(body.slice(Nresponse));
}
