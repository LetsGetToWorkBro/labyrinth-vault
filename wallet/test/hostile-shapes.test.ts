/**
 * The wallet's half of a wire format, refusing the same shapes the vault does.
 *
 * `parseUnsigned` is this package's copy of the unsigned-set reader. The two
 * halves of every format in this project are deliberately written twice, once
 * on each device, so that a bug in one is not automatically a bug in the
 * other — but that only pays off if both halves are held to the same standard.
 * This one says it is "parsed as strictly as anything in the repository", and
 * for a while that was not quite true: a `null` in any of its arrays threw a
 * TypeError instead of returning the sentence, and three of its bounds were
 * missing next to the vault's twin.
 *
 * The property, stated the same way as on the vault side: a parser given a
 * shape nobody wrote a branch for refuses it, rather than throwing out of a
 * function whose contract is to answer.
 */

import { describe, expect, it } from 'vitest';
import { parseUnsigned } from '../src/core/monerospend';

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const member = () => ({ key: 'b'.repeat(64), commitment: 'c'.repeat(64), globalIndex: 7 });
const input = () => ({
  txPublicKey: 'a'.repeat(64),
  amount: '1000',
  indexInTx: 0,
  globalIndex: 3,
  ring: [member()],
  realPosition: 0,
});
const output = () => ({ address: '4' + 'x'.repeat(94), amount: '500', change: false });

/** A set that parses, so each test changes exactly one thing about it. */
const good = () => ({
  v: 1,
  chain: 'xmr' as const,
  network: 'mainnet' as const,
  inputs: [input()],
  outputs: [output(), { ...output(), change: true }],
  fee: '500',
  ringSize: 1,
});

describe('the wallet copy of the unsigned-set reader', () => {
  it('still reads a well-formed set', () => {
    expect(parseUnsigned(bytes(good())).ok).toBe(true);
  });

  it('refuses a null input rather than throwing over it', () => {
    const call = () => parseUnsigned(bytes({ ...good(), inputs: [null] }));
    expect(call).not.toThrow();
    expect(call()).toMatchObject({ ok: false });
  });

  it('refuses a null ring member rather than throwing over it', () => {
    const call = () => parseUnsigned(bytes({ ...good(), inputs: [{ ...input(), ring: [null] }] }));
    expect(call).not.toThrow();
    expect(call()).toMatchObject({ ok: false });
  });

  it('refuses a null output rather than throwing over it', () => {
    const call = () => parseUnsigned(bytes({ ...good(), outputs: [null, null] }));
    expect(call).not.toThrow();
    expect(call()).toMatchObject({ ok: false });
  });

  it('refuses an amount that does not fit in 64 bits, as the vault does', () => {
    /* Not pedantry: an amount past 2^64 is not a quantity of piconero, and the
     * vault's twin refuses it. A mirror that accepts what the original rejects
     * would have the two devices disagreeing about what a valid set is. */
    const tooBig = (2n ** 64n).toString();
    expect(parseUnsigned(bytes({ ...good(), inputs: [{ ...input(), amount: tooBig }] })).ok).toBe(false);
    expect(parseUnsigned(bytes({ ...good(), fee: tooBig })).ok).toBe(false);
  });

  it('refuses indexes that are numbers but not whole ones', () => {
    for (const bad of [1.5, -1, Number.NaN]) {
      expect(parseUnsigned(bytes({ ...good(), inputs: [{ ...input(), indexInTx: bad }] })).ok).toBe(false);
      expect(parseUnsigned(bytes({ ...good(), inputs: [{ ...input(), globalIndex: bad }] })).ok).toBe(false);
    }
  });

  it('refuses a set that is implausibly large', () => {
    /* The wire caps a payload long before this, but a parser that will build
     * whatever it is handed is the wrong shape for a device that reads what a
     * camera saw. */
    const many = Array.from({ length: 129 }, input);
    expect(parseUnsigned(bytes({ ...good(), inputs: many })).ok).toBe(false);
    const lots = Array.from({ length: 17 }, output);
    expect(parseUnsigned(bytes({ ...good(), outputs: lots })).ok).toBe(false);
  });
});
