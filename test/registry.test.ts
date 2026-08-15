/*
 * The pairing payload, checked against the specification rather than ourselves.
 *
 * Nobody in this container owns a copy of Sparrow, so a round trip through our
 * own decoder would prove only that we are consistently wrong. That is the
 * exact failure the UR encoder's comment warns about: frames that look right
 * and that Sparrow will not read.
 *
 * So the anchor is Blockchain Commons' own worked example (BCR-2020-015). Its
 * BIP84 entry is published twice over: once as a descriptor naming an xpub,
 * and once as CBOR diagnostic naming the bytes. Decoding their xpub has to
 * produce their bytes. If it does, our field extraction agrees with the people
 * who wrote the format.
 */
import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import { bip84Account, hdKey, witnessPublicKeyHashOutput } from '../src/airgap/registry';
import { cborWrite } from '../src/airgap/cbor';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/* From bcr-2020-015-account.md: the wpkh entry of the account for the BIP39
 * seed "shield group erode awake lock sausage cash glare wave crew flame
 * glove", and the diagnostic that accompanies it. */
const SPEC = {
  xpub: 'xpub6BkU445MSEBXbPjD3g2c2ch6mn8yy1SXXQUM7EwjgYiq6Wt1NDwDZ45npqWcV8uQC5oi2gHuVukoCoZZyT4HKq8EpotPMqGqxdZRuapCQ23',
  masterFingerprint: 934670036, // 37b5eed4
  keyData: '03fd433450b6924b4f7efdd5d1ed017d364be95ab2b592dc8bddb3b00c1c24f63f',
  chainCode: '72ede7334d5acf91c6fda622c205199c595a31f9218ed30792d301d5ee9e3a88',
  parentFingerprint: 224256471,
};

describe('crypto-account, against BCR-2020-015', () => {
  const key = HDKey.fromExtendedKey(SPEC.xpub);

  it('reads the same key data out of their xpub that their diagnostic prints', () => {
    /* The whole of the field extraction, verified by somebody else's numbers.
     * A compressed public key is 33 bytes and a chain code is 32; getting
     * either from the wrong offset produces a payload that parses and points
     * at a wallet nobody owns. */
    expect(hex(key.publicKey!)).toBe(SPEC.keyData);
    expect(hex(key.chainCode!)).toBe(SPEC.chainCode);
    expect(key.parentFingerprint).toBe(SPEC.parentFingerprint);
  });

  it('builds the tags in the order and nesting the paper shows', () => {
    /* 308(404(303({...}))) — crypto-output wrapping witness-public-key-hash
     * wrapping crypto-hdkey. The tag numbers are the entire compatibility
     * story: a wrong one is not a corrupt payload, it is a different type. */
    const encoded = hex(cborWrite(witnessPublicKeyHashOutput(hdKey({
      keyData: key.publicKey!,
      chainCode: key.chainCode!,
      origin: {
        components: [
          { index: 84, hardened: true },
          { index: 0, hardened: true },
          { index: 0, hardened: true },
        ],
        sourceFingerprint: SPEC.masterFingerprint,
      },
      parentFingerprint: key.parentFingerprint,
    }))));

    // d90134 = tag(308), d90194 = tag(404), d9012f = tag(303), a4 = map(4).
    expect(encoded.startsWith('d90134d90194d9012fa4')).toBe(true);
    // 03 5821 <33 bytes of key data>
    expect(encoded).toContain(`035821${SPEC.keyData}`);
    // 04 5820 <32 bytes of chain code>
    expect(encoded).toContain(`045820${SPEC.chainCode}`);
    // 06 d90130 = origin, tag(304) crypto-keypath, then a2 = map(2),
    // 01 86 = components array(6), 1854 f5 00 f5 00 f5 = 84'/0'/0'.
    expect(encoded).toContain('06d90130a201861854f500f500f5');
    // 02 1a 37b5eed4 = source-fingerprint, the master's.
    expect(encoded).toContain('021a37b5eed4');
    // 08 1a 0d5de117 = parent fingerprint.
    expect(encoded).toContain(`081a${SPEC.parentFingerprint.toString(16).padStart(8, '0')}`);
  });

  it('wraps it in an account keyed by the master fingerprint', () => {
    const account = hex(bip84Account({
      masterFingerprint: SPEC.masterFingerprint,
      keyData: key.publicKey!,
      chainCode: key.chainCode!,
      parentFingerprint: key.parentFingerprint,
    }));
    // a2 = map(2); 01 1a 37b5eed4 = master fingerprint; 02 81 = one descriptor.
    expect(account.startsWith('a2011a37b5eed40281d90134d90194d9012f')).toBe(true);
  });

  it('uses the master fingerprint and not the account key\'s own', () => {
    /* The one substitution that would produce something importable and wrong.
     * A wallet uses this to recognise the same seed behind another account,
     * and the account key's fingerprint is not that. */
    const account = hex(bip84Account({
      masterFingerprint: SPEC.masterFingerprint,
      keyData: key.publicKey!,
      chainCode: key.chainCode!,
      parentFingerprint: key.parentFingerprint,
    }));
    expect(account).toContain('011a37b5eed4');
    expect(account).not.toContain(`011a${key.fingerprint.toString(16).padStart(8, '0')}`);
  });
});
