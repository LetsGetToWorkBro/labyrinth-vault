/**
 * Pairing, tested with the vault's own export code as the sender.
 *
 * Every payload below is built by `keys/account.ts`, the code the real vault
 * runs, so the format cannot drift between the halves without a test noticing.
 * The checks under test are the wallet's additions: the first-address
 * comparison for Bitcoin, the view-key-belongs-to-address proof for Monero,
 * and the rule that storage gets re-validated exactly like a camera scan.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { bitcoinAccount, encodeAccount, moneroAccount } from '@vault/keys/account';
import { openWatch } from '@vault/keys/bitcoin';
import { revealSecretHex, walletFromSeed } from '@vault/keys/monero';
import { acceptAccount, type Pairing , wouldReplace } from '../src/core/pairing';
import { clearPairing, loadPairing, savePairing, KEYS_SCHEMA } from '../src/state/persistKeys';
import { memoryStore } from '../src/state/persist';
import { DEMO_ZPUB } from '../src/core/demo';

const xmrWallet = walletFromSeed(new Uint8Array(32).map((_, i) => (i * 7 + 11) & 0xff));
const otherXmr = walletFromSeed(new Uint8Array(32).fill(21));

const btcWallet = (() => {
  const opened = openWatch(DEMO_ZPUB);
  if (!opened.ok || !opened.wallet) throw new Error('demo key does not open');
  return opened.wallet;
})();

const encoder = new TextEncoder();

describe('accepting a Bitcoin export', () => {
  it('accepts the vault\'s own export', () => {
    const accepted = acceptAccount(encodeAccount(bitcoinAccount(btcWallet)));
    expect(accepted.ok).toBe(true);
    if (accepted.ok && accepted.chain === 'btc') expect(accepted.btc.zpub).toBe(DEMO_ZPUB);
  });

  it('refuses an export whose first address does not derive from its key', () => {
    /* The check a person is invited to do by eye, done exactly. A mismatch
     * means the two devices disagree about derivation, and a pairing kept
     * anyway would watch addresses no vault will ever sign for. */
    const account = bitcoinAccount(btcWallet);
    const tampered = { ...account, first: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' };
    const accepted = acceptAccount(encoder.encode(JSON.stringify(tampered)));
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.problem).toMatch(/disagree about derivation/);
  });

  it('refuses bytes that are not an export at all', () => {
    for (const bytes of [new Uint8Array([1, 2, 3]), encoder.encode('{}'), encoder.encode('null')]) {
      expect(acceptAccount(bytes).ok).toBe(false);
    }
  });
});

describe('accepting a Monero export', () => {
  it('accepts the vault\'s own export', () => {
    const accepted = acceptAccount(encodeAccount(moneroAccount(xmrWallet)));
    expect(accepted.ok).toBe(true);
    if (accepted.ok && accepted.chain === 'xmr') {
      expect(accepted.xmr.address).toBe(xmrWallet.address);
      expect(accepted.xmr.birth).toBeGreaterThan(0);
    }
  });

  it('refuses a view key that does not belong to the address', () => {
    /* The quiet failure this prevents: pair, scan the whole chain correctly,
     * find nothing, conclude the money is gone. */
    const account = moneroAccount(xmrWallet);
    const wrong = { ...account, view: revealSecretHex(otherXmr.viewSecret) };
    const accepted = acceptAccount(encoder.encode(JSON.stringify(wrong)));
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.problem).toMatch(/does not belong/);
  });

  it('refuses a stagenet export, because this wallet follows mainnet', () => {
    const accepted = acceptAccount(encodeAccount(moneroAccount(walletFromSeed(new Uint8Array(32).fill(3), 'stagenet'), 'stagenet')));
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.problem).toMatch(/mainnet/);
  });
});

