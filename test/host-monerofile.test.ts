/**
 * `moneroFile` over the bridge: the read-only screen's whole supply of facts.
 *
 * The reader itself is tested in test/monerounsigned.test.ts against bytes
 * Monero's own `binary_archive` produced. What is tested here is the thing
 * between that reader and a person: a host function called the way Swift calls
 * it, with strings in and JSON out, and a shape a screen can render without
 * doing arithmetic of its own.
 *
 * The failure this file exists to catch is not a wrong parse. It is a screen
 * that reads as an approval. Everything `moneroFile` returns is the *sending*
 * wallet's account of its own transaction — the amounts, the destinations, the
 * claim that one output is change — and none of it is checked against
 * anything, because none of it can be. So the assertions below are about two
 * things in equal measure: that the numbers are right, and that nothing in the
 * reply invites a signature.
 *
 * ## How a session comes to hold the fixture's key
 *
 * The file was encrypted under a view secret the oracle chose, and a vault's
 * view secret comes from its own seed, so the two cannot be made equal. They
 * do not need to be: the view secret's only role in opening one of these files
 * is to derive the ChaCha20 key through `cn_slow_hash`, so a shim that answers
 * with the fixture's recorded key opens the fixture's file under the session's
 * own secret. That is the real code path — magic, envelope, archive, outline —
 * with one substitution, at the one seam the vendored C sits behind.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { api, resetHost } from '../src/bridge/host';
import { setNativeCnSlowHash } from '../src/keys/moneroexport';
import { passphraseToBytes } from '../src/keys/seal';
import { toHex } from '../src/keys/monero';

afterEach(() => {
  setNativeCnSlowHash(null);
  resetHost();
});

const fixture = JSON.parse(
  readFileSync('test/fixtures/monero-unsigned-tx-set.json', 'utf8'),
) as { file: string; chachaKey: string };

const bytes = (hex: string): Uint8Array =>
  new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** Open a session the way the app does: create a vault, then unlock it. */
function openSession(): void {
  const pass = Array.from(passphraseToBytes('correct horse battery staple'));
  const created = JSON.parse(
    api.create(toHex(new Uint8Array(88).fill(0x5a)), pass, ''),
  ) as { ok: boolean; sealed?: string };
  expect(created.ok).toBe(true);
  expect(JSON.parse(api.unlock(created.sealed!, pass)).ok).toBe(true);
}

/** The one seam the vendored CryptoNight sits behind. See the header. */
function installKeyFor(chachaKey: string): void {
  setNativeCnSlowHash(() => bytes(chachaKey));
}

interface Payment {
  position: number;
  address: string | null;
  kind: string;
  amountFormatted: string;
}
interface Tx {
  position: number;
  spendingFormatted: string;
  payingFormatted: string;
  changeFormatted: string;
  feeFormatted: string;
  ringSize: number;
  inputCount: number;
  outputCount: number;
  spendableNote: string;
  payments: Payment[];
}
interface Reply {
  ok: boolean;
  problem?: string | null;
  code?: string;
  what?: string;
  readable?: boolean;
  transactions?: Tx[];
  payingFormatted?: string;
  feeFormatted?: string;
}

const call = (hex: string): Reply => JSON.parse(api.moneroFile(hex)) as Reply;

/** A container header for a kind this build deliberately has no reader for. */
function otherContainer(magic: string, version: number): string {
  const out = new Uint8Array(magic.length + 1 + 64);
  for (let i = 0; i < magic.length; i++) out[i] = magic.charCodeAt(i);
  out[magic.length] = version;
  return toHex(out);
}

