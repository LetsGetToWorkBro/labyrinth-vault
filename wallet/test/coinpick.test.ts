/*
 * The picker's logic, without a renderer.
 *
 * Two things are being protected here and they are not the same thing. The
 * search has to find what somebody typed, which is ordinary. The list has to
 * never present a coin without its chain, which is the promise that stops a
 * person sending USDC on Ethereum to a Solana address, and it is the one a
 * later refactor would quietly break by shortening a label.
 */

import { describe, expect, it } from 'vitest';
import { SWAP_COINS, chainName } from '../src/core/swap';
import { chunkAddress, groupCoins, searchCoins } from '../src/core/coinpick';

describe('searching the catalog', () => {
  it('returns everything, in catalog order, for an empty query', () => {
    expect(searchCoins(SWAP_COINS, '')).toEqual([...SWAP_COINS]);
    expect(searchCoins(SWAP_COINS, '   ')).toEqual([...SWAP_COINS]);
    /* Catalog order is most-traded first, and that is the whole reason an
     * empty query is not sorted. Bitcoin must not open below a run of
     * stablecoins. */
    expect(searchCoins(SWAP_COINS, '')[0]?.id).toBe('btc');
  });

  it('puts an exact ticker first', () => {
    const found = searchCoins(SWAP_COINS, 'btc');
    expect(found[0]?.id).toBe('btc');
    const xmr = searchCoins(SWAP_COINS, 'xmr');
    expect(xmr[0]?.id).toBe('xmr');
  });

  it('finds a coin by the chain it is on', () => {
    const onBase = searchCoins(SWAP_COINS, 'base');
    expect(onBase.length).toBeGreaterThan(0);
    for (const coin of onBase) expect(coin.chain).toBe('base');
    expect(onBase.map((c) => c.id)).toContain('usdc-base');
  });

  it('finds a coin by its full label', () => {
    const found = searchCoins(SWAP_COINS, 'usdt on tron');
    expect(found.map((c) => c.id)).toEqual(['usdt-tron']);
  });

  it('ignores case and surrounding space', () => {
    expect(searchCoins(SWAP_COINS, '  MoNeRo ').map((c) => c.id)).toEqual(['xmr']);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchCoins(SWAP_COINS, 'dogecoin')).toEqual([]);
  });

  it('keeps equal ranks in catalog order, so the list does not reshuffle', () => {
    /* Every USDC row ranks the same for the query "usdc": the ticker starts
     * with it. If the sort were unstable, or fell back to comparing labels,
     * one keystroke could move a row under a thumb already travelling to it. */
    const found = searchCoins(SWAP_COINS, 'usdc');
    const catalog = SWAP_COINS.filter((c) => c.ticker === 'usdc').map((c) => c.id);
    expect(found.map((c) => c.id)).toEqual(catalog);
  });

  it('narrows rather than reorders as a query grows', () => {
    /* Typing is incremental, so each result set should be a subset of the one
     * before it in the same relative order. This is what makes the list feel
     * like it is settling rather than churning. */
    let previous = searchCoins(SWAP_COINS, 'u').map((c) => c.id);
    for (const query of ['us', 'usd', 'usdc']) {
      const next = searchCoins(SWAP_COINS, query).map((c) => c.id);
      expect(next.length).toBeGreaterThan(0);
      expect(previous).toEqual(expect.arrayContaining(next));
      previous = next;
    }
  });
});

describe('the promise that a coin is never shown without its chain', () => {
  it('gives every catalog entry a chain with a real name', () => {
    for (const coin of SWAP_COINS) {
      const name = chainName(coin.chain);
      expect(name, `${coin.id} has no chain name`).toBeTruthy();
      expect(name).not.toBe(coin.chain);
    }
  });

  it('never labels a multi-chain asset with the bare ticker', () => {
    /* The failure this prevents: a catalog edit that renames "USDC on Base"
     * to "USDC" because it looks tidier in a list. Then two rows read the
     * same and one of them takes your money to a chain you did not pick. */
    const groups = groupCoins(SWAP_COINS);
    for (const group of groups) {
      if (group.coins.length < 2) continue;
      for (const coin of group.coins) {
        expect(
          coin.label.toLowerCase(),
          `${coin.id} shares a ticker with another chain and must name its own`,
        ).not.toBe(group.ticker.toLowerCase());
        expect(coin.label.toLowerCase()).toContain(chainName(coin.chain).toLowerCase());
      }
    }
  });

  it('makes every label unique, so no two rows read alike', () => {
    const labels = SWAP_COINS.map((c) => c.label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('grouping the catalog', () => {
  it('keeps catalog order and covers every coin exactly once', () => {
    const groups = groupCoins(SWAP_COINS);
    const flat = groups.flatMap((group) => group.coins);
    expect(flat).toEqual([...SWAP_COINS]);
    expect(groups[0]?.ticker).toBe('btc');
  });

  it('heads a group with the asset rather than the chain', () => {
    const groups = groupCoins(SWAP_COINS);
    const usdc = groups.find((group) => group.ticker === 'usdc');
    expect(usdc?.name).toBe('USDC');
    expect(usdc?.coins.length).toBeGreaterThan(1);
  });

  it('gives a single-chain asset a group too', () => {
    /* A list where some rows carry a heading and others do not reads as two
     * lists that happen to be adjacent. */
    const groups = groupCoins(SWAP_COINS);
    expect(groups.find((group) => group.ticker === 'btc')?.coins).toHaveLength(1);
    expect(groups.find((group) => group.ticker === 'xmr')?.name).toBe('Monero');
  });

  it('groups whatever it is given, not just the whole catalog', () => {
    const some = SWAP_COINS.filter((c) => c.ticker === 'eth');
    const groups = groupCoins(some);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.coins).toHaveLength(some.length);
  });
});

describe('breaking an address up to be checked', () => {
  it('groups in fours by default', () => {
    expect(chunkAddress('abcdefghijkl')).toEqual(['abcd', 'efgh', 'ijkl']);
  });

  it('leaves a short last group short rather than padding it', () => {
    /* Padding would put characters on the screen that the address does not
     * have, on the one screen where invented characters are least welcome. */
    expect(chunkAddress('abcdefghij')).toEqual(['abcd', 'efgh', 'ij']);
    expect(chunkAddress('abcdefghij').join('')).toBe('abcdefghij');
  });

  it('always rejoins to exactly what it was given', () => {
    const address =
      '888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H';
    for (const size of [1, 3, 4, 5, 8, 200]) {
      expect(chunkAddress(address, size).join('')).toBe(address);
    }
  });

  it('trims, so a copied address with a stray newline still lines up', () => {
    expect(chunkAddress('  abcdefgh \n')).toEqual(['abcd', 'efgh']);
  });

  it('returns nothing for nothing', () => {
    expect(chunkAddress('')).toEqual([]);
    expect(chunkAddress('   ')).toEqual([]);
  });

  it('refuses a nonsense group size rather than looping forever', () => {
    expect(chunkAddress('abcd', 0)).toEqual(['a', 'b', 'c', 'd']);
    expect(chunkAddress('abcd', -3)).toEqual(['a', 'b', 'c', 'd']);
  });
});
