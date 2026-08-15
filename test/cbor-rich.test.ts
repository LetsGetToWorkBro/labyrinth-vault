/*
 * The maps and tags BC-UR's registry types are made of.
 *
 * Checked against the byte-level examples in the Blockchain Commons research
 * papers themselves (BCR-2020-007), not against our own decoder. A round trip
 * through code I wrote proves I am self-consistent, which is exactly the thing
 * that is worthless here: the question is whether Sparrow will read it.
 */
import { describe, it, expect } from 'vitest';
import { cborWrite } from '../src/airgap/cbor';
import { cborDecode } from '../src/airgap/cbor';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytes = (h: string) => new Uint8Array(h.match(/../g)!.map((p) => parseInt(p, 16)));

describe('CBOR writing, against the specification examples', () => {
  it('encodes the BCR-2020-007 master hdkey exactly', () => {
    /* From bcr-2020-007-hdkey.md, Test Vector 1: BIP32's own master key.
     *
     *   { 1: true,            is-master
     *     3: h'00e8f3...',    key-data (33 bytes)
     *     4: h'873dff...' }   chain-code (32 bytes)
     */
    const keyData = bytes('00e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35');
    const chainCode = bytes('873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508');
    const encoded = cborWrite({ map: [[1, true], [3, keyData], [4, chainCode]] });

    expect(hex(encoded)).toBe(
      'a301f503582100e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35' +
      '045820873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508',
    );
    // 74 bytes, as the paper says.
    expect(encoded.length).toBe(74);
  });

  it('writes the map header the way the paper spells it out', () => {
    // a3 = map(3); 01 = unsigned(1); f5 = true.
    expect(hex(cborWrite({ map: [[1, true]] }))).toBe('a101f5');
    expect(hex(cborWrite({ map: [] }))).toBe('a0');
    expect(hex(cborWrite(false))).toBe('f4');
  });

  it('writes tags as major type 6', () => {
    /* crypto-keypath is tag 304, which needs the two-byte form: 0xd9 0x0130.
     * Getting this wrong produces something a decoder reads as a different
     * type entirely. */
    expect(hex(cborWrite({ tag: 304, value: 0 }))).toBe('d9013000');
    expect(hex(cborWrite({ tag: 303, value: 0 }))).toBe('d9012f00');
    // Small tags still take the short form.
    expect(hex(cborWrite({ tag: 6, value: 0 }))).toBe('c600');
  });

  it('writes a keypath component array the way crypto-keypath does', () => {
    // 84'/0'/0' is [84, true, 0, true, 0, true].
    // array(6), 84, true, 0, true, 0, true.
    expect(hex(cborWrite([84, true, 0, true, 0, true]))).toBe('861854f500f500f5');
  });

  it('leaves the reader as narrow as it was', () => {
    /* The whole argument for a strict reader is that a signing device should
     * not offer a parser to whoever holds the other screen. Writing more must
     * not have quietly taught it to read more. */
    expect(cborDecode(cborWrite({ map: [[1, true]] }))).toBeNull();
    expect(cborDecode(cborWrite({ tag: 303, value: 0 }))).toBeNull();
    expect(cborDecode(cborWrite(true))).toBeNull();
  });
});
