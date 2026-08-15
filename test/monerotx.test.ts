/**
 * The wallet2 files: recognized, one of them opened, none of them signed.
 *
 * This is a small module and it would be easy to under-test, so it is worth
 * saying what the failure would look like. It is not a wrong signature; this
 * code cannot sign anything. It is somebody standing in front of an offline
 * phone holding a perfectly good `unsigned_monero_tx` and being told it is not
 * a transaction — and then going away to re-export it, or to try another
 * wallet, or to conclude the vault is broken.
 *
 * So what is tested is the honesty of the answer: that each of the six file
 * kinds is named, that a newer version of one is still named, that the words
 * say what this build actually does with each, and that nothing else in the
 * world gets mistaken for one.
 *
 * The two flags carry most of that and they are deliberately not one flag.
 * `readable` moves as the build gains readers — it is true for the unsigned
 * transaction set now and was false for everything when this file was written.
 * `signable` does not move, because the obstacle is not a reader: what a
 * wallet2 file contains is the sender's account of its own transaction, so a
 * signature over one would be a signature over an unverified claim. The tests
 * below hold each to its own standard.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MONERO_UNSUPPORTED,
  knownContainers,
  readContainer,
  readContainerText,
} from '../src/keys/monerotx';

const ascii = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

/** A file as wallet2 writes one: magic, version byte, then encrypted bytes. */
function container(magic: string, version: number, bodyLength = 512): Uint8Array {
  const out = new Uint8Array(magic.length + 1 + bodyLength);
  out.set(ascii(magic), 0);
  out[magic.length] = version;
  for (let i = 0; i < bodyLength; i++) out[magic.length + 1 + i] = (i * 37 + 11) & 0xff;
  return out;
}

describe('the six wallet2 files', () => {
  it('knows all of them, and each has a distinct magic', () => {
    const known = knownContainers();
    expect(known).toHaveLength(6);
    expect(new Set(known.map((k) => k.magic)).size).toBe(6);
    expect(new Set(known.map((k) => k.kind)).size).toBe(6);
    for (const { magic } of known) expect(magic.startsWith('Monero ')).toBe(true);
  });

  it('names every one of them from its bytes', () => {
    for (const { magic, kind } of knownContainers()) {
      const found = readContainer(container(magic, 5));
      expect(found, `${magic} was not recognized`).not.toBeNull();
      expect(found!.kind).toBe(kind);
      expect(found!.signable).toBe(false);
    }
  });

  it('opens exactly one of them, and says which', () => {
    /* Pinned to the kind rather than to a count, so that adding a reader is a
     * deliberate edit here and not a number that quietly went up. */
    const readable = knownContainers().filter((k) => k.readable).map((k) => k.kind);
    expect(readable).toEqual(['unsigned-tx-set']);
  });

  it('cannot let a shorter magic shadow a longer one', () => {
    /* Two guards, because the obvious version of this test is a lie. Feeding
     * a multisig set in and checking it comes back as multisig passes whatever
     * order the table is in — none of these names is a prefix of another
     * today, so there is nothing to shadow and the assertion cannot fail.
     *
     * So assert the two things that are actually load-bearing: that the
     * no-prefix property holds (which is what makes order irrelevant), and
     * that the table is ordered longest-first anyway (which is what keeps it
     * irrelevant when somebody adds "Monero unsigned tx set v2"). Deleting
     * the sort fails the second; adding an overlapping name fails the first. */
    const magics = knownContainers().map((k) => k.magic);

    for (const a of magics) {
      for (const b of magics) {
        if (a === b) continue;
        expect(b.startsWith(a), `"${a}" is a prefix of "${b}"`).toBe(false);
      }
    }

    const lengths = magics.map((m) => m.length);
    expect(lengths, 'the table is not longest-first').toEqual([...lengths].sort((x, y) => y - x));
  });

  it('reports the version it saw and the version it expected', () => {
    const current = readContainer(container('Monero unsigned tx set', 5))!;
    expect(current.version).toBe(5);
    expect(current.expectedVersion).toBe(5);

    /* A newer Monero bumps the byte. The file is still an unsigned tx set and
     * saying so is more use than calling it unrecognised bytes. */
    const future = readContainer(container('Monero unsigned tx set', 9))!;
    expect(future.kind).toBe('unsigned-tx-set');
    expect(future.version).toBe(9);
    expect(future.expectedVersion).toBe(5);
  });

  it('counts the encrypted body', () => {
    const found = readContainer(container('Monero output export', 4, 1234))!;
    expect(found.bodyLength).toBe(1234);
  });

  it('handles a file truncated to nothing but its magic', () => {
    const bare = readContainer(ascii('Monero unsigned tx set'))!;
    expect(bare.kind).toBe('unsigned-tx-set');
    expect(bare.version).toBeNull();
    expect(bare.bodyLength).toBe(0);
  });
});