describe('a real unsigned transaction set, described', () => {
  it('opens the file and states what the sender says it does', () => {
    openSession();
    installKeyFor(fixture.chachaKey);
    const reply = call(fixture.file);

    expect(reply.problem ?? null).toBeNull();
    expect(reply.ok).toBe(true);
    expect(reply.readable).toBe(true);
    expect(reply.what).toBe('a Monero unsigned transaction set');
    expect(reply.transactions).toHaveLength(1);

    /* The numbers, against the same values test/monerounsigned.test.ts pins in
     * piconero. Formatted once, in the language with the formatter's tests:
     * 3000000000000 piconero is 3 XMR. */
    const [tx] = reply.transactions!;
    expect(tx!.spendingFormatted).toBe('3');
    expect(tx!.payingFormatted).toBe('2.4');
    expect(tx!.changeFormatted).toBe('0.5');
    expect(tx!.feeFormatted).toBe('0.1');
    expect(tx!.ringSize).toBe(2);
    expect(tx!.inputCount).toBe(1);
    expect(tx!.outputCount).toBe(2);
    expect(tx!.spendableNote).toBe('Immediately');
  });

  it('carries the address the sending wallet recorded, and says what kind', () => {
    openSession();
    installKeyFor(fixture.chachaKey);
    const [tx] = call(fixture.file).transactions!;
    expect(tx!.payments).toHaveLength(1);
    expect(tx!.payments[0]!.address).toMatch(/^4AdUnd/);
    expect(tx!.payments[0]!.kind).toBe('SUBADDRESS');
    expect(tx!.payments[0]!.amountFormatted).toBe('2.4');
  });

  it('totals the file, so a set holding several still leads with one number', () => {
    openSession();
    installKeyFor(fixture.chachaKey);
    const reply = call(fixture.file);
    expect(reply.payingFormatted).toBe('2.4');
    expect(reply.feeFormatted).toBe('0.1');
  });

  it('offers nothing to sign with', () => {
    /* The property the whole screen rests on. A digest is what `sign` and
     * `moneroSign` require, and its absence here is not an oversight to be
     * tidied up later: there is nothing to approve, because nothing in the
     * file has been checked. If a digest ever appears in this reply, somebody
     * is one small commit away from a signature over an unverified claim. */
    openSession();
    installKeyFor(fixture.chachaKey);
    const raw = api.moneroFile(fixture.file);
    for (const forbidden of ['digest', 'randomBytes', 'signable', 'frames']) {
      expect(raw, `the read-only reply carries ${forbidden}`).not.toContain(`"${forbidden}"`);
    }
  });
});

describe('the answers that are not a description', () => {
  it('needs an unlocked vault, because the key to the file is in it', () => {
    installKeyFor(fixture.chachaKey);
    const reply = call(fixture.file);
    expect(reply.ok).toBe(false);
    expect(reply.problem).toMatch(/locked/i);
  });

  it('names a file it will not open, rather than failing at it', () => {
    openSession();
    const reply = call(otherContainer('Monero signed tx set', 5));
    expect(reply.ok).toBe(true);
    expect(reply.readable).toBe(false);
    expect(reply.what).toBe('a Monero signed transaction set');
    expect(reply.transactions).toEqual([]);
    expect(reply.problem).toMatch(/no reader/);
  });

  it('will not read a multisig container, which is not a missing reader', () => {
    /* Single-signature only, everywhere, deliberately. Opening this one would
     * be the first thing that made the vault look as though it might. */
    openSession();
    const reply = call(otherContainer('Monero multisig unsigned tx set', 1));
    expect(reply.readable).toBe(false);
    expect(reply.transactions).toEqual([]);
  });

  it('says which file it is when the file will not decrypt', () => {
    /* A file from another wallet. The reader gets noise, the noise does not
     * parse, and what a person needs to be told is that this is a real Monero
     * file that is not theirs — not that the vault broke. */
    openSession();
    installKeyFor('11'.repeat(32));
    const reply = call(fixture.file);
    expect(reply.ok).toBe(true);
    expect(reply.readable).toBe(false);
    expect(reply.what).toBe('a Monero unsigned transaction set');
    expect(reply.problem).toMatch(/belonging to another wallet/);
    /* And it must not read as a confident statement about the file's format.
     * A wrong key decrypts to noise whose first varint is a number, and the
     * reader will name that number; what it must not do is leave somebody
     * hunting for a Monero release that writes it. */
    expect(reply.problem).toMatch(/cannot tell that apart/);
  });

  it('refuses outright on a build with no CryptoNight', () => {
    openSession();
    setNativeCnSlowHash(null);
    const reply = call(fixture.file);
    expect(reply.readable).toBe(false);
    expect(reply.problem).toMatch(/CryptoNight/);
  });

  it('is not a general-purpose reader for anything handed to it', () => {
    openSession();
    expect(call('').ok).toBe(false);
    expect(call('nothex').ok).toBe(false);
    // A PSBT is not one of these, and the answer says so rather than guessing.
    expect(call('70736274ff0100').problem).toMatch(/not one of Monero's wallet files/);
  });

  it('does not throw on a truncated file, whatever the truncation', () => {
    openSession();
    installKeyFor(fixture.chachaKey);
    const whole = fixture.file;
    for (let at = 2; at < whole.length; at += 137) {
      const reply = call(whole.slice(0, at));
      expect(typeof reply.ok).toBe('boolean');
    }
  });
});
