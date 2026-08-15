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
 * wallet's account of its own transaction, and none of it is checked against
 * anything, because from a file alone none of it can be. So the assertions
 * below are about two things in equal measure: that the numbers are right, and
 * that nothing in the reply invites a signature.
 *
 * ## How the session comes to have a file of its own
 *
 * This changed when the envelope signature started being verified, and the way
 * it changed is worth writing down.
 *
 * The first version of this file took the oracle's finished file and answered
 * the CryptoNight seam with the oracle's recorded ChaCha key, which was enough
 * while opening a file meant decrypting it. It is not enough now: the file is
 * signed with the *oracle's* view secret, and the vault checks that signature
 * against its own view public key, so the whole point of the check is that
 * this no longer works.
 *
 * So the test builds a file the way a companion wallet would. The plaintext is
 * the oracle's archive, byte for byte, so the reader is still being held to
 * bytes Monero's own serializer wrote. The envelope around it is made here,
 * under the session's own view secret: an IV, ChaCha20, and a real signature
 * from `generateSignature`. That is exactly what a watch-only wallet holding
 * this vault's view key does, which is the only thing that can produce one of
 * these for this vault.
 *
 * The session's view secret is re-derived rather than extracted, because the
 * bridge deliberately has no function that returns one. Re-deriving means
 * repeating two documented steps from host.ts, and the repetition is made
 * safe by checking the result: the address this wallet produces has to equal
 * the address `unlock` reported. If the vault's derivation ever changes, this
 * test says so rather than quietly testing a different wallet.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { chacha20orig } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { api, resetHost } from '../src/bridge/host';
import { setNativeCnSlowHash } from '../src/keys/moneroexport';
import { generateSignature, legacySignatureBytes } from '../src/keys/monerosign';
import { UNSIGNED_TX_MAGIC, UNSIGNED_TX_VERSION_BYTE } from '../src/keys/monerounsigned';
import { passphraseToBytes } from '../src/keys/seal';
import { fromHex, toHex, walletFromSeed } from '../src/keys/monero';

afterEach(() => {
  setNativeCnSlowHash(null);
  resetHost();
});

const fixture = JSON.parse(
  readFileSync('test/fixtures/monero-unsigned-tx-set.json', 'utf8'),
) as { archive: string; file: string; chachaKey: string; viewSecret: string };

/** The randomness `create` is given below. Fixed, so the vault is the same one
 *  every run and the wallet re-derived here is the wallet in the session. */
const CREATE_RANDOM = new Uint8Array(88).fill(0x5a);
/** What `create` splits off as the wallet secrets; the rest is salt and nonce. */
const SECRET_BYTES = 48;
/** An arbitrary ChaCha key. Nothing derives it: the CryptoNight seam is told
 *  to answer with it, which is what standing in for the vendored C means. */
const CHACHA_KEY = new Uint8Array(32).map((_, i) => (i * 11 + 3) & 0xff);

/**
 * The Monero wallet the session holds, re-derived from the same randomness.
 *
 * Two steps, both from `host.ts`: `deriveSecret` hashes `0x02 || random ||
 * extra` for the Monero half of the vault secret, and `openSession` hands
 * that half, which is the whole 32-byte digest, to `walletFromSeed`. The
 * caller checks the address that comes out.
 */
function sessionWallet() {
  const material = new Uint8Array(1 + SECRET_BYTES);
  material[0] = 0x02;
  material.set(CREATE_RANDOM.subarray(0, SECRET_BYTES), 1);
  return walletFromSeed(sha256(material));
}

/** Open a session the way the app does: create a vault, then unlock it. */
function openSession(): { xmrAddress: string } {
  const pass = Array.from(passphraseToBytes('correct horse battery staple'));
  const created = JSON.parse(api.create(toHex(CREATE_RANDOM), pass, '')) as {
    ok: boolean;
    sealed?: string;
  };
  expect(created.ok).toBe(true);
  const unlocked = JSON.parse(api.unlock(created.sealed!, pass)) as {
    ok: boolean;
    xmrAddress?: string;
  };
  expect(unlocked.ok).toBe(true);
  return { xmrAddress: unlocked.xmrAddress! };
}

/**
 * An `unsigned_monero_tx` for the session's wallet, holding the oracle's
 * archive: magic, version byte, IV, ChaCha20, signature. Exactly the layout
 * `dump_tx_to_str` writes.
 */
