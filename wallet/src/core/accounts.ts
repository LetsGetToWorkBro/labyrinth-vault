/**
 * What this wallet is watching, and where each of them signs.
 *
 * ## The thing this file changes
 *
 * A vault used to be a *mode*. The app was either paired or it was not, and
 * "not paired" was a state the whole interface apologized for: a home screen
 * showing fixtures behind a warning chip, a vault screen that was mostly an
 * invitation to go and get a vault. That shape had two consequences, and the
 * audit named both.
 *
 * It meant the only honest empty state was a fake full one. A wallet with
 * nothing to watch showed somebody else's balance with a label on it, and a
 * label is a weaker thing than an absence: people read the number and not the
 * chip, every time, and a screenshot of it is indistinguishable from a
 * screenshot of real money.
 *
 * And it meant an account could not exist without a vault, so the day this
 * wallet grew keys of its own there was nowhere to put them. A hot wallet is
 * not a second mode. It is a second **source**.
 *
 * So: a vault is one source of an account, keys on this phone are another, and
 * the app is a list of accounts that may happen to be empty. An empty list is
 * a real state with a real sentence, which is what "no accounts yet" is for.
 *
 * ## Why the source is on the account rather than on the app
 *
 * Because it decides what may be done with that account, and the decision has
 * to travel with the thing it is about. `canSignHere` in `keyvault.ts` takes a
 * `Source` and nothing else, and this is where a screen gets one to hand it. A
 * wallet holding both kinds at once is the case that makes it matter: a seed
 * in this phone's keychain must not become permission to sign for the account
 * that is watched from a vault, and the way that stays true is that the two
 * are separate rows with separate sources rather than one app state.
 */

import type { Pairing } from './pairing';
import { canSignHere, type HotRecord, type Source } from './keyvault';
import type { Asset } from './model';

/**
 * One account, as a screen needs it.
 *
 * `chains` rather than one asset, because a pairing carries Bitcoin and Monero
 * together and a hot record holds either or both. Splitting one vault into two
 * rows would make somebody who paired once believe they had done it twice.
 */
export interface Account {
  /** Stable enough to be a list key, and to survive a re-render. */
  id: string;
  /** What a person calls it. A vault's own label, or the plain hot one. */
  label: string;
  /** Where the keys are, which decides everything below. */
  source: Source;
  /** The chains this account actually covers. Never empty. */
  chains: Asset[];
  /** True only for a hot account. Read from `canSignHere`, never recomputed. */
  signsHere: boolean;
  /** When it arrived, for a list that wants to be in a stable order. */
  since: number;
}

/**
 * Every account this wallet knows about, vault first.
 *
 * Vault first because it is the one with the stronger protection, and a list
 * whose order is "most protected first" reads as a recommendation without
 * having to print one. It is also stable: a hot wallet created later does not
 * push a vault down a screen somebody has learned the shape of.
 */
export function accountsFrom(
  pairing: Pairing | null,
  hot: HotRecord | null,
  /**
   * True when this build is watching the published test account.
   *
   * A parameter rather than an import of `DEMO`, so this module stays free of
   * the stand-in and every branch below runs under Node. It exists because the
   * fallback is real: in a development build with nothing paired, `store.tsx`
   * still points the watcher at BIP84's own account key, and a list that said
   * "no accounts yet" over a screen showing that account's balance would be
   * the same dishonesty this module was written to delete, one build config to
   * the left. False in a release build, where the fallback does not exist.
   */
  standIn = false,
): Account[] {
  const accounts: Account[] = [];

  if (pairing !== null) {
    const chains: Asset[] = [];
    if (pairing.btc) chains.push('BTC');
    if (pairing.xmr) chains.push('XMR');
    /* A pairing carrying neither chain is not a pairing. It cannot arrive from
     * `acceptAccount`, which accepts one chain at a time and keeps what it
     * accepted, but a record read back from the keychain is untrusted input in
     * the same way a scan is, and a row for an account watching nothing would
     * be a row nothing on it could act on. */
    if (chains.length > 0) {
      accounts.push({
        id: 'vault',
        label: pairing.label,
        source: 'vault',
        chains,
        signsHere: canSignHere('vault'),
        since: pairing.pairedAt,
      });
    }
  }

  if (hot !== null) {
    const chains: Asset[] = [];
    if (hot.xmrSeed !== null) chains.push('XMR');
    if (hot.btcMnemonic !== null) chains.push('BTC');
    /* `parseHotRecord` already refuses a record holding neither, so this is
     * belt and braces rather than a real branch. It stays because the cost is
     * one comparison and the failure it prevents is a row offering to sign for
     * nothing. */
    if (chains.length > 0) {
      accounts.push({
        id: 'hot',
        label: 'This phone',
        source: 'hot',
        chains: chains.sort(),
        signsHere: canSignHere('hot'),
        since: hot.birth,
      });
    }
  }

  /* Last, and only when nothing real is present. A development build with a
   * pairing is watching the pairing, and the fallback is not in play. */
  if (standIn && accounts.length === 0) {
    accounts.push({
      id: 'standin',
      label: 'Published test account',
      /* `vault`, because it is watch-only here in exactly the way a paired
       * account is: this build holds no key for it that the whole world does
       * not also hold, and `canSignHere` refusing it is the correct answer for
       * the right reason. */
      source: 'vault',
      chains: ['BTC', 'XMR'],
      signsHere: canSignHere('vault'),
      since: 0,
    });
  }

  return accounts;
}

