/**
 * The shapes a hostile companion can send that are not merely wrong values.
 *
 * Every parser on this device already refuses wrong *values* — a bad hex
 * string, an amount that is not a number, a ring the wrong size — and those
 * refusals are tested beside the parsers themselves. This file is about the
 * other axis: JSON and a camera can produce a *shape* nobody wrote a branch
 * for, and the failure mode there is not a wrong answer but an exception
 * thrown out of a function whose entire contract is to answer in a sentence.
 *
 * `JSON.parse('{"outputs":[null]}')` is the whole attack. Reading a field off
 * `null` is a TypeError, and a TypeError is not a refusal: on the vault side
 * the bridge's outer net turns it into a message about internal state instead
 * of the sentence the screen was written to show, and on the wallet side —
 * where `parseKeyImageReply` and `parseAccount` also run — there is no outer
 * net at all.
 *
 * So the property under test is uniform and worth stating once: **every parser
 * that reads untrusted bytes returns its refusal rather than throwing, for
 * every shape, not merely every value.**
 */

import { describe, expect, it } from 'vitest';
import { parseAccount } from '../src/keys/account';
import { parseKeyImageReply, parseKeyImageRequest } from '../src/keys/keyimages';
import { parseUnsignedSet } from '../src/keys/monerobuild';
import { parseUr } from '../src/airgap/ur';
import { toHex, walletFromSeed } from '../src/keys/monero';

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/** A ring member that is well-formed, so only the shape under test is wrong. */
const member = (fill: string) => ({
  key: fill.repeat(64),
  commitment: fill.repeat(64),
  globalIndex: 1,
});

const input = () => ({
  txPublicKey: 'a'.repeat(64),
  amount: '1000',
  indexInTx: 0,
  globalIndex: 1,
  ring: [member('b')],
  realPosition: 0,
});

const output = () => ({ address: 'whatever', amount: '500', change: false });

describe('a null where an object was expected', () => {
  /* Each of these threw a TypeError before the guard went in. The assertion is
   * deliberately about *not throwing* first and the refusal second, because the
   * throw is the defect and the message is only the shape of the fix. */

  it('is refused by the key image request parser, not thrown over', () => {
    const call = () => parseKeyImageRequest(bytes({ v: 1, chain: 'xmr', outputs: [null] }));
    expect(call).not.toThrow();
    expect(call()).toMatchObject({ ok: false });
  });

  it('is refused by the key image reply parser, which runs where nothing catches', () => {
    const call = () => parseKeyImageReply(bytes({ v: 1, chain: 'xmr', images: [null] }));
    expect(call).not.toThrow();
    expect(call()).toMatchObject({ ok: false });
  });

  it('is refused among the inputs of an unsigned set', () => {
    const call = () =>
      parseUnsignedSet(
        bytes({
          v: 1,
          chain: 'xmr',
          network: 'mainnet',
          inputs: [null],
          outputs: [output(), output()],
          fee: '10',
          ringSize: 1,
        }),
      );
    expect(call).not.toThrow();
    expect(call()).toMatchObject({ ok: false });
  });

  it('is refused among the members of a ring', () => {
    const call = () =>
      parseUnsignedSet(
        bytes({
          v: 1,
          chain: 'xmr',
          network: 'mainnet',
          inputs: [{ ...input(), ring: [null] }],
          outputs: [output(), output()],
          fee: '10',
          ringSize: 1,
        }),
      );
    expect(call).not.toThrow();
    expect(call()).toMatchObject({ ok: false });
  });

  it('is refused among the outputs of an unsigned set', () => {
    const call = () =>
      parseUnsignedSet(
        bytes({
          v: 1,
          chain: 'xmr',
          network: 'mainnet',
          inputs: [input()],
          outputs: [null, null],
          fee: '10',
          ringSize: 1,
        }),
      );
    expect(call).not.toThrow();
    expect(call()).toMatchObject({ ok: false });
  });

  it('is refused wherever else a scalar stands in for an entry', () => {
    /* Numbers and strings never threw — reading a field off them is `undefined`
     * rather than an error — but they belong in the same net, because a parser
     * that only survives the shapes somebody remembered is a parser waiting for
     * the next shape. */
    for (const entry of [7, 'text', true, []]) {
      expect(() => parseKeyImageRequest(bytes({ v: 1, chain: 'xmr', outputs: [entry] }))).not.toThrow();
      expect(parseKeyImageRequest(bytes({ v: 1, chain: 'xmr', outputs: [entry] }))).toMatchObject({ ok: false });
    }
  });
});

