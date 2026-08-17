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

import { MAX_RESTORE_HEIGHT, parseAccount } from '@vault/keys/account';
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
 * Whether an accepted chain would replace one already paired, and with what.
 *
 * The defect this closes: `acceptPairing` merged whatever it accepted over the
 * stored pairing with no branch on whether that chain was already there. One
 * hostile ACCOUNT QR, scanned at any moment a camera was open, replaced the
 * account key every receive address and every swap payout derives from. The
 * label and the pairing age were carried over deliberately, so the vault
 * screen went on showing the original device and the original date: nothing on
 * any screen changed.
 *
 * Substitution has to be a decision somebody makes, so this reports it and the
 * caller refuses. Re-scanning the *same* key is not a substitution and stays
 * silent, because a person scanning their own vault twice has done nothing
 * wrong and a prompt there teaches them to dismiss prompts.
 */
export function wouldReplace(
  current: Pairing | null,
  accepted: Accepted,
): { replaces: true; chain: 'btc' | 'xmr'; was: string; now: string } | { replaces: false } {
  if (!accepted.ok || current === null) return { replaces: false };

  if (accepted.chain === 'btc' && current.btc) {
    if (current.btc.zpub === accepted.btc.zpub) return { replaces: false };
    return { replaces: true, chain: 'btc', was: current.btc.first, now: accepted.btc.first };
  }
  if (accepted.chain === 'xmr' && current.xmr) {
    if (current.xmr.address === accepted.xmr.address) return { replaces: false };
    return { replaces: true, chain: 'xmr', was: current.xmr.address, now: accepted.xmr.address };
  }
  return { replaces: false };
}

/**
 * A better sentence for a payload `parseAccount` has already refused.
 *
 * Deliberately not a second parser, and it must not become one: it looks for
 * exactly the one refusal a person can act on and says nothing about any
 * other. `parseAccount` returns null for a dozen reasons and cannot say
 * which, which is right for a format reader and wrong for a screen somebody
 * is reading while holding two phones. Every other reason ends at the same
 * generic sentence, because "this export is not one this wallet can read" is
 * genuinely all that is known about a malformed payload.
 *
 * The restore height is the one worth naming because it is the one an honest
 * vault can produce: a device with a wrong clock, or a chain whose height was
 * typed rather than read. The generic sentence sends that person to check
 * their QR code, which is fine and undamaged, and they have nowhere to go
 * next.
 */
function whyNot(payload: Uint8Array): string {
  const generic = 'That is not a watch-only export this wallet can read.';
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return generic;
  }
  if (!value || typeof value !== 'object') return generic;
  const raw = value as Record<string, unknown>;
  if (raw['chain'] !== 'xmr') return generic;
  const height = raw['height'];
  if (typeof height !== 'number' || !Number.isSafeInteger(height)) return generic;
  if (height >= 0 && height <= MAX_RESTORE_HEIGHT) return generic;
  return (
    `That export says to start scanning Monero at block ${height}, and this wallet only accepts a restore ` +
    `height between 0 and ${MAX_RESTORE_HEIGHT}. Check the date on the vault that made it, then export the ` +
    'account again.'
  );
}

/**
 * Read an ACCOUNT payload and prove it before anything is kept.
 *
 * A refusal here is a sentence on the scan screen, at the moment somebody is
 * holding two phones, which is the only time the fix is cheap.
 */
export function acceptAccount(payload: Uint8Array): Accepted {
  const account = parseAccount(payload);
  if (!account) {
    return { ok: false, problem: whyNot(payload) };
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
      /* The same ceiling the export door uses, imported rather than retyped.
       * A height one door lets through and the other refuses is a pairing
       * accepted on camera and gone on the next launch, with no message at
       * either end, which is the failure `MAX_RESTORE_HEIGHT` exists to
       * prevent and which a second copy of the numeral would reintroduce. */
      birth <= MAX_RESTORE_HEIGHT &&
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