describe('the refusal is the point', () => {
  const found = readContainer(container('Monero unsigned tx set', 5))!;
  const closed = readContainer(container('Monero output export', 4))!;

  it('says what the file is, not that it is unreadable', () => {
    expect(found.refusal).toContain('Monero unsigned transaction set');
    expect(found.refusal).not.toMatch(/not a transaction/i);
  });

  it('says why a file it can open is still not signed', () => {
    /* The sentence that has to survive every future edit of this module. The
     * reason is not a missing feature — naming one would invite somebody to
     * go and build it — it is that the file describes itself. */
    expect(found.refusal).toMatch(/own account of its own transaction/);
    expect(found.refusal).toMatch(/derived from its own keys/);
    expect(found.refusal).toMatch(/nothing was signed/i);
  });

  it('says something different about a file it has no reader for', () => {
    expect(closed.refusal).toMatch(/no reader/);
    expect(closed.refusal).not.toMatch(/own account of its own transaction/);
  });

  it('no longer blames CryptoNight, which this build has', () => {
    /* This test is the fossil of a true sentence that stopped being true.
     * Every refusal here used to say the body was encrypted under a key
     * derived by CryptoNight "which this build does not implement", and it
     * was the honest answer for as long as it was the answer. The C is
     * vendored now (vendor/cryptonight), the unsigned set opens, and a
     * refusal citing a missing dependency that is present would send somebody
     * to debug the one part of this that works. */
    for (const { magic } of knownContainers()) {
      expect(readContainer(container(magic, 1))!.refusal).not.toMatch(/CryptoNight/);
    }
  });

  it('is never signable in this build, whatever the file', () => {
    for (const { magic } of knownContainers()) {
      expect(readContainer(container(magic, 1))!.signable).toBe(false);
    }
  });

  it('does not promise a date', () => {
    /* The one thing worse than "not supported" is "supported in the next
     * release" written by somebody who did not have to ship it. */
    expect(found.refusal).not.toMatch(/soon|next release|coming/i);
  });
});

describe('what is not a Monero file', () => {
  it('lets a PSBT through untouched', () => {
    const psbt = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01, 0x00]);
    expect(readContainer(psbt)).toBeNull();
  });

  it('is not fooled by the word Monero on its own', () => {
    expect(readContainer(ascii('Monero'))).toBeNull();
    expect(readContainer(ascii('Monero is a cryptocurrency'))).toBeNull();
    expect(readContainerText('Monero address: 44AFFq5kSiGBoZ4NMDwYtN18obc8Aem')).toBeNull();
  });

  it('answers null for junk rather than throwing', () => {
    for (const junk of [new Uint8Array(0), new Uint8Array(32).fill(0xff)]) {
      expect(readContainer(junk)).toBeNull();
    }
    for (const junk of ['', 'ur:crypto-psbt/1-2/abc', 'LV1:PSBT:1:2:9f2a1c04:MFRG']) {
      expect(readContainerText(junk)).toBeNull();
    }
  });

  it('reads text and bytes the same way', () => {
    const text = 'Monero key image export' + 'x'.repeat(64);
    const fromText = readContainerText(text)!;
    const fromBytes = readContainer(ascii(text))!;
    expect(fromText).toEqual(fromBytes);
    expect(fromText.kind).toBe('key-image-export');
  });
});

describe('the module says what it cannot do, where somebody will read it', () => {
  const source = readFileSync('src/keys/monerotx.ts', 'utf8');

  it('keeps the record of what it once got wrong', () => {
    /* This used to assert that four missing layers were named. Three of the
     * four are built, so asserting they are still described as missing would
     * be a test pinning a stale claim — which this repository has done before
     * and which is why the corrections stay in the header rather than being
     * quietly deleted along with the mistakes. What must survive is the
     * evidence: Boost was the wrong answer, CLSAG was called absent after it
     * shipped, and both are written down as errors. */
    for (const layer of ['CryptoNight', 'Boost', 'CLSAG', 'binary_archive']) {
      expect(source, `${layer} is not named in the module comment`).toContain(layer);
    }
    expect(source, 'the Boost correction was dropped').toMatch(/not Boost|is not Boost/);
  });

  it('states the one thing that is not a missing layer', () => {
    /* Readable and signable are different questions, and the header is where
     * a reader learns that the second one is not waiting on work. */
    expect(source).toMatch(/Readable is not signable/);
  });

  it('exports the code the app switches on', () => {
    expect(MONERO_UNSUPPORTED).toBe('monero-file-unsupported');
  });

  it('is documented at greater length somewhere a reader can find', () => {
    const doc = readFileSync('docs/monero-signing.md', 'utf8');
    expect(doc).toMatch(/CLSAG/);
    expect(doc).toMatch(/Bulletproof/);
    for (const { magic } of knownContainers()) expect(doc).toContain(magic);
  });
});
