/**
 * Catching a wallet2 file coming back from the vault.
 *
 * The vault writes exactly one of Monero's six wallet files: the key image
 * export, which Cake, Feather and `monero-wallet-cli` import and which none of
 * them can read off a screen. This phone is the only device in the room
 * holding both a camera and a filesystem, so it carries.
 *
 * What is tested is the judgement, not the writing. `receiveMoneroFile` has no
 * import from `expo-file-system` — the three lines that touch a disk are in
 * `state/vaultFileStore.ts` — so every sentence somebody reads after a scan
 * runs here, under Node.
 *
 * The sentence that matters most is the one for a file going the *wrong way*.
 * Somebody who points this camera at an `unsigned_monero_tx` has confused the
 * two directions of the same wire, and "not for this wallet" is true and
 * useless. Saying which way it goes is what gets them unstuck.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { receiveMoneroFile } from '../src/core/vaultfile';

const bytes = (hex: string): Uint8Array =>
  new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** A wallet2 container header, as the vault or another wallet writes one. */
function container(magic: string, version: number, body = 512): Uint8Array {
  const out = new Uint8Array(magic.length + 1 + body);
  for (let i = 0; i < magic.length; i++) out[i] = magic.charCodeAt(i);
  out[magic.length] = version;
  for (let i = 0; i < body; i++) out[magic.length + 1 + i] = (i * 37 + 11) & 0xff;
  return out;
}

describe('the file the vault actually sends', () => {
  it('recognises a key image export and names the file it will become', () => {
    const incoming = receiveMoneroFile(container('Monero key image export', 3));
    expect(incoming.ok).toBe(true);
    expect(incoming.kind).toBe('key-image-export');
    expect(incoming.what).toBe('a Monero key image export');
    /* The name `monero-wallet-cli`'s own guides use. A parcel that arrives in
     * a Files app called `payload.bin` is one somebody has to guess about. */
    expect(incoming.filename).toBe('key_images');
  });

  it('says what the file is for, and that this wallet is only carrying it', () => {
    /* The honest shape of the round trip. This wallet already has these images
     * from `XMRKEYIMAGES`, matched by key rather than by position, and could
     * not open the file anyway: that needs CryptoNight, which is in the vault.
     * A screen implying the file did something here would be inventing a
     * second purpose for it. */
    const incoming = receiveMoneroFile(container('Monero key image export', 3));
    expect(incoming.note).toMatch(/turns a received total into a balance/);
    expect(incoming.note).toMatch(/carrying it for the other one/);
  });
});

describe('the files that are not it', () => {
  it('sends an unsigned transaction set back the way it came', () => {
    /* Somebody has pointed this camera at the codes they were about to show
     * the vault. The note has to name the direction and the control that does
     * it, or they are stuck holding a phone at a phone. */
    const incoming = receiveMoneroFile(container('Monero unsigned tx set', 5));
    expect(incoming.ok).toBe(false);
    expect(incoming.kind).toBe('unsigned-tx-set');
    expect(incoming.note).toMatch(/travels the other way/);
    expect(incoming.note).toMatch(/SHOW A MONERO FILE/);
    expect(incoming.note).toMatch(/Nothing was saved/);
  });

  it('names a file the vault does not write, and saves nothing', () => {
    for (const [magic, version] of [
      ['Monero signed tx set', 5],
      ['Monero output export', 4],
      ['Monero multisig export', 1],
      ['Monero multisig unsigned tx set', 1],
    ] as const) {
      const incoming = receiveMoneroFile(container(magic, version));
      expect(incoming.ok, magic).toBe(false);
      expect(incoming.filename, magic).toBeUndefined();
      expect(incoming.what, magic).toContain('Monero');
      expect(incoming.note, magic).toMatch(/does not write one of those/);
    }
  });

  it('refuses bytes that are not a wallet file at all', () => {
    for (const junk of [
      new Uint8Array(0),
      new Uint8Array(64).fill(0xab),
      new TextEncoder().encode('Monero is a cryptocurrency'),
    ]) {
      const incoming = receiveMoneroFile(junk);
      expect(incoming.ok).toBe(false);
      expect(incoming.filename).toBeUndefined();
      expect(incoming.note).toMatch(/Nothing was saved/);
    }
  });

  it('offers a filename for nothing it refuses', () => {
    /* The property the store leans on: it writes only when a filename came
     * back, so a refusal that carried one would be a refusal that saves. */
    for (const refused of [
      container('Monero unsigned tx set', 5),
      container('Monero signed tx set', 5),
      new Uint8Array(32).fill(1),
    ]) {
      const incoming = receiveMoneroFile(refused);
      expect(incoming.ok).toBe(false);
      expect(incoming.filename).toBeUndefined();
    }
  });
});

describe('the round trip, end to end', () => {
  /* The vault's own fixture, which came out of Monero's crypto by way of
   * `oracle/`. It is a key image export with two images in it, so this is the
   * real thing arriving rather than a header this test invented. */
  const fixture = JSON.parse(
    readFileSync('../test/fixtures/monero-keyimages.json', 'utf8'),
  ) as { cases: { name: string; file: string }[] };

  it('accepts the file the oracle produced', () => {
    const two = fixture.cases.find((c) => c.name === 'two')!;
    const incoming = receiveMoneroFile(bytes(two.file));
    expect(incoming.ok).toBe(true);
    expect(incoming.filename).toBe('key_images');
  });

  it('accepts one with no images in it', () => {
    /* An export listing nothing is a real answer: a wallet that has received
     * nothing has no key images, and the far side should be told that rather
     * than left waiting. */
    const empty = fixture.cases.find((c) => c.name === 'empty')!;
    expect(receiveMoneroFile(bytes(empty.file)).ok).toBe(true);
  });
});

describe('the wiring around it', () => {
  const store = readFileSync('src/state/store.tsx', 'utf8');
  const scan = readFileSync('src/screens/Scan.tsx', 'utf8');
  const fileStore = readFileSync('src/state/vaultFileStore.ts', 'utf8');

  it('writes nothing until somebody taps', () => {
    /* A scan that drops files into a directory on its own is a scan with a
     * side effect nobody asked for, and this one would be a file naming every
     * output the account owns. */
    const code = store
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    const arrival = code.indexOf('const incoming = receiveMoneroFile(payload)');
    const write = code.indexOf('saveVaultFile(');
    expect(arrival).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(code.slice(arrival, code.indexOf('return { ok: true, note: incoming.note }')))
      .not.toContain('saveVaultFile(');
  });

  it('keeps the bytes in one place and drops them once handed on', () => {
    expect(store).toMatch(/pendingFile\.current = null;\s*\n\s*setMoneroFileWaiting\(null\);/);
  });

  it('saves into the cache, not the backed-up documents directory', () => {
    /* The opposite choice from the settings file next to it. A courier's
     * parcel that has been delivered should be allowed to evaporate; a list of
     * every output an account owns should not sit in a backup forever. */
    expect(fileStore).toMatch(/new File\(Paths\.cache, name\)/);
    expect(fileStore).not.toMatch(/Paths\.document/);
  });

  it('offers the save before the way out of the screen', () => {
    /* CONTINUE is how somebody leaves without the file, and the bytes are not
     * kept after that. */
    const save = scan.indexOf('store.moneroFileWaiting ?');
    const leave = scan.indexOf('<Action label="CONTINUE"');
    expect(save).toBeGreaterThan(-1);
    expect(leave).toBeGreaterThan(-1);
    expect(save).toBeLessThan(leave);
  });
});
