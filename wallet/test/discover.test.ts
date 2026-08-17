/**
 * Finding coins, and the two ways a light client loses them.
 *
 * A wallet scan fails expensively in exactly two directions, and both are here.
 *
 * **Stopping too early.** An address past the gap limit is never asked about,
 * so its balance never appears, and the owner concludes the coins are gone.
 * This happens to real people, usually after handing fifty addresses to a
 * payment processor.
 *
 * **Reporting a partial scan as a complete one.** If half the queries fail and
 * the wallet shows the total of the half that worked, it displays a balance
 * that is confidently too low. That is worse than showing nothing, because a
 * number invites a decision and a failure does not.
 *
 * The rest of this file is arithmetic that has to be exactly right because a
 * screen renders it next to the word "confirmations".
 */

import { describe, expect, it } from 'vitest';
import { openFromMnemonic, addressAt } from '@vault/keys/bitcoin';
import { recorded } from '../src/net/http';
import { discover, nextReceiveAddress, GAP_LIMIT, MAX_ADDRESSES } from '../src/core/discover';
import { historyFrom, feeOptionsFrom } from '../src/core/watcher';

/** BIP84's published vector. Empty, everybody's, controls nothing. */
const WORDS =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const wallet = openFromMnemonic(WORDS);

const stats = (received: number, txCount: number) =>
  JSON.stringify({
    chain_stats: { funded_txo_sum: received, spent_txo_sum: 0, tx_count: txCount },
    mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
  });

const UNUSED = stats(0, 0);

/**
 * A node that knows about the addresses named, and nothing else.
 *
 * Built from the real derivation rather than from invented strings, so the
 * scan being tested is the scan the app runs against the keys it holds.
 */
function nodeWith(used: { change: 0 | 1; index: number; value: number }[], depth = 80) {
  const answers: Record<string, string> = {};
  for (const branch of [0, 1] as const) {
    for (let i = 0; i < depth; i++) {
      const { address } = addressAt(wallet, branch, i);
      const hit = used.find((entry) => entry.change === branch && entry.index === i);
      answers[`GET /address/${address}`] = hit ? stats(hit.value, 1) : UNUSED;
      answers[`GET /address/${address}/utxo`] = hit
        ? JSON.stringify([
            {
              txid: String(branch) + String(i).padStart(2, '0') + 'f'.repeat(61),
              vout: 0,
              value: hit.value,
              status: { confirmed: true, block_height: 860000 },
            },
          ])
        : '[]';
    }
  }
  return recorded(answers);
}

/**
 * Derived once and shared.
 *
 * The cap fixtures below need every address on both branches, and a BIP32
 * child derivation is not free: deriving them per fixture was most of this
 * file's runtime.
 */
