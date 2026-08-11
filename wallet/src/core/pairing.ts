/**
 * Pairing: the one payload this wallet accepts that changes what it watches.
 *
 * An `ACCOUNT` payload arrives over the camera, from a vault drawing frames.
 * It carries a Bitcoin account key, or a Monero address and view key. Nothing
 * in it can spend, and everything in it decides what this wallet spends the
 * rest of its life looking at, which makes reading it carefully the whole job
 * of this file.
 *
 * ## The checks, and what each one prevents
 *
 * The format is the vault's own (`keys/account.ts`), imported rather than
 * re-implemented, and `parseAccount` already refuses malformed payloads. What
 * this file adds are the checks that need the wallet's own machinery:
 *
 *   - **Bitcoin:** the first address in the payload has to equal the first
 *     address this wallet derives from the key beside it. The vault includes
 *     it precisely so a person can eyeball both screens; a machine can do the
 *     same comparison exactly, and a mismatch means the two devices disagree
 *     about derivation, which is not a pairing anybody should keep.
 *   - **Monero:** the view key has to belong to the address, checked by the
 *     same `openAccount` the scanner uses. Without this, a wallet pairs, scans
 *     the whole chain correctly, finds nothing, and reads as empty.
 *
 * ## What a pairing is not
 *
 * It is not a connection, and accepting one proves nothing about the vault
 * beyond that it drew these frames once. The wallet stores what was handed
 * over and nothing else; see `state/persistKeys.ts` for where that goes and
 * why it is a different place than the node config.
 */

import { parseAccount } from '@vault/keys/account';
import { addressAt, openWatch } from '@vault/keys/bitcoin';
import { openAccount } from './moneroscan';

export interface PairedBtc {
  zpub: string;
  /** The first receiving address, kept so re-validation can re-run forever. */
  first: string;
}

export interface PairedXmr {
  address: string;
  /** The private view key, hex. Watches; cannot spend. */
  view: string;
  /** Where scanning should start for this account. */
  birth: number;
}

/** Everything a pairing is. Either half may be absent until its export. */
export interface Pairing {
  btc: PairedBtc | null;
  xmr: PairedXmr | null;
  label: string;
  pairedAt: number;
}

export type Accepted =
  | { ok: true; chain: 'btc'; btc: PairedBtc }
  | { ok: true; chain: 'xmr'; xmr: PairedXmr }
  | { ok: false; problem: string };

/**
 * Read an ACCOUNT payload and prove it before anything is kept.
 *
 * A refusal here is a sentence on the scan screen, at the moment somebody is
 * holding two phones, which is the only time the fix is cheap.
 */
export function acceptAccount(payload: Uint8Array): Accepted {
  const account = parseAccount(payload);
  if (!account) {
    return { ok: false, problem: 'That is not a watch-only export this wallet can read.' };
  }

  if (account.chain === 'btc') {
    const opened = openWatch(account.zpub);
    if (!opened.ok || !opened.wallet) {
      return { ok: false, problem: opened.problem ?? 'That account key does not open.' };
    }
    const derived = addressAt(opened.wallet, 0, 0).address;
    if (derived !== account.first) {
      return {
        ok: false,
        problem:
          'The first address in that export does not match the first address this wallet derives from the same key. The two devices disagree about derivation, so nothing was paired.',
      };
    }
    return { ok: true, chain: 'btc', btc: { zpub: account.zpub, first: account.first } };
  }

  if (account.network !== 'mainnet') {
    return { ok: false, problem: 'That export is not for mainnet, and this wallet only follows mainnet.' };
  }
  const opened = openAccount(account.address, account.view);
  if (!opened.ok) return { ok: false, problem: opened.problem };
  return {
    ok: true,
    chain: 'xmr',
    xmr: { address: account.address, view: account.view.toLowerCase(), birth: account.height },
  };
}

/**
 * Re-run every acceptance check on a stored pairing.
 *
 * Storage hands back whatever was written, possibly by an older build,
 * possibly edited on a jailbroken phone. The rule is the same one
 * `state/persist.ts` holds for node addresses: what comes off disk goes
 * through the same door as what comes off a camera, and a half that fails is
 * dropped whole rather than repaired.
 */
export function revalidatePairing(value: unknown): Pairing | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  let btc: PairedBtc | null = null;
  if (raw['btc'] && typeof raw['btc'] === 'object') {
    const entry = raw['btc'] as Record<string, unknown>;
    if (typeof entry['zpub'] === 'string' && typeof entry['first'] === 'string') {
      const opened = openWatch(entry['zpub']);
      if (opened.ok && opened.wallet && addressAt(opened.wallet, 0, 0).address === entry['first']) {
        btc = { zpub: entry['zpub'], first: entry['first'] };
      }
    }
  }

  let xmr: PairedXmr | null = null;
  if (raw['xmr'] && typeof raw['xmr'] === 'object') {
    const entry = raw['xmr'] as Record<string, unknown>;
    const birth = entry['birth'];
    if (
      typeof entry['address'] === 'string' &&
      typeof entry['view'] === 'string' &&
      typeof birth === 'number' &&
      Number.isSafeInteger(birth) &&
      birth >= 0 &&
      birth <= 100_000_000 &&
      openAccount(entry['address'], entry['view']).ok
    ) {
      xmr = { address: entry['address'], view: entry['view'].toLowerCase(), birth };
    }
  }

  if (!btc && !xmr) return null;
  const pairedAt = typeof raw['pairedAt'] === 'number' && Number.isFinite(raw['pairedAt']) ? raw['pairedAt'] : 0;
  const label = typeof raw['label'] === 'string' && raw['label'].trim() ? raw['label'].trim() : 'Labyrinth Vault';
  return { btc, xmr, label, pairedAt };
}
