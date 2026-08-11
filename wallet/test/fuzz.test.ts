/**
 * The wallet's own parsers, fed garbage on purpose.
 *
 * Same rules and same harness style as the vault's `test/fuzz.test.ts`: a
 * seeded generator so a failure reproduces, and two properties per parser.
 * Never throw, because everything here stands behind a camera or a node
 * neither of which this app controls. And never half-accept: whatever
 * survives the mangling either passes the full check or none of it does.
 */

import { describe, expect, it } from 'vitest';
import { bitcoinAccount, encodeAccount, moneroAccount } from '@vault/keys/account';
import { addressAt, openWatch } from '@vault/keys/bitcoin';
import { walletFromSeed } from '@vault/keys/monero';
import { acceptAccount, revalidatePairing } from '../src/core/pairing';
import { loadPairing } from '../src/state/persistKeys';
import { memoryStore } from '../src/state/persist';
import { openAccount } from '../src/core/moneroscan';
import { DEMO_ZPUB } from '../src/core/demo';

/** xorshift32, same as the vault's harness. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

function bytesFrom(random: () => number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(random() * 256);
  return out;
}

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:{}",/-._ é❤';

function mangle(text: string, random: () => number): string {
  const edits = 1 + Math.floor(random() * 4);
  let out = text;
  for (let i = 0; i < edits; i++) {
    const at = Math.floor(random() * Math.max(1, out.length));
    const roll = random();
    if (roll < 0.4) out = out.slice(0, at) + CHARS[Math.floor(random() * CHARS.length)] + out.slice(at + 1);
    else if (roll < 0.7) out = out.slice(0, at) + out.slice(at + 1);
    else if (roll < 0.9) out = out.slice(0, at) + CHARS[Math.floor(random() * CHARS.length)] + out.slice(at);
    else out = out.slice(0, at);
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const btcWallet = (() => {
  const opened = openWatch(DEMO_ZPUB);
  if (!opened.ok || !opened.wallet) throw new Error('setup');
  return opened.wallet;
})();
const xmrWallet = walletFromSeed(new Uint8Array(32).map((_, i) => (i * 7 + 11) & 0xff));

describe('pairing survives anything the camera can hand it', () => {
  it('acceptAccount never throws, and never half-accepts a Bitcoin export', () => {
    const valid = decoder.decode(encodeAccount(bitcoinAccount(btcWallet)));
    const random = rng(0x6b34);

    for (let round = 0; round < 800; round++) {
      const bytes = random() < 0.3
        ? bytesFrom(random, Math.floor(random() * 200))
        : encoder.encode(mangle(valid, random));
      const accepted = acceptAccount(bytes);
      if (accepted.ok && accepted.chain === 'btc') {
        /* Whatever mangling survived acceptance left the key and the first
         * address agreeing, which is the whole check. Re-prove it here. */
        const reopened = openWatch(accepted.btc.zpub);
        expect(reopened.ok && reopened.wallet !== undefined).toBe(true);
        expect(addressAt(reopened.wallet!, 0, 0).address).toBe(accepted.btc.first);
      }
    }
  });

  it('and never half-accepts a Monero export', () => {
    const valid = decoder.decode(encodeAccount(moneroAccount(xmrWallet)));
    const random = rng(0x6b35);

    for (let round = 0; round < 800; round++) {
      const bytes = random() < 0.3
        ? bytesFrom(random, Math.floor(random() * 200))
        : encoder.encode(mangle(valid, random));
      const accepted = acceptAccount(bytes);
      if (accepted.ok && accepted.chain === 'xmr') {
        /* Accepted means the view key really belongs to the address; the
         * scanner's own opener is the second opinion. */
        expect(openAccount(accepted.xmr.address, accepted.xmr.view).ok).toBe(true);
        expect(Number.isSafeInteger(accepted.xmr.birth) && accepted.xmr.birth >= 0).toBe(true);
      }
    }
  });

  it('revalidatePairing never throws on structured garbage', () => {
    const random = rng(0x6b36);
    const junkValue = (depth = 0): unknown => {
      const roll = random();
      if (depth > 3 || roll < 0.2) return null;
      if (roll < 0.4) return Math.floor(random() * 1e9) * (random() < 0.5 ? -1 : 1);
      if (roll < 0.6) return mangle('zpub6rFR7y4Q2Aij', random);
      if (roll < 0.8) {
        return {
          zpub: junkValue(depth + 1),
          first: junkValue(depth + 1),
          view: junkValue(depth + 1),
          birth: junkValue(depth + 1),
          address: junkValue(depth + 1),
        };
      }
      return [junkValue(depth + 1)];
    };
    for (let round = 0; round < 1500; round++) {
      const loaded = revalidatePairing({
        btc: junkValue(),
        xmr: junkValue(),
        label: junkValue(),
        pairedAt: junkValue(),
      });
      if (loaded) {
        /* Anything that survives is fully proved, both halves. */
        if (loaded.btc) {
          const reopened = openWatch(loaded.btc.zpub);
          expect(reopened.ok).toBe(true);
        }
        if (loaded.xmr) expect(openAccount(loaded.xmr.address, loaded.xmr.view).ok).toBe(true);
      }
    }
  });

  it('loadPairing never throws on a mangled stored file', async () => {
    const stored = JSON.stringify({
      schema: 1,
      pairing: {
        btc: { zpub: DEMO_ZPUB, first: addressAt(btcWallet, 0, 0).address },
        xmr: null,
        label: 'VAULT',
        pairedAt: 1_700_000_000_000,
      },
    });
    const random = rng(0x6b37);
    for (let round = 0; round < 800; round++) {
      const text = random() < 0.2 ? decoder.decode(bytesFrom(random, Math.floor(random() * 120))) : mangle(stored, random);
      const loaded = await loadPairing(memoryStore(text));
      if (loaded?.btc) {
        expect(openWatch(loaded.btc.zpub).ok).toBe(true);
      }
    }
  });
});
