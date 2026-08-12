/**
 * HPKE against RFC 9180's own numbers.
 *
 * A round trip proves nothing here: a wrong implementation round-trips
 * against itself perfectly. What these check is every intermediate value in
 * A.1, so a mislabeled Extract or a byte out of place in the framing shows
 * up as a mismatch rather than as a system that quietly encrypts to a key
 * nobody else can derive.
 */

import { describe, expect, it } from 'vitest';
import { decap, encap, exportSecret, keySchedule, nonceFor, open, publicKeyOf, seal } from '../src/net/ohttp/hpke';

const hex = (s: string): Uint8Array =>
  Uint8Array.from(s.replace(/\s/g, '').match(/../g)!.map((b) => parseInt(b, 16)));
const hexOf = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** RFC 9180, A.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM. */
const A1 = {
  info: hex('4f6465206f6e2061204772656369616e2055726e'),
  skEm: hex('52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736'),
  pkEm: hex('37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431'),
  skRm: hex('4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8'),
  pkRm: hex('3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d'),
  sharedSecret: 'fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc',
  secretKey: '4531685d41d65f03dc48f6b8302c05b0',
  baseNonce: '56d890e5accaaf011cff4b7d',
  exporterSecret: '45ff1c2e220db587171952c0592d5f5ebe103f1561a2614e38f2ffd47e99e3f8',
};

describe('HPKE, checked against RFC 9180 A.1', () => {
  it('derives the public keys the RFC publishes', () => {
    expect(hexOf(publicKeyOf(A1.skEm))).toBe(hexOf(A1.pkEm));
    expect(hexOf(publicKeyOf(A1.skRm))).toBe(hexOf(A1.pkRm));
  });

  it('encapsulates to the published shared secret and enc', () => {
    const { sharedSecret, enc } = encap(A1.pkRm, A1.skEm);
    expect(hexOf(enc)).toBe(hexOf(A1.pkEm));
    expect(hexOf(sharedSecret)).toBe(A1.sharedSecret);
  });

  it('decapsulates to the same secret from the other side', () => {
    expect(hexOf(decap(A1.pkEm, A1.skRm))).toBe(A1.sharedSecret);
  });

  it('runs the key schedule to the published key, nonce and exporter secret', () => {
    const context = keySchedule(hex(A1.sharedSecret), A1.info);
    expect(hexOf(context.key)).toBe(A1.secretKey);
    expect(hexOf(context.baseNonce)).toBe(A1.baseNonce);
    expect(hexOf(context.exporterSecret)).toBe(A1.exporterSecret);
  });

  it('seals every published message, at every published sequence number', () => {
    /* Four sequence numbers, including a gap at 3, because the nonce is the
     * base XOR the counter and an off-by-one would still pass at zero. */
    const context = keySchedule(hex(A1.sharedSecret), A1.info);
    const pt = hex('4265617574792069732074727574682c20747275746820626561757479');
    const vectors: [number, string, string, string][] = [
      [0, '436f756e742d30', '56d890e5accaaf011cff4b7d',
        'f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a'],
      [1, '436f756e742d31', '56d890e5accaaf011cff4b7c',
        'af2d7e9ac9ae7e270f46ba1f975be53c09f8d875bdc8535458c2494e8a6eab251c03d0c22a56b8ca42c2063b84'],
      [2, '436f756e742d32', '56d890e5accaaf011cff4b7f',
        '498dfcabd92e8acedc281e85af1cb4e3e31c7dc394a1ca20e173cb72516491588d96a19ad4a683518973dcc180'],
      [4, '436f756e742d34', '56d890e5accaaf011cff4b79',
        '583bd32bc67a5994bb8ceaca813d369bca7b2a42408cddef5e22f880b631215a09fc0012bc69fccaa251c0246d'],
    ];
    for (const [sequence, aad, nonce, ct] of vectors) {
      expect(hexOf(nonceFor(context.baseNonce, sequence)), `nonce ${sequence}`).toBe(nonce);
      expect(hexOf(seal(context, sequence, hex(aad), pt)), `ct ${sequence}`).toBe(ct);
      expect(hexOf(open(context, sequence, hex(aad), hex(ct))), `pt ${sequence}`).toBe(hexOf(pt));
    }
  });

  it('refuses a ciphertext that was touched', () => {
    const context = keySchedule(hex(A1.sharedSecret), A1.info);
    const ct = seal(context, 0, new Uint8Array(0), hex('00112233'));
    ct[0] = (ct[0] ?? 0) ^ 0x01;
    expect(() => open(context, 0, new Uint8Array(0), ct)).toThrow();
  });

  it('exports a secret, which is what OHTTP keys its response with', () => {
    const context = keySchedule(hex(A1.sharedSecret), A1.info);
    const exported = exportSecret(context, 'message/bhttp response', 16);
    expect(exported).toHaveLength(16);
    /* Stable for the same context and label, different for a different one. */
    expect(hexOf(exportSecret(context, 'message/bhttp response', 16))).toBe(hexOf(exported));
    expect(hexOf(exportSecret(context, 'something else', 16))).not.toBe(hexOf(exported));
  });
});
