/**
 * HPKE, base mode, the one ciphersuite Oblivious HTTP requires.
 *
 * RFC 9180, with DHKEM(X25519, HKDF-SHA256) for the KEM, HKDF-SHA256 for the
 * KDF and AES-128-GCM for the AEAD. That is the suite every OHTTP gateway
 * must support, so it is the only one written here: a second suite would be a
 * second set of constants nobody has checked against a vector.
 *
 * ## Why this is written out rather than imported
 *
 * The primitives are not. X25519 comes from `@noble/curves`, HKDF and SHA-256
 * from `@noble/hashes`, AES-GCM from `@noble/ciphers`, all of which this
 * project already ships and none of which is reimplemented here. What this
 * file adds is the labeling and the key schedule around them, which is
 * assembly rather than cryptography, and which has to run in two places that
 * cannot share a runtime: a React Native app with no `crypto.subtle`, and a
 * Cloudflare Worker. One implementation, used by both, tested once.
 *
 * ## What makes it trustworthy
 *
 * Not that it round-trips. A wrong implementation round-trips perfectly well
 * against itself, which is exactly the trap this project refused when it
 * built the Bulletproof+ verifier against real chain proofs before writing a
 * prover. Every intermediate value here is checked against RFC 9180's own
 * A.1 vectors: the shared secret, the key schedule context, the secret, the
 * key, the base nonce, the exporter secret, and four sealed messages at
 * different sequence numbers. If any label or any byte of framing were
 * wrong, those comparisons fail, and no amount of self-consistency would
 * hide it.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { extract, expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

/** The suite, by the numbers RFC 9180 assigns. */
export const KEM_X25519_HKDF_SHA256 = 0x0020;
export const KDF_HKDF_SHA256 = 0x0001;
export const AEAD_AES_128_GCM = 0x0001;

const Nsecret = 32;
const Nk = 16;
const Nn = 12;
const Nh = 32;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Big-endian, the only integer encoding RFC 9180 uses. */
export function i2osp(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  return out;
}

const HPKE_V1 = bytes('HPKE-v1');

/** `suite_id` for the KEM's own labeled operations. */
const kemSuite = concat(bytes('KEM'), i2osp(KEM_X25519_HKDF_SHA256, 2));

/** `suite_id` for the context's labeled operations. */
const hpkeSuite = concat(
  bytes('HPKE'),
  i2osp(KEM_X25519_HKDF_SHA256, 2),
  i2osp(KDF_HKDF_SHA256, 2),
  i2osp(AEAD_AES_128_GCM, 2),
);

function labeledExtract(suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Uint8Array {
  return extract(sha256, concat(HPKE_V1, suite, bytes(label), ikm), salt);
}

function labeledExpand(
  suite: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
): Uint8Array {
  return expand(sha256, prk, concat(i2osp(length, 2), HPKE_V1, suite, bytes(label), info), length);
}

/** DHKEM's `ExtractAndExpand`, shared by encap and decap. */
function extractAndExpand(dh: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const eaePrk = labeledExtract(kemSuite, new Uint8Array(0), 'eae_prk', dh);
  return labeledExpand(kemSuite, eaePrk, 'shared_secret', kemContext, Nsecret);
}

export interface Context {
  key: Uint8Array;
  baseNonce: Uint8Array;
  exporterSecret: Uint8Array;
}

/**
 * The key schedule, base mode only.
 *
 * `mode_base` is 0 and both the pre-shared key and its id are empty, which is
 * what collapses the general schedule in RFC 9180 into these few lines.
 */
export function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): Context {
  const empty = new Uint8Array(0);
  const pskIdHash = labeledExtract(hpkeSuite, empty, 'psk_id_hash', empty);
  const infoHash = labeledExtract(hpkeSuite, empty, 'info_hash', info);
  const context = concat(new Uint8Array([0x00]), pskIdHash, infoHash);

  const secret = labeledExtract(hpkeSuite, sharedSecret, 'secret', empty);
  return {
    key: labeledExpand(hpkeSuite, secret, 'key', context, Nk),
    baseNonce: labeledExpand(hpkeSuite, secret, 'base_nonce', context, Nn),
    exporterSecret: labeledExpand(hpkeSuite, secret, 'exp', context, Nh),
  };
}

/** The nonce for one message: the base nonce XOR the sequence number. */
export function nonceFor(baseNonce: Uint8Array, sequence: number): Uint8Array {
  const seq = i2osp(sequence, Nn);
  const out = new Uint8Array(Nn);
  for (let i = 0; i < Nn; i++) out[i] = (baseNonce[i] ?? 0) ^ (seq[i] ?? 0);
  return out;
}

/** A secret derived from the context, which OHTTP uses for the response key. */
export function exportSecret(context: Context, label: string, length: number): Uint8Array {
  return labeledExpand(hpkeSuite, context.exporterSecret, 'sec', bytes(label), length);
}

/**
 * Encapsulate to a recipient's public key.
 *
 * The ephemeral secret is an argument rather than generated inside, so the
 * RFC's vectors can be reproduced exactly. Callers that are not tests pass
 * fresh randomness, and `sealRequest` in ohttp.ts is the one that does.
 */
export function encap(
  recipientPublic: Uint8Array,
  ephemeralSecret: Uint8Array,
): { sharedSecret: Uint8Array; enc: Uint8Array } {
  const enc = x25519.getPublicKey(ephemeralSecret);
  const dh = x25519.getSharedSecret(ephemeralSecret, recipientPublic);
  return { sharedSecret: extractAndExpand(dh, concat(enc, recipientPublic)), enc };
}

/** The recipient's side of the same agreement. */
export function decap(enc: Uint8Array, recipientSecret: Uint8Array): Uint8Array {
  const dh = x25519.getSharedSecret(recipientSecret, enc);
  const recipientPublic = x25519.getPublicKey(recipientSecret);
  return extractAndExpand(dh, concat(enc, recipientPublic));
}

export function seal(context: Context, sequence: number, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return gcm(context.key, nonceFor(context.baseNonce, sequence), aad).encrypt(plaintext);
}

export function open(context: Context, sequence: number, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return gcm(context.key, nonceFor(context.baseNonce, sequence), aad).decrypt(ciphertext);
}

/** The public key for a secret, so a gateway can publish its configuration. */
export function publicKeyOf(secret: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secret);
}