const cache = new Map<string, string>();
function addressOf(branch: 0 | 1, index: number): string {
  const key = `${branch}/${index}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  const { address } = addressAt(wallet, branch, index);
  cache.set(key, address);
  return address;
}

/**
 * A node where every address on both branches has been paid to, so the gap
 * never closes and the walk can only end at the cap.
 *
 * `MAX_ADDRESSES` deep on each branch, which is exactly as far as the walk can
 * ask: a fixture that went further would only be describing queries nobody
 * makes. `value` funds each of them, which is what makes the truncation test
 * about money rather than about a boolean: a scan that stopped at the cap and
 * reported what it reached would be publishing a balance short by everything
 * beyond it.
 */
function everyAddressUsed(value = 1000): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const branch of [0, 1] as const) {
    for (let i = 0; i < MAX_ADDRESSES; i++) {
      const address = addressOf(branch, i);
      answers[`GET /address/${address}`] = stats(value, 1);
      answers[`GET /address/${address}/utxo`] = JSON.stringify([
        {
          txid: String(branch) + String(i).padStart(3, '0') + 'e'.repeat(60),
          vout: 0,
          value,
          status: { confirmed: true, block_height: 860000 },
        },
      ]);
    }
  }
  return answers;
}

describe('the gap limit', () => {
  it('is twenty, and raising it is the safe direction', () => {
    /* BIP44's number, matching every other wallet. A wallet that scanned
     * fewer addresses than the one that generated them finds less money than
     * exists. */
    expect(GAP_LIMIT).toBe(20);
  });

  it('finds a coin sitting just inside the gap', async () => {
    const node = nodeWith([{ change: 0, index: 19, value: 250000 }]);
    const found = await discover(node, wallet, 860010);
    expect(found.ok, found.problem ?? '').toBe(true);
    expect(found.balance).toBe(250000n);
  });

  it('keeps scanning past a used address, counting the gap from there', async () => {
    /* The case a naive implementation gets wrong: the run of unused addresses
     * resets when one is used, so a coin at index 25 is found because index 8
     * was used. */
    const node = nodeWith([
      { change: 0, index: 8, value: 100000 },
      { change: 0, index: 25, value: 70000 },
    ]);
    const found = await discover(node, wallet, 860010);
    expect(found.ok).toBe(true);
    expect(found.balance).toBe(170000n);
  });

  it('walks the change branch too', async () => {
    /* A wallet that has spent once has its change on the second branch. Not
     * scanning it shows a balance missing the owner's own money, which is the
     * most alarming way for a wallet to be wrong. */
    const node = nodeWith([{ change: 1, index: 3, value: 48000 }]);
    const found = await discover(node, wallet, 860010);
    expect(found.ok).toBe(true);
    expect(found.balance).toBe(48000n);
    expect(found.utxos[0]!.path).toEqual({ change: 1, index: 3 });
  });

  it('stops, so a hostile node cannot walk a wallet forever', { timeout: 30_000 }, async () => {
    /* Every address used means the gap never arrives. Without a cap the scan
     * runs until the phone gives up, which is a denial of service dressed as
     * a wallet that will not load. */
    const found = await discover(recorded(everyAddressUsed()), wallet, 860010);
    expect(found.addresses.length).toBeLessThanOrEqual(2 * MAX_ADDRESSES);
  });

  /**
   * Reaching the cap is a refusal, not a balance.
   *
   * The two exits from the walk are not the same event. Closing the gap means
   * the account really does end there. Hitting the cap means the walk stopped
   * while the account was still in use, so there are addresses past it holding
   * coins nobody asked the node about. Both used to return `problem: null`,
   * which made the second one report a confidently short balance under the
   * word BALANCE, through the very mechanism that exists to bound the scan.
   *
   * The fixture funds every address it serves, so the shortfall is real money
   * rather than a flag: `MAX_ADDRESSES` addresses at 1000 sat each on each
   * branch is what a passing `ok: true` would have been claiming as the whole
   * balance of an account holding more.
   */
  it('refuses rather than reporting the part of a capped wallet it reached', { timeout: 30_000 }, async () => {
    const answers = everyAddressUsed(1000);
    const found = await discover(recorded(answers), wallet, 860010);

    expect(found.ok, 'a capped walk reported itself as a finished one').toBe(false);
    expect(found.truncated).toBe(true);
    expect(found.balance, 'it reported the partial total it reached').toBe(0n);
    expect(found.utxos).toEqual([]);
    expect(found.problem).toMatch(new RegExp(`more than ${MAX_ADDRESSES}`));
    /* A sentence, and one that says where the coins are, because the person
     * reading it has done nothing wrong and their money is not gone. */
    expect(found.problem).toMatch(/on the chain/);
  });

  it('does not call an account that ends inside the cap truncated', { timeout: 30_000 }, async () => {
    /* The other half of the pair, so the refusal above cannot be satisfied by
     * a function that refuses everything. This account uses an unbroken run of
     * receive addresses ending far enough below the cap that its gap still
     * closes, which is the honest stop, and it gets its full balance. */
    const lastUsed = MAX_ADDRESSES - GAP_LIMIT - 11;
    const answers = everyAddressUsed(1000);
    for (const branch of [0, 1] as const) {
      for (let i = 0; i < MAX_ADDRESSES; i++) {
        if (branch === 0 && i <= lastUsed) continue;
        const address = addressOf(branch, i);
        answers[`GET /address/${address}`] = UNUSED;
        answers[`GET /address/${address}/utxo`] = '[]';
      }
    }

    const found = await discover(recorded(answers), wallet, 860010);
    expect(found.ok, found.problem ?? '').toBe(true);
    expect(found.truncated).toBe(false);
    expect(found.balance).toBe(BigInt(lastUsed + 1) * 1000n);
  });
});

describe('a scan that did not finish is not a balance', () => {
  it('reports the problem instead of the total it managed to reach', async () => {
    /* The important one. A partial scan that returns its partial sum shows a
     * number that is confidently too low, and a number invites a decision. */
    const answers: Record<string, string | { status: number; body: string }> = {};
    for (let i = 0; i < 40; i++) {
      const { address } = addressAt(wallet, 0, i);
      answers[`GET /address/${address}`] = i === 5
        ? { status: 500, body: 'upstream is unwell' }
        : stats(i === 0 ? 500000 : 0, i === 0 ? 1 : 0);
      answers[`GET /address/${address}/utxo`] = '[]';
    }
    const found = await discover(recorded(answers), wallet, 860010);
    expect(found.ok).toBe(false);
    expect(found.problem).toMatch(/trouble/);
    expect(found.balance, 'it reported a partial total').toBe(0n);
    expect(found.utxos).toEqual([]);
  });

  it('fails the same way when the outputs call fails', async () => {
    const answers: Record<string, string | { status: number; body: string }> = {};
    for (const branch of [0, 1] as const) {
      for (let i = 0; i < 40; i++) {
        const { address } = addressAt(wallet, branch, i);
        const used = branch === 0 && i === 0;
        answers[`GET /address/${address}`] = used ? stats(500000, 1) : UNUSED;
        answers[`GET /address/${address}/utxo`] = used
          ? { status: 503, body: 'busy' }
          : '[]';
      }
    }
    const found = await discover(recorded(answers), wallet, 860010);
    expect(found.ok).toBe(false);
    expect(found.balance).toBe(0n);
  });
});

describe('what the scan tells the node about you', () => {
  it('asks about unused addresses once and never asks for their outputs', async () => {
    /* The one privacy reduction available here. An account with one used
     * address out of forty-plus asks for one address's outputs, not forty. */
    const node = nodeWith([{ change: 0, index: 0, value: 100000 }]);
    await discover(node, wallet, 860010);
    const utxoCalls = node.asked.filter((call) => call.endsWith('/utxo'));
    expect(utxoCalls).toHaveLength(1);
  });

  it('reports how many addresses it named, because that is the leak', async () => {
    const node = nodeWith([{ change: 0, index: 0, value: 100000 }]);
    const found = await discover(node, wallet, 860010);
    expect(found.queried).toBeGreaterThan(GAP_LIMIT);
    expect(found.queried).toBe(node.asked.length);
  });
});

describe('confirmations and ordering', () => {
  it('counts confirmations from the tip the snapshot was taken at', async () => {
    const node = nodeWith([{ change: 0, index: 0, value: 100000 }]);
    const found = await discover(node, wallet, 860010);
    expect(found.utxos[0]!.confirmations).toBe(11);
  });

  it('never shows more confirmations than the chain has blocks', async () => {
    /* A node mid-reorg can report a height below an output's block. One
     * confirmation minus nothing is zero, not a negative number rendered as
     * "-3 confirmations". */
    const node = nodeWith([{ change: 0, index: 0, value: 100000 }]);
    const found = await discover(node, wallet, 859000);
    expect(found.utxos[0]!.confirmations).toBe(0);
  });

  it('keeps unconfirmed coins out of the spendable total but in the balance', async () => {
    const { address } = addressAt(wallet, 0, 0);
    const answers: Record<string, string> = { [`GET /address/${address}`]: stats(90000, 1) };
    answers[`GET /address/${address}/utxo`] = JSON.stringify([
      { txid: 'a'.repeat(64), vout: 0, value: 60000, status: { confirmed: true, block_height: 860000 } },
      { txid: 'b'.repeat(64), vout: 0, value: 30000, status: { confirmed: false } },
    ]);
    for (const branch of [0, 1] as const) {
      for (let i = branch === 0 ? 1 : 0; i < 40; i++) {
        const derived = addressAt(wallet, branch, i);
        answers[`GET /address/${derived.address}`] = UNUSED;
      }
    }
    const found = await discover(recorded(answers), wallet, 860010);
    expect(found.balance).toBe(90000n);
    expect(found.spendable).toBe(60000n);
  });

  it('orders outputs the same way every time', async () => {
    /* Coin selection reads this list. An order that depends on which node
     * answered first is a transaction that changes shape between the screen
     * and the signature. */
    const node = nodeWith([
      { change: 0, index: 2, value: 10000 },
      { change: 1, index: 1, value: 20000 },
      { change: 0, index: 0, value: 30000 },
    ]);
    const first = await discover(node, wallet, 860010);
    const second = await discover(nodeWith([
      { change: 0, index: 2, value: 10000 },
      { change: 1, index: 1, value: 20000 },
      { change: 0, index: 0, value: 30000 },
    ]), wallet, 860010);
    expect(first.utxos.map((u) => u.txid)).toEqual(second.utxos.map((u) => u.txid));
    const sorted = [...first.utxos].sort((a, b) => (a.txid < b.txid ? -1 : 1));
    expect(first.utxos.map((u) => u.txid)).toEqual(sorted.map((u) => u.txid));
  });
});

describe('the next address to hand out', () => {
  it('is the first the chain has not seen', async () => {
    const node = nodeWith([
      { change: 0, index: 0, value: 1000 },
      { change: 0, index: 1, value: 1000 },
    ]);
    const found = await discover(node, wallet, 860010);
    const next = nextReceiveAddress(found.addresses);
    expect(next?.index).toBe(2);
    expect(next?.change).toBe(0);
  });

  it('never hands out a change address', async () => {
    /* Change addresses are derived on a different branch and handing one out
     * is how a wallet starts labeling its own change as somebody's payment. */
    const node = nodeWith([{ change: 1, index: 0, value: 1000 }]);
    const found = await discover(node, wallet, 860010);
    expect(nextReceiveAddress(found.addresses)?.change).toBe(0);
  });
});

describe('fee options come from the node, with a floor', () => {
  it('picks three targets out of the node table', () => {
    const options = feeOptionsFrom({ 1: 18.2, 6: 9.4, 144: 2.1 });
    expect(options.map((o) => o.rate)).toEqual([2.1, 9.4, 18.2]);
  });

  it('never goes below one satoshi per byte', () => {
    /* An empty mempool produces estimates under the relay minimum, and a
     * transaction built at that rate is one no peer forwards. */
    const options = feeOptionsFrom({ 1: 0.4, 6: 0.2, 144: 0.1 });
    for (const option of options) expect(option.rate).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the nearest target it does have', () => {
    const options = feeOptionsFrom({ 3: 11 });
    expect(options.find((o) => o.key === 'standard')!.rate).toBe(11);
  });
});

describe('history', () => {
  const ours = new Set(['bc1qmine', 'bc1qchange']);

  it('calls a transaction sent when our addresses paid into it', () => {
    const history = historyFrom(
      [{
        txid: 'a'.repeat(64),
        fee: 1420n,
        confirmed: true,
        height: 860000,
        time: 1727000000,
        inputs: [{ address: 'bc1qmine', value: 200000n }],
        outputs: [
          { address: 'bc1qstranger', value: 150000n },
          { address: 'bc1qchange', value: 48580n },
        ],
      }],
      ours,
      860005,
    );
    expect(history[0]!.direction).toBe('sent');
    /* What left, not what the inputs held. A payment with change that reported
     * the input total would tell somebody they spent four times what they did. */
    expect(history[0]!.amount).toBe(150000n);
    expect(history[0]!.fee).toBe(1420n);
    expect(history[0]!.confirmations).toBe(6);
  });

  it('calls it received when none of our addresses paid in', () => {
    const history = historyFrom(
      [{
        txid: 'b'.repeat(64),
        fee: 900n,
        confirmed: true,
        height: 860000,
        time: 1727000000,
        inputs: [{ address: 'bc1qstranger', value: 500000n }],
        outputs: [{ address: 'bc1qmine', value: 499100n }],
      }],
      ours,
      860000,
    );
    expect(history[0]!.direction).toBe('received');
    expect(history[0]!.amount).toBe(499100n);
    /* Somebody else paid it. Showing their fee as ours would be a number the
     * owner never spent. */
    expect(history[0]!.fee).toBe(0n);
  });

  it('shows one entry when several of our addresses touch one transaction', () => {
    const tx = {
      txid: 'c'.repeat(64),
      fee: 500n,
      confirmed: false,
      height: null,
      time: null,
      inputs: [{ address: 'bc1qmine', value: 100000n }],
      outputs: [{ address: 'bc1qstranger', value: 99500n }],
    };
    // The same transaction arrives once per address whose history was fetched.
    expect(historyFrom([tx, tx, tx], ours, 860000)).toHaveLength(1);
  });

  it('leaves an unreadable counterparty empty rather than inventing words', () => {
    const history = historyFrom(
      [{
        txid: 'd'.repeat(64),
        fee: 0n,
        confirmed: true,
        height: 860000,
        time: 1727000000,
        inputs: [{ address: 'bc1qmine', value: 1000n }],
        outputs: [{ address: null, value: 900n }],
      }],
      ours,
      860000,
    );
    expect(history[0]!.counterparty).toBe('');
  });

  it('has no opinion about fiat, because there is no price source', () => {
    /* Null renders as nothing. Zero renders as "$0.00", which is a claim about
     * what somebody's money was worth. */
    const history = historyFrom(
      [{
        txid: 'e'.repeat(64), fee: 0n, confirmed: true, height: 1, time: 1,
        inputs: [], outputs: [{ address: 'bc1qmine', value: 5n }],
      }],
      ours,
      1,
    );
    expect(history[0]!.fiatCents).toBeNull();
  });
});