function fileForSession(plaintext: Uint8Array, options: { bend?: number } = {}): string {
  const wallet = sessionWallet();
  const iv = new Uint8Array(8).map((_, i) => (i * 37 + 5) & 0xff);
  const ciphertext = chacha20orig(CHACHA_KEY, iv, plaintext);

  const body = new Uint8Array(8 + ciphertext.length);
  body.set(iv, 0);
  body.set(ciphertext, 8);

  const nonce = new Uint8Array(32).map((_, i) => (i * 13 + 7) & 0xff);
  const signature = legacySignatureBytes(
    generateSignature(keccak_256(body), fromHex(wallet.viewPublic), wallet.viewSecret, nonce),
  );

  const prefix = UNSIGNED_TX_MAGIC.length + 1;
  const file = new Uint8Array(prefix + body.length + 64);
  for (let i = 0; i < UNSIGNED_TX_MAGIC.length; i++) file[i] = UNSIGNED_TX_MAGIC.charCodeAt(i);
  file[UNSIGNED_TX_MAGIC.length] = UNSIGNED_TX_VERSION_BYTE;
  file.set(body, prefix);
  file.set(signature, prefix + body.length);
  /* One byte of the ciphertext flipped, for the test that a tampered file is
   * caught by the signature rather than by whatever the plaintext becomes. */
  if (options.bend !== undefined) file[options.bend] = (file[options.bend]! + 1) & 0xff;
  return toHex(file);
}

/** The seam the vendored CryptoNight sits behind. See the header. */
function installKey(key: Uint8Array = CHACHA_KEY): void {
  setNativeCnSlowHash(() => key);
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

describe('the wallet this test builds files for', () => {
  it('is the wallet the session actually holds', () => {
    /* The check that makes re-deriving the view secret legitimate rather than
     * a second implementation nobody compares. If `deriveSecret` or
     * `walletFromSeed` ever changes, this fails here instead of silently
     * testing a wallet the engine has never heard of. */
    const { xmrAddress } = openSession();
    expect(sessionWallet().address).toBe(xmrAddress);
  });
});

describe('a real unsigned transaction set, described', () => {
  it('opens the file and states what the sender says it does', () => {
    openSession();
    installKey();
    const reply = call(fileForSession(fromHex(fixture.archive)));

    expect(reply.problem ?? null).toBeNull();
    expect(reply.ok).toBe(true);
    expect(reply.readable).toBe(true);
    expect(reply.what).toBe('a Monero unsigned transaction set');
    expect(reply.transactions).toHaveLength(1);

    /* The same values test/monerounsigned.test.ts pins in piconero, formatted
     * once by the one formatter that knows what a piconero is worth:
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
    installKey();
    const [tx] = call(fileForSession(fromHex(fixture.archive))).transactions!;
    expect(tx!.payments).toHaveLength(1);
    expect(tx!.payments[0]!.address).toMatch(/^4AdUnd/);
    expect(tx!.payments[0]!.kind).toBe('SUBADDRESS');
    expect(tx!.payments[0]!.amountFormatted).toBe('2.4');
  });

  it('totals the file, so a set holding several still leads with one number', () => {
    openSession();
    installKey();
    const reply = call(fileForSession(fromHex(fixture.archive)));
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
    installKey();
    const raw = api.moneroFile(fileForSession(fromHex(fixture.archive)));
    for (const forbidden of ['digest', 'randomBytes', 'signable', 'frames']) {
      expect(raw, `the read-only reply carries ${forbidden}`).not.toContain(`"${forbidden}"`);
    }
  });
});

describe('the answers that are not a description', () => {
  it('needs an unlocked vault, because the key to the file is in it', () => {
    installKey();
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

  it('refuses a real file that belongs to somebody else', () => {
    /* The oracle's own file, signed with the oracle's view secret. It is a
     * perfectly good `unsigned_monero_tx`; it is not this wallet's. Before the
     * signature was checked this decrypted into noise and was reported as a
     * damaged archive at "version 87". */
    openSession();
    installKey(fromHex(fixture.chachaKey));
    const reply = call(fixture.file);
    expect(reply.ok).toBe(true);
    expect(reply.readable).toBe(false);
    expect(reply.what).toBe('a Monero unsigned transaction set');
    expect(reply.problem).toMatch(/belongs to a different wallet/);
    expect(reply.problem, 'it invents an archive version').not.toMatch(/archive version/);
  });

  it('refuses a file of its own that somebody edited on the way', () => {
    /* The property the signature actually buys. ChaCha20 has no tag, so before
     * this a flipped ciphertext byte decrypted to different plaintext and the
     * vault described whatever that turned out to mean. */
    openSession();
    installKey();
    const at = UNSIGNED_TX_MAGIC.length + 1 + 8 + 40;
    const reply = call(fileForSession(fromHex(fixture.archive), { bend: at }));
    expect(reply.readable).toBe(false);
    expect(reply.problem).toMatch(/damaged|different wallet/);
  });

  it('refuses outright on a build with no CryptoNight, and says which failed', () => {
    /* Signature first, decryption second, which is why this answer names
     * CryptoNight rather than blaming the file: the file has already proved
     * itself to be this wallet's. */
    openSession();
    setNativeCnSlowHash(null);
    const reply = call(fileForSession(fromHex(fixture.archive)));
    expect(reply.readable).toBe(false);
    expect(reply.problem).toMatch(/CryptoNight/);
    expect(reply.problem).toMatch(/this wallet's/);
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
    installKey();
    const whole = fileForSession(fromHex(fixture.archive));
    for (let at = 2; at < whole.length; at += 137) {
      const reply = call(whole.slice(0, at));
      expect(typeof reply.ok).toBe('boolean');
    }
  });
});
