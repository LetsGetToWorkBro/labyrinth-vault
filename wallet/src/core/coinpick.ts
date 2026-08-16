/**
 * Finding one coin among twenty-four, and reading an address without losing
 * your place.
 *
 * ## Why a search rather than more chips
 *
 * The swap screen used to offer the catalog as two rows of chips: one row of
 * six tickers, and under it a row of up to nine chains once a ticker was
 * chosen. Twice, once per side of the trade. On a phone that is a wall of
 * small targets that wraps differently at every width, and the thing a person
 * is actually doing — "I have USDC on Base" — takes two hunts through two
 * wrapped rows.
 *
 * A list with a search field is the right shape for a catalog this size, and
 * it is what every wallet with more than a handful of assets converged on.
 * The logic is here rather than in the screen so it can be tested without a
 * renderer, which is the same reason every other decision in this package
 * lives in `core/`.
 *
 * ## The chain is never hidden
 *
 * Every row names its chain, and the search matches on it. This is the one
 * place this wallet deliberately diverges from the wallets it is imitating:
 * a well known one shows a trade as `USDC → XMR` and prints a Solana deposit
 * address underneath without the word Solana anywhere on the screen. Send
 * USDC on Ethereum to it and the money is gone, with nobody to ask. The
 * catalog in `swap.ts` is chain-explicit for that reason and the picker keeps
 * the promise: no row is ever just a ticker.
 */

import type { SwapCoin } from './swap';
import { chainName } from './swap';

/** A coin, with the words a person would type to find it. */
export interface CoinMatch {
  coin: SwapCoin;
  /** Lower is better. Only meaningful within one result set. */
  rank: number;
}

/**
 * Everything typeable about a coin, lowercased.
 *
 * The ticker, the label, and the chain's display name. `usdc-base` matches on
 * "usdc", "usdc on base", "base", and "USDC" in any case. The id is included
 * too, so somebody who has seen a log line can paste it.
 */
function haystack(coin: SwapCoin): string {
  return `${coin.ticker} ${coin.label} ${chainName(coin.chain)} ${coin.id}`.toLowerCase();
}

/**
 * The catalog, filtered and ranked by what somebody typed.
 *
 * An empty query returns the catalog in its own order, which is deliberate:
 * `SWAP_COINS` is written most-traded first, so the unsearched list opens on
 * the coins most people want. Sorting it alphabetically would bury Bitcoin
 * under a run of stablecoins.
 *
 * Ranking, for a query that is not empty:
 *
 *   0  the ticker is exactly what was typed        "btc" → Bitcoin
 *   1  the ticker starts with it                   "us"  → USDT, USDC
 *   2  the label starts with it                    "mon" → Monero
 *   3  the chain starts with it                    "sol" → everything on Solana
 *   4  it appears anywhere                         "ase" → USDC on Base
 *
 * Ties keep catalog order, so the ranking never reshuffles equals from one
 * keystroke to the next. A list that reorders under a thumb is a list that
 * gets the wrong row tapped.
 */
export function searchCoins(coins: readonly SwapCoin[], query: string): SwapCoin[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...coins];

  const matches: CoinMatch[] = [];
  for (const coin of coins) {
    const ticker = coin.ticker.toLowerCase();
    const label = coin.label.toLowerCase();
    const chain = chainName(coin.chain).toLowerCase();

    let rank: number;
    if (ticker === needle) rank = 0;
    else if (ticker.startsWith(needle)) rank = 1;
    else if (label.startsWith(needle)) rank = 2;
    else if (chain.startsWith(needle)) rank = 3;
    else if (haystack(coin).includes(needle)) rank = 4;
    else continue;

    matches.push({ coin, rank });
  }

  /* Index as the tiebreak rather than a label comparison, so equal ranks come
   * back in catalog order and nothing moves between keystrokes. */
  return matches
    .map((match, index) => ({ ...match, index }))
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .map((match) => match.coin);
}

/** A ticker and every chain it trades on, for a list with headings. */
export interface CoinGroup {
  ticker: string;
  /** The label without the chain: "USDC" rather than "USDC on Base". */
  name: string;
  coins: SwapCoin[];
}

/**
 * The catalog as headed groups, in catalog order.
 *
 * One heading per ticker even when the ticker has a single chain, because a
 * list where some rows have a heading and others do not reads as two lists.
 * `name` comes from the first coin's label with any " on <chain>" suffix
 * removed, so the heading is the asset and the rows are the chains.
 */
export function groupCoins(coins: readonly SwapCoin[]): CoinGroup[] {
  const groups: CoinGroup[] = [];
  for (const coin of coins) {
    const existing = groups.find((group) => group.ticker === coin.ticker);
    if (existing) {
      existing.coins.push(coin);
      continue;
    }
    groups.push({
      ticker: coin.ticker,
      name: coin.label.replace(/ on .*$/, ''),
      coins: [coin],
    });
  }
  return groups;
}

/**
 * An address broken into groups, for checking against another screen.
 *
 * The entire security model of this product ends with a person comparing a
 * string here against a string somewhere else, and an unbroken run of 95
 * characters is the worst possible way to present that. Four is the group
 * size a phone number and a card number both settled on, and it is small
 * enough to hold in your head between one glance and the next.
 *
 * The screen alternates contrast between consecutive groups, which is what
 * keeps your place when the eye returns. That is a rendering decision and it
 * needs the groups in order, which is all this returns.
 *
 * The last group is short whenever the length does not divide, and that is
 * left alone rather than padded: a padded group would be characters the
 * address does not have, on the one screen where invented characters are
 * least welcome.
 */
export function chunkAddress(address: string, size = 4): string[] {
  const clean = address.trim();
  if (!clean) return [];
  const step = Math.max(1, Math.floor(size));
  const out: string[] = [];
  for (let i = 0; i < clean.length; i += step) out.push(clean.slice(i, i + step));
  return out;
}