describe('what storage hands back is re-proved', () => {
  const good = (): Pairing => {
    const btc = acceptAccount(encodeAccount(bitcoinAccount(btcWallet)));
    const xmr = acceptAccount(encodeAccount(moneroAccount(xmrWallet)));
    if (!btc.ok || btc.chain !== 'btc' || !xmr.ok || xmr.chain !== 'xmr') throw new Error('setup');
    return { btc: btc.btc, xmr: xmr.xmr, label: 'VAULT · iPhone 11', pairedAt: 1_700_000_000_000 };
  };

  it('round trips through the store', async () => {
    const store = memoryStore();
    await savePairing(store, good());
    expect(await loadPairing(memoryStore(store.text))).toEqual(good());
  });

  it('loads nothing from an empty store, unreadable JSON, or a strange schema', async () => {
    expect(await loadPairing(memoryStore())).toBeNull();
    expect(await loadPairing(memoryStore('{ not json'))).toBeNull();
    expect(await loadPairing(memoryStore(JSON.stringify({ schema: 99, pairing: good() })))).toBeNull();
  });

  it('drops a stored Bitcoin half whose first address no longer derives', async () => {
    const broken = good();
    broken.btc = { ...broken.btc!, first: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' };
    const store = memoryStore(JSON.stringify({ schema: KEYS_SCHEMA, pairing: broken }));
    const loaded = await loadPairing(store);
    expect(loaded?.btc).toBeNull();
    expect(loaded?.xmr).not.toBeNull();
  });

  it('drops a stored Monero half whose view key stopped matching', async () => {
    const broken = good();
    broken.xmr = { ...broken.xmr!, view: revealSecretHex(otherXmr.viewSecret) };
    const store = memoryStore(JSON.stringify({ schema: KEYS_SCHEMA, pairing: broken }));
    const loaded = await loadPairing(store);
    expect(loaded?.xmr).toBeNull();
    expect(loaded?.btc).not.toBeNull();
  });

  it('loads nothing when both halves fail, rather than an empty shell', async () => {
    const store = memoryStore(JSON.stringify({ schema: KEYS_SCHEMA, pairing: { btc: null, xmr: null } }));
    expect(await loadPairing(store)).toBeNull();
  });

  it('bounds a stored birth height like the scan height it feeds', async () => {
    const broken = good();
    broken.xmr = { ...broken.xmr!, birth: 999_999_999 };
    const store = memoryStore(JSON.stringify({ schema: KEYS_SCHEMA, pairing: broken }));
    expect((await loadPairing(store))?.xmr).toBeNull();
  });

  it('survives a save that fails, and a clear that fails', async () => {
    const full = {
      async read(): Promise<string | null> { return null; },
      async write(): Promise<void> { throw new Error('no space'); },
      async clear(): Promise<void> { throw new Error('locked'); },
    };
    await expect(savePairing(full, good())).resolves.toBeUndefined();
    await expect(clearPairing(full)).resolves.toBeUndefined();
  });
});

describe('the boundary between logic and keychain', () => {
  it('keeps expo-secure-store out of the module the tests drive', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/state/persistKeys.ts', 'utf8');
    expect(source.slice(source.indexOf('import '))).not.toMatch(/expo-secure-store/);
  });

  it('keeps the keys out of the plain file and in the keychain', async () => {
    const { readFileSync } = await import('node:fs');
    /* The file store and the keychain store are different sensitivities and
     * the code has to keep them apart: the JSON file must never gain a key
     * and the pairing must never quietly move to the file. */
    expect(readFileSync('src/state/keychainStore.ts', 'utf8')).toMatch(/expo-secure-store/);
    expect(readFileSync('src/state/fileStore.ts', 'utf8')).not.toMatch(/pairing/i);
    const store = readFileSync('src/state/store.tsx', 'utf8');
    expect(store).toMatch(/savePairing\(keysStorage/);
    expect(store).not.toMatch(/savePairing\(storage/);
  });

  it('locks the keychain entry to this device, unlocked only', async () => {
    const { readFileSync } = await import('node:fs');
    /* This-device-only: a watch-only key that quietly rides a backup onto
     * the next phone is a copy nobody decided to make. */
    expect(readFileSync('src/state/keychainStore.ts', 'utf8')).toMatch(/WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
  });
});

describe('a second, different account key does not replace the paired one', () => {
  /* One hostile ACCOUNT QR, scanned at any moment a camera was open, used to
   * replace the account key that every receive address and every swap payout
   * derives from. The label and the pairing age were carried over, so the
   * vault screen went on showing the original device and the original date:
   * nothing on any screen changed. */

  const paired = (over: Partial<Pairing> = {}): Pairing => ({
    btc: { zpub: 'zpub-one', first: 'bc1q-one' },
    xmr: { address: '4-one', view: 'aa'.repeat(32), birth: 3_000_000 },
    label: 'VAULT',
    pairedAt: 1,
    ...over,
  });

  it('reports a Bitcoin substitution, with both first addresses', () => {
    const accepted = { ok: true, chain: 'btc', btc: { zpub: 'zpub-two', first: 'bc1q-two' } } as const;
    const verdict = wouldReplace(paired(), accepted);
    expect(verdict.replaces).toBe(true);
    if (!verdict.replaces) throw new Error('unreachable');
    expect(verdict.was).toBe('bc1q-one');
    expect(verdict.now).toBe('bc1q-two');
  });

  it('reports a Monero substitution', () => {
    const accepted = { ok: true, chain: 'xmr', xmr: { address: '4-two', view: 'bb'.repeat(32), birth: 1 } } as const;
    expect(wouldReplace(paired(), accepted).replaces).toBe(true);
  });

  it('stays silent for the same key scanned twice', () => {
    /* A person scanning their own vault again has done nothing wrong, and a
     * prompt there teaches them to dismiss prompts. */
    const same = { ok: true, chain: 'btc', btc: { zpub: 'zpub-one', first: 'bc1q-one' } } as const;
    expect(wouldReplace(paired(), same).replaces).toBe(false);
  });

  it('stays silent for a chain that is not paired yet', () => {
    /* Completing a pairing one chain at a time is the ordinary path. */
    const accepted = { ok: true, chain: 'xmr', xmr: { address: '4-new', view: 'cc'.repeat(32), birth: 1 } } as const;
    expect(wouldReplace(paired({ xmr: null }), accepted).replaces).toBe(false);
    expect(wouldReplace(null, accepted).replaces).toBe(false);
  });

  it('is what the store actually refuses on', () => {
    const store = readFileSync('src/state/store.tsx', 'utf8');
    expect(store).toMatch(/wouldReplace\(current, accepted\)/);
    expect(store).toMatch(/if \(replacing\.replaces\)/);
    expect(store).toMatch(/Forget the current vault first/);
  });
});