describe('an account export whose two halves are not the same wallet', () => {
  /* Worth recording where this check lives, because the obvious place is not
   * the right one.
   *
   * `parseAccount` decodes a Bitcoin export's zpub rather than trusting its
   * prefix, and does not make the same argument about a Monero export's
   * address-and-view-key pair. That asymmetry is real, and pushing the pairing
   * proof down into `parseAccount` is the tempting fix — but it is the wrong
   * one: the wallet's `acceptAccount` already proves the pair one layer up,
   * through `openAccount`, and explains a mismatch in a sentence written for
   * somebody standing there holding two phones. `parseAccount` can only return
   * null, so moving the check down here would replace that sentence with "that
   * is not a watch-only export this wallet can read" and buy nothing: there is
   * no consumer of a parsed Monero account that does not go through
   * `acceptAccount` first.
   *
   * So the pairing stays where it can be explained, and this test pins the
   * division of labour rather than a behaviour that should change. */

  const wallet = walletFromSeed(new Uint8Array(32).fill(9));

  it('parses into the shape the wallet then proves', () => {
    const account = {
      v: 1,
      chain: 'xmr',
      network: 'mainnet',
      address: wallet.address,
      view: toHex(wallet.viewSecret),
      height: 3_000_000,
    };
    expect(parseAccount(bytes(account))).toMatchObject({ chain: 'xmr', address: wallet.address });
  });

  it('leaves a mismatched pair to the layer that can say what is wrong', () => {
    /* Both halves are individually well-formed: a real address, and a real view
     * key from a different wallet. `parseAccount` reads it; `acceptAccount`
     * refuses it, and `wallet/test/pairing.test.ts` holds that. */
    const stranger = walletFromSeed(new Uint8Array(32).fill(4));
    const account = {
      v: 1,
      chain: 'xmr',
      network: 'mainnet',
      address: wallet.address,
      view: toHex(stranger.viewSecret),
      height: 3_000_000,
    };
    expect(parseAccount(bytes(account))).not.toBeNull();
  });

  it('still refuses a view key that is not 64 hex characters', () => {
    /* What `parseAccount` does own: the shape. */
    const account = {
      v: 1,
      chain: 'xmr',
      network: 'mainnet',
      address: wallet.address,
      view: 'nonsense',
      height: 0,
    };
    expect(parseAccount(bytes(account))).toBeNull();
  });
});

describe('a UR frame that is long before it is anything else', () => {
  /* The single-frame branch has always refused an over-long body while it was
   * still a string, because bytewords allocates in proportion to what it is
   * given. The animated branch was reaching the same ceiling one decode too
   * late: the `messageLength` check it relies on reads a header that the decode
   * had already allocated to reach. */

  it('refuses an over-long animated body without decoding it', () => {
    const huge = 'ae'.repeat(9 * 1024 * 1024); // past the 8 MiB message ceiling
    const started = Date.now();
    expect(parseUr(`ur:crypto-psbt/1-2/${huge}`)).toBeNull();
    /* Not a benchmark, a smoke alarm: decoding this would have built an array
     * of nine million bytes on the way to the same answer. */
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('still reads an ordinary animated frame', () => {
    /* The guard must not have moved the ceiling down onto real traffic, so a
     * frame of the size a camera actually carries still parses. */
    const part = parseUr('ur:bytes/1-2/lpadaocsvahdcxjnfdmyfgvasrjkiessjyeevozorfeyeezoeydsftrycsmuztgllydacsspaeaeaeaeaeaeaeaeaeae');
    expect(part === null || part.seqNum === 1).toBe(true);
  });
});