/**
 * Whether this wallet is watching anything at all.
 *
 * The question the home screen used to answer with a fixture. Its own function
 * because "the list is empty" is a state with a screen attached, and a screen
 * that reaches that state by checking `.length === 0` in three places is a
 * screen where one of the three eventually checks something else.
 */
export function watchingNothing(accounts: Account[]): boolean {
  return accounts.length === 0;
}

/**
 * Whether any account here can be signed for on this device.
 *
 * Not the same question as "is there a hot account", although today the
 * answers coincide. It is asked through `signsHere`, which comes from
 * `canSignHere`, so a change to the airgap rule reaches this without anybody
 * remembering to update it.
 */
export function anySignsHere(accounts: Account[]): boolean {
  return accounts.some((account) => account.signsHere);
}

/**
 * What a row says about where an account signs, in one caps phrase.
 *
 * Here rather than in the row so that the vault case has exactly one wording
 * in the application. "WATCH-ONLY" alone was the old copy and it is the wrong
 * half of the sentence: it says what the wallet cannot do without saying that
 * something else can, which reads as a limitation rather than as the design.
 */
export function signingNote(account: Account): string {
  return account.source === 'vault' ? 'SIGNS ON YOUR VAULT' : 'SIGNS ON THIS PHONE';
}

/**
 * Which source each chain is actually being watched through.
 *
 * The wallet can hold two accounts and `NodeWatcher` holds one account key per
 * chain, so with a vault paired *and* a seed on this phone, one of them is not
 * being watched. This says which, per chain, and it mirrors the precedence in
 * `store.tsx` exactly rather than guessing at it: a pairing wins, because it is
 * the one somebody is more likely to have money in.
 *
 * It exists so the accounts screen can say so out loud. A balance that is
 * silently absent reads as a balance that is gone, which is the same failure
 * the demo snapshot had pointing the other way: the screen showing a number
 * that is not the truth about this account.
 *
 * The real fix is a watcher that holds more than one account per chain. That is
 * a change to `watcher.ts` rather than a line here, and until it happens this
 * function is what keeps the interface honest about the limitation.
 */
export function watchedSources(
  pairing: Pairing | null,
  hot: HotRecord | null,
): Record<Asset, Source | null> {
  return {
    BTC: pairing?.btc ? 'vault' : hot?.btcMnemonic ? 'hot' : null,
    XMR: pairing?.xmr ? 'vault' : hot?.xmrSeed ? 'hot' : null,
  };
}

/**
 * The chains of an account that nothing is currently watching.
 *
 * Empty for almost every wallet. Non-empty exactly when a phone holds both
 * kinds of account and the same chain is on both, which is the case that needs
 * a sentence rather than an absence.
 */
export function unwatchedChains(account: Account, watching: Record<Asset, Source | null>): Asset[] {
  return account.chains.filter((chain) => watching[chain] !== account.source);
}

/**
 * The sentence for a wallet watching nothing.
 *
 * A sentence rather than a heading, and it names the two ways out, because an
 * empty state that only says "nothing here" is a dead end wearing an
 * apology. This replaced a screen showing a stranger's balance behind a chip
 * reading DEMO DATA.
 */
export const NOTHING_WATCHED =
  'No accounts yet. Pair a vault to watch and spend from keys kept on a device with no ' +
  'network on it, or make a wallet on this phone for smaller amounts.';
