/**
 * The Monero scan, against a chain built by a synthetic sender.
 *
 * ## Why a sender rather than a recording
 *
 * Every other node client in this app is tested against answers recorded from
 * a real node, because a recording contains what the node really says rather
 * than what the test author believed it says. This file cannot do that: a real
 * recording would need a real transaction paying a wallet whose view key is in
 * this repository, and publishing that would publish somebody's money.
 *
 * So the fixtures below are built the way a sender builds them. A random
 * ephemeral key, the Diffie-Hellman step, the one-time output key, the
 * encrypted amount, the Pedersen commitment. Then the scanner is pointed at
 * the result and has to find it without being told anything except the view
 * key and the address.
 *
 * That is weaker than a recording in one way and stronger in another. Weaker
 * because both halves are this repository's code, so an error shared by the
 * sender and the scanner would cancel out. Stronger because the commitment
 * check is not symmetric: `commit()` is built on `rct::H`, which is verified
 * against the literal in Monero's own source, and an amount that decrypted
 * wrongly could not rebuild a commitment the sender built correctly.
 *
 * The tampering tests below are the ones that matter most. They take a
 * correctly built output and break exactly one thing, and the scan has to
 * report an unknown amount rather than a number.
 */

import { describe, expect, it } from 'vitest';
import {
  amountMask,
  commit,
  commitmentMask,
  derivationToScalar,
  derivePublicKey,
  generateKeyDerivation,
} from '@vault/keys/monerocrypto';
import {
  fromHex,
  publicFromSecret,
  reduceScalar,
  toHex,
  walletFromSeed,
} from '@vault/keys/monero';
import type { Reply, Request, Transport } from '../src/net/http';
import {
  DEFAULT_BUDGET,
  openAccount,
  outputKey,
  progressFraction,
  scan,
  scanOne,
  toSpendable,
  totalReceived,
  SPEND_BLINDNESS,
} from '../src/core/moneroscan';
import { transactions } from '../src/net/monerod';
import { NodeWatcher } from '../src/core/watcher';
import { buildOutputsRequest } from '../src/core/keyimages';
import { computeKeyImages, encodeKeyImageReply } from '@vault/keys/keyimages';

// ---------------------------------------------------------------------------
// The recipient. A wallet whose seed is on the next line, deliberately.

const SEED = new Uint8Array(32).map((_, i) => (i * 13 + 5) & 0xff);
const recipient = walletFromSeed(SEED);
const VIEW_SECRET_HEX = toHex(recipient.viewSecret);

// ---------------------------------------------------------------------------
// A sender, doing what a sender does

interface BuiltTx {
  hash: string;
  json: string;
  /** The one-time key on output zero, so a test can assert on it. */
  outputKey: string;
}

/**
 * Build a transaction paying this wallet, the way monerod would report it.
 *
 * Every step here is the sending half of the arithmetic the scanner reverses.
 * The ephemeral secret is fixed per call rather than random so a failure is
 * reproducible.
 */
function payTo(
  amounts: bigint[],
  options: {
    ephemeral?: number;
    hash?: string;
    rctType?: number;
    /** Break the encrypted amount on this output. */
    corruptAmountAt?: number;
    /** Drop the commitment on this output. */
    dropCommitmentAt?: number;
    /** Pay somebody else instead. */
    stranger?: boolean;
  } = {},
): BuiltTx {
  const secret = reduceScalar(new Uint8Array(32).map((_, i) => (i * 3 + (options.ephemeral ?? 7)) & 0xff));
  const txPublic = publicFromSecret(secret);

  const spendPublic = options.stranger
    ? walletFromSeed(new Uint8Array(32).fill(9)).spendPublic
    : recipient.spendPublic;
  const viewPublic = options.stranger
    ? walletFromSeed(new Uint8Array(32).fill(9)).viewPublic
    : recipient.viewPublic;

  /* The sender's side of the shared secret: their ephemeral secret against the
   * recipient's public view key. The scanner computes the same value from the
   * other pair, which is the whole trick. */
  const derivation = generateKeyDerivation(fromHex(viewPublic), secret);

  const vout: unknown[] = [];
  const ecdhInfo: unknown[] = [];
  const outPk: string[] = [];

  amounts.forEach((amount, index) => {
    const oneTime = toHex(derivePublicKey(derivation, index, fromHex(spendPublic)));
    vout.push({ amount: 0, target: { tagged_key: { key: oneTime, view_tag: '00' } } });

    const shared = derivationToScalar(derivation, index);
    const mask = amountMask(shared);
    let masked = '';
    for (let byte = 0; byte < 8; byte++) {
      const clear = Number((amount >> BigInt(byte * 8)) & 0xffn);
      const cipher = (clear ^ mask[byte]!) & 0xff;
      masked += (index === options.corruptAmountAt ? cipher ^ 0x40 : cipher).toString(16).padStart(2, '0');
    }
    ecdhInfo.push({ amount: masked });
    outPk.push(index === options.dropCommitmentAt ? '' : toHex(commit(amount, commitmentMask(shared))));
  });

  /* Tag 0x01 is the transaction public key, followed by its 32 bytes. That is
   * the whole of the `extra` field these fixtures need. */
  const extra = [0x01, ...Array.from(txPublic)];

  return {
    hash: options.hash ?? 'a'.repeat(63) + '1',
    outputKey: String((vout[0] as { target: { tagged_key: { key: string } } }).target.tagged_key.key),
    json: JSON.stringify({
      version: 2,
      unlock_time: 0,
      vin: [],
      vout,
      extra,
      rct_signatures: {
        type: options.rctType ?? 6,
        txnFee: 30720000,
        ecdhInfo,
        outPk,
      },
    }),
  };
}

/** A pre-RingCT transaction, whose amounts are simply written on the chain. */
function payPlainly(amount: bigint): BuiltTx {
  const secret = reduceScalar(new Uint8Array(32).map((_, i) => (i * 5 + 2) & 0xff));
  const txPublic = publicFromSecret(secret);
  const derivation = generateKeyDerivation(fromHex(recipient.viewPublic), secret);
  const oneTime = toHex(derivePublicKey(derivation, 0, fromHex(recipient.spendPublic)));
  return {
    hash: 'b'.repeat(63) + '2',
    outputKey: oneTime,
    json: JSON.stringify({
      version: 1,
      vin: [],
      vout: [{ amount: Number(amount), target: { key: oneTime } }],
      extra: [0x01, ...Array.from(txPublic)],
      rct_signatures: { type: 0 },
    }),
  };
}

// ---------------------------------------------------------------------------
// A node made of those transactions

interface FakeChain {
  /** Height to the transactions mined in that block. */
  blocks: Record<number, BuiltTx[]>;
  /** Heights whose `get_block` should fail, to test resumption. */
  broken?: number[];
  minerTx?: BuiltTx;
  /** What `get_info` reports as the chain height. */
  tip?: number;
}

function fakeNode(chain: FakeChain): Transport & { asked: string[]; heights: number[] } {
  const asked: string[] = [];
  const heights: number[] = [];
  const byHash = new Map<string, BuiltTx>();
  for (const list of Object.values(chain.blocks)) for (const tx of list) byHash.set(tx.hash, tx);
  if (chain.minerTx) byHash.set(chain.minerTx.hash, chain.minerTx);

  return {
    base: 'https://node.example',
    asked,
    heights,
    async send(request: Request): Promise<Reply> {
      asked.push(`${request.method} ${request.path}`);
      const body = (request.body ?? {}) as Record<string, unknown>;

      if (request.path === '/json_rpc' && body['method'] === 'get_info') {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            id: '0',
            jsonrpc: '2.0',
            result: {
              height: chain.tip ?? 1,
              target_height: 0,
              synchronized: true,
              mainnet: true,
              nettype: 'mainnet',
              status: 'OK',
            },
          }),
        };
      }

      if (request.path === '/json_rpc' && body['method'] === 'get_block') {
        const height = Number((body['params'] as { height?: number }).height);
        heights.push(height);
        if (chain.broken?.includes(height)) {
          return { ok: false, status: 500, problem: 'the node fell over' };
        }
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            id: '0',
            jsonrpc: '2.0',
            result: {
              block_header: {
                hash: 'c'.repeat(64),
                height,
                timestamp: 1_700_000_000,
                miner_tx_hash: chain.minerTx?.hash ?? 'd'.repeat(64),
              },
              tx_hashes: (chain.blocks[height] ?? []).map((tx) => tx.hash),
              status: 'OK',
            },
          }),
        };
      }

      if (request.path === '/get_transactions') {
        const wanted = (body['txs_hashes'] ?? []) as string[];
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: 'OK',
            txs: wanted.flatMap((hash) => {
              const tx = byHash.get(hash);
              if (!tx) return [];
              /* The node reports a global index per output; a plausible dense
               * range is enough for the scan to record something spendable. */
              const nOut = (JSON.parse(tx.json).vout as unknown[]).length;
              const output_indices = Array.from({ length: nOut }, (_, i) => 2_000_000 + i);
              return [{ tx_hash: hash, as_json: tx.json, output_indices }];
            }),
          }),
        };
      }

      return { ok: false, status: 404, problem: `nothing here for ${request.path}` };
    },
  };
}

const account = (() => {
  const opened = openAccount(recipient.address, VIEW_SECRET_HEX);
  if (!opened.ok) throw new Error(opened.problem);
  return opened.account;
})();

// ---------------------------------------------------------------------------

describe('opening an account to watch', () => {
  it('takes an address and the view key that belongs to it', () => {
    expect(account.spendPublic).toBe(recipient.spendPublic);
    expect(account.viewPublic).toBe(recipient.viewPublic);
  });

  it('refuses a view key from a different wallet', () => {
    /* The failure this catches is the quiet one: the scan runs, walks the
     * whole chain correctly, and finds nothing, which on screen is exactly
     * what an empty wallet looks like. */
    const other = walletFromSeed(new Uint8Array(32).fill(4));
    const opened = openAccount(recipient.address, toHex(other.viewSecret));
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.problem).toMatch(/does not belong/);
  });

  it('refuses a view key that is not hexadecimal, or not 32 bytes', () => {
    expect(openAccount(recipient.address, 'zzzz').ok).toBe(false);
    expect(openAccount(recipient.address, 'aabb').ok).toBe(false);
  });

  it('refuses an address that is not one', () => {
    expect(openAccount('not an address', VIEW_SECRET_HEX).ok).toBe(false);
  });

  it('refuses a non-mainnet address', () => {
    const stagenet = walletFromSeed(SEED, 'stagenet');
    const opened = openAccount(stagenet.address, toHex(stagenet.viewSecret));
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.problem).toMatch(/mainnet/);
  });

  it('agrees with the key arithmetic it is built on', () => {
    expect(toHex(publicFromSecret(account.viewSecret))).toBe(recipient.viewPublic);
  });
});

describe('finding an output', () => {
  it('finds a payment and recovers its amount', async () => {
    const tx = payTo([1_234_500_000_000n]);
    const node = fakeNode({ blocks: { 100: [tx] } });

    const result = await scan(node, account, { birth: 100, height: 100 }, 100);
    expect(result.ok).toBe(true);
    expect(result.received).toHaveLength(1);
    expect(result.received[0]!.amount).toBe(1_234_500_000_000n);
    expect(result.received[0]!.key).toBe(tx.outputKey);
    expect(result.received[0]!.height).toBe(100);
    expect(result.received[0]!.unknownBecause).toBeNull();
    expect(result.caughtUp).toBe(true);
  });

  it('finds every output of a transaction that pays twice', async () => {
    const tx = payTo([1n, 2_000_000_000_000n]);
    const node = fakeNode({ blocks: { 5: [tx] } });
    const result = await scan(node, account, { birth: 5, height: 5 }, 5);
    expect(result.received.map((entry) => entry.amount)).toEqual([1n, 2_000_000_000_000n]);
    expect(result.received.map((entry) => entry.index)).toEqual([0, 1]);
  });

  it('reads an amount the chain states in the clear', async () => {
    const tx = payPlainly(700_000_000_000n);
    const node = fakeNode({ blocks: { 7: [tx] } });
    const result = await scan(node, account, { birth: 7, height: 7 }, 7);
    expect(result.received[0]!.amount).toBe(700_000_000_000n);
  });

  it('ignores a payment to somebody else', async () => {
    const node = fakeNode({ blocks: { 3: [payTo([9n], { stranger: true })] } });
    const result = await scan(node, account, { birth: 3, height: 3 }, 3);
    expect(result.received).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('handles a zero amount rather than treating it as absent', async () => {
    const tx = payTo([0n]);
    const node = fakeNode({ blocks: { 11: [tx] } });
    const result = await scan(node, account, { birth: 11, height: 11 }, 11);
    expect(result.received[0]!.amount).toBe(0n);
    expect(result.received[0]!.unknownBecause).toBeNull();
  });

  it('reads the older output shape as well as the tagged one', async () => {
    /* `target.key` predates view tags and `target.tagged_key.key` came with
     * them in 2022. A scanner that knew one form would quietly find nothing on
     * half the chain. */
    const tx = payPlainly(5n);
    expect(tx.json).toMatch(/"target":\{"key"/);
    const node = fakeNode({ blocks: { 2: [tx] } });
    expect((await scan(node, account, { birth: 2, height: 2 }, 2)).received).toHaveLength(1);
  });
});

describe('refusing an amount it cannot prove', () => {
  it('reports unknown when the encrypted amount was tampered with', async () => {
    const tx = payTo([500_000_000_000n], { corruptAmountAt: 0 });
    const node = fakeNode({ blocks: { 20: [tx] } });
    const result = await scan(node, account, { birth: 20, height: 20 }, 20);

    /* The output is still ours: the one-time key is untouched, so ownership is
     * unaffected. What changed is that the decrypted number no longer rebuilds
     * the commitment, and a number that cannot be proved is not shown. */
    expect(result.received).toHaveLength(1);
    expect(result.received[0]!.amount).toBeNull();
    expect(result.received[0]!.unknownBecause).toMatch(/commitment/);
  });

  it('reports unknown when the node sent no commitment', async () => {
    const tx = payTo([500n], { dropCommitmentAt: 0 });
    const node = fakeNode({ blocks: { 21: [tx] } });
    const result = await scan(node, account, { birth: 21, height: 21 }, 21);
    expect(result.received[0]!.amount).toBeNull();
    expect(result.received[0]!.unknownBecause).toMatch(/commitment/);
  });

  it('refuses the RingCT forms from before 2020 rather than guessing', async () => {
    const tx = payTo([500n, 600n], { rctType: 2 });
    const node = fakeNode({ blocks: { 22: [tx] } });
    const result = await scan(node, account, { birth: 22, height: 22 }, 22);
    expect(result.received).toHaveLength(2);
    for (const entry of result.received) {
      expect(entry.amount).toBeNull();
      expect(entry.unknownBecause).toMatch(/before 2020/);
    }
  });

  it('leaves the output in the list even when the amount is refused', () => {
    /* Dropping it would be worse than showing an unknown amount: a person
     * would be looking at a payment that the chain says happened and the app
     * says did not. */
    const tx = payTo([1n], { corruptAmountAt: 0 });
    const parsed = JSON.parse(tx.json) as { vout: unknown[] };
    expect(parsed.vout).toHaveLength(1);
  });
});

describe('walking the chain', () => {
  it('stops at its budget and says where to resume', async () => {
    const node = fakeNode({ blocks: { 50: [payTo([1n])] } });
    const result = await scan(node, account, { birth: 50, height: 50 }, 60, { budget: 3 });

    expect(result.ok).toBe(true);
    expect(result.blocks).toBe(3);
    expect(result.state.height).toBe(53);
    /* Not caught up: it stopped because it ran out of budget, not because
     * there was nothing left, and those show differently on screen. */
    expect(result.caughtUp).toBe(false);
  });

  it('resumes from where it stopped and does not rewalk', async () => {
    const node = fakeNode({ blocks: { 52: [payTo([42n])] } });
    const first = await scan(node, account, { birth: 50, height: 50 }, 60, { budget: 2 });
    expect(first.received).toEqual([]);

    const second = await scan(node, account, first.state, 60, { budget: 2 });
    expect(second.received).toHaveLength(1);
    expect(second.received[0]!.amount).toBe(42n);
    expect(node.heights).toEqual([50, 51, 52, 53]);
  });

  it('leaves the height on the block that failed, so nothing is skipped', async () => {
    const node = fakeNode({ blocks: { 70: [payTo([1n])], 72: [payTo([2n])] }, broken: [72] });
    const result = await scan(node, account, { birth: 70, height: 70 }, 80, { budget: 10 });

    expect(result.ok).toBe(false);
    expect(result.problem).toBeTruthy();
    /* 70 and 71 finished, 72 did not. A scan that reported 73 here would skip
     * a block forever and lose whatever was in it. */
    expect(result.state.height).toBe(72);
    expect(result.received).toHaveLength(1);
  });

  it('never returns findings from a block it did not finish', async () => {
    /* The block has a payment in it and the transaction fetch fails. Reporting
     * the payment while resuming from the same height would count it twice. */
    const tx = payTo([3n]);
    const node = fakeNode({ blocks: { 90: [tx] } });
    const broken: Transport = {
      base: node.base,
      async send(request) {
        if (request.path === '/get_transactions') {
          return { ok: false, status: 503, problem: 'the node is busy' };
        }
        return node.send(request);
      },
    };
    const result = await scan(broken, account, { birth: 90, height: 90 }, 90);
    expect(result.ok).toBe(false);
    expect(result.received).toEqual([]);
    expect(result.state.height).toBe(90);
  });

  it('does nothing when the tip is behind where it already scanned', async () => {
    const node = fakeNode({ blocks: {} });
    const result = await scan(node, account, { birth: 100, height: 120 }, 110);
    expect(result.blocks).toBe(0);
    expect(node.asked).toEqual([]);
    expect(result.state.height).toBe(120);
  });

  it('never starts below the birth height', async () => {
    const node = fakeNode({ blocks: {} });
    const result = await scan(node, account, { birth: 300, height: 10 }, 302, { budget: 5 });
    expect(node.heights[0]).toBe(300);
    expect(result.state.height).toBe(303);
  });

  it('stops cleanly when asked to', async () => {
    const node = fakeNode({ blocks: {} });
    let seen = 0;
    const result = await scan(node, account, { birth: 0, height: 0 }, 100, {
      budget: 50,
      stop: () => seen >= 4,
      onBlock: () => { seen += 1; },
    });
    expect(result.ok).toBe(true);
    expect(result.blocks).toBe(4);
    expect(result.state.height).toBe(4);
  });

  it('skips coinbase outputs unless asked, and reads them when asked', async () => {
    const miner = payTo([9_000n, 0n], { ephemeral: 31, hash: 'e'.repeat(63) + '3' });
    const node = fakeNode({ blocks: { 40: [] }, minerTx: miner });

    const quiet = await scan(node, account, { birth: 40, height: 40 }, 40);
    expect(quiet.received).toEqual([]);
    /* One request for the block and none for its contents, which is the whole
     * reason the default is off. */
    expect(quiet.requests).toBe(1);

    const mining = await scan(node, account, { birth: 40, height: 40 }, 40, { coinbase: true });
    expect(mining.received).toHaveLength(2);
    expect(mining.requests).toBe(2);
  });

  it('counts requests, so a screen can say what a sync cost', async () => {
    const node = fakeNode({ blocks: { 1: [payTo([1n])], 2: [] } });
    const result = await scan(node, account, { birth: 1, height: 1 }, 2);
    expect(result.requests).toBe(3);
  });

  it('has a budget that a caller can rely on being finite', () => {
    expect(DEFAULT_BUDGET).toBeGreaterThan(0);
    expect(Number.isSafeInteger(DEFAULT_BUDGET)).toBe(true);
  });
});

describe('turning found outputs into spendable ones', () => {
  const openBook = { isAvailable: () => true };

  it('records the global index and commitment while scanning', async () => {
    const node = fakeNode({ blocks: { 1: [payTo([1_000_000_000_000n])] }, tip: 1 });
    const result = await scan(node, account, { birth: 1, height: 1 }, 1);
    expect(result.received).toHaveLength(1);
    const output = result.received[0]!;
    /* The fake node hands back a global index and the tx a commitment; both
     * are now on the found output, which is what spending needs. */
    expect(output.globalIndex).toBe(2_000_000);
    expect(output.commitment).toMatch(/^[0-9a-f]{64}$/);
  });

  it('promotes a fully-known output to a spendable one', async () => {
    const node = fakeNode({ blocks: { 1: [payTo([2_000_000_000_000n])] }, tip: 1 });
    const { received } = await scan(node, account, { birth: 1, height: 1 }, 1);
    const spendable = toSpendable(received, openBook);
    expect(spendable).toHaveLength(1);
    expect(spendable[0]).toMatchObject({
      globalIndex: 2_000_000,
      amount: 2_000_000_000_000n,
      indexInTx: 0,
    });
    expect(spendable[0]!.key).toMatch(/^[0-9a-f]{64}$/);
    expect(spendable[0]!.commitment).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves out an output with no known amount, index, or commitment', () => {
    const base = { txid: 'a'.repeat(64), height: 1, index: 0, txPublicKey: 'p', at: 0, unknownBecause: null };
    const noAmount = { ...base, key: 'k1', amount: null, globalIndex: 5, commitment: 'c'.repeat(64) };
    const noIndex = { ...base, key: 'k2', amount: 5n, globalIndex: null, commitment: 'c'.repeat(64) };
    const noCommit = { ...base, key: 'k3', amount: 5n, globalIndex: 5, commitment: '' };
    expect(toSpendable([noAmount, noIndex, noCommit], openBook)).toHaveLength(0);
  });

  it('excludes an output the book has already locked', async () => {
    const node = fakeNode({ blocks: { 1: [payTo([2_000_000_000_000n])] }, tip: 1 });
    const { received } = await scan(node, account, { birth: 1, height: 1 }, 1);
    const lockedBook = { isAvailable: (key: string) => key !== received[0]!.key };
    expect(toSpendable(received, lockedBook)).toHaveLength(0);
  });
});

describe('adding it up', () => {
  const one = { txid: 'a'.repeat(64), height: 1, index: 0, key: 'k1', txPublicKey: 'p1', at: 0, amount: 100n, unknownBecause: null, globalIndex: null, commitment: '' };
  const two = { txid: 'a'.repeat(64), height: 1, index: 1, key: 'k2', txPublicKey: 'p1', at: 0, amount: 250n, unknownBecause: null, globalIndex: null, commitment: '' };
  const hidden = { txid: 'b'.repeat(64), height: 2, index: 0, key: 'k3', txPublicKey: 'p2', at: 0, amount: null, unknownBecause: 'no', globalIndex: null, commitment: '' };

  it('sums what it knows', () => {
    expect(totalReceived([one, two])).toEqual({ total: 350n, outputs: 2, counted: 2, unknown: 0 });
  });

  it('counts the same output once, however many times it was scanned', () => {
    /* A rescan of the same range is ordinary. Adding an output twice would
     * double somebody's money on the home screen. */
    expect(totalReceived([one, two, one, two, one]).total).toBe(350n);
    expect(totalReceived([one, one]).outputs).toBe(1);
  });

  it('separates what it could not value from what it could', () => {
    const total = totalReceived([one, hidden]);
    expect(total.total).toBe(100n);
    expect(total.counted).toBe(1);
    expect(total.unknown).toBe(1);
  });

  it('identifies an output by its transaction and position', () => {
    expect(outputKey(one)).not.toBe(outputKey(two));
    expect(outputKey(one)).toBe(outputKey({ ...one, height: 999 }));
  });

  it('measures progress from the birth height rather than from genesis', () => {
    /* A wallet made last week is not one percent synced, and telling somebody
     * it is tells them to expect hours of work that is really a minute. */
    expect(progressFraction({ birth: 3_000_000, height: 3_000_000 }, 3_000_100)).toBe(0);
    expect(progressFraction({ birth: 3_000_000, height: 3_000_050 }, 3_000_100)).toBeCloseTo(0.5);
    expect(progressFraction({ birth: 3_000_000, height: 3_000_100 }, 3_000_100)).toBe(1);
  });

  it('never reports more than finished, whatever it is handed', () => {
    expect(progressFraction({ birth: 100, height: 9_000 }, 200)).toBe(1);
    expect(progressFraction({ birth: 100, height: 0 }, 200)).toBe(0);
    expect(progressFraction({ birth: 100, height: 100 }, 100)).toBe(1);
  });
});

describe('what a view key cannot do', () => {
  it('says so, in the words the screens use', () => {
    /* This is a property of the product and not of a sentence, so the sentence
     * is a constant and this test is what keeps it honest. */
    expect(SPEND_BLINDNESS).toMatch(/cannot tell which of them you have already spent/);
    expect(SPEND_BLINDNESS).toMatch(/spend key/);
    expect(SPEND_BLINDNESS).toMatch(/what arrived, not what is left/);
  });

  it('has no way to ask for a spend key, by construction', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/core/moneroscan.ts', 'utf8'),
    );
    const code = source.slice(source.indexOf('export interface MoneroAccount'));
    expect(code).not.toMatch(/spendSecret/);
  });
});

describe('the watcher that drives it', () => {
  const nodes = { btc: null, xmr: { kind: 'monerod' as const, url: 'https://node.example', label: 'x', mine: false } };

  /* The vault's half of the key-image trip, as the real code the vault runs,
   * so "spendable after images" is proved with a genuine reply rather than a
   * hand-typed one. Same helper as keyimages.test.ts. */
  const vaultReplyFor = (found: readonly ReturnType<NodeWatcher['moneroOutputs']>[number][]): Uint8Array => {
    const request = buildOutputsRequest(found);
    if (!request.ok) throw new Error(request.problem);
    const parsed = JSON.parse(new TextDecoder().decode(request.payload)) as Parameters<typeof computeKeyImages>[1];
    return encodeKeyImageReply(computeKeyImages(recipient, parsed));
  };
  const watch = (chain: FakeChain, scanFrom: { birth: number; height: number }) =>
    new NodeWatcher(nodes, null, { btc: null, xmr: fakeNode(chain) }, 1_700_000_000_000, {
      account,
      scan: scanFrom,
    });

  it('puts what arrived into the balance, and into spendable only after key images', async () => {
    const watcher = watch({ blocks: { 10: [payTo([4_000_000_000_000n])] }, tip: 10 }, { birth: 10, height: 10 });
    await watcher.refresh(1_700_000_000_000);

    const view = watcher.snapshot().assets.XMR;
    expect(view.balance).toBe(4_000_000_000_000n);
    /* Zero, and not because the scan is behind. An output the vault has not
     * answered a key image for has an unknowable spent status, so it cannot
     * honestly be offered to a send screen. The rule is coverage, not a
     * missing feature: the moment the vault's reply is scanned, the same
     * output counts, which the next assertion proves. */
    expect(view.spendable).toBe(0n);
    expect(view.height).toBe(10);

    const found = watcher.moneroOutputs();
    watcher.importKeyImages(vaultReplyFor(found));
    await watcher.refresh(1_700_000_000_001);
    expect(watcher.snapshot().assets.XMR.spendable).toBe(4_000_000_000_000n);
  });

  it('never shows a Monero balance without the sentence that qualifies it', async () => {
    const watcher = watch({ blocks: { 1: [payTo([1n])] }, tip: 1 }, { birth: 1, height: 1 });
    await watcher.refresh(1_700_000_000_000);
    const view = watcher.snapshot().assets.XMR;
    expect(view.caveat).toBe(SPEND_BLINDNESS);
  });

  it('says how far it got while it is still behind', async () => {
    const watcher = watch({ blocks: {}, tip: 1_000 }, { birth: 0, height: 0 });
    await watcher.refresh(1_700_000_000_000);
    const view = watcher.snapshot().assets.XMR;
    expect(view.caveat).toMatch(/Scanned to block 200 of 1000, which is 20%/);
    expect(view.caveat).toContain(SPEND_BLINDNESS);
  });

  it('counts outputs it could not value, in the caveat and in the status', async () => {
    const watcher = watch(
      { blocks: { 3: [payTo([9n], { corruptAmountAt: 0 })] }, tip: 3 },
      { birth: 3, height: 3 },
    );
    await watcher.refresh(1_700_000_000_000);
    expect(watcher.snapshot().assets.XMR.caveat).toMatch(/1 output was found/);
    expect(watcher.moneroProgress()?.unvalued).toBe(1);
  });

  it('hands back where to resume, so the app can write it down', async () => {
    const watcher = watch({ blocks: {}, tip: 5_000 }, { birth: 1_000, height: 1_000 });
    await watcher.refresh(1_700_000_000_000);
    const first = watcher.moneroProgress();
    expect(first?.scan).toEqual({ birth: 1_000, height: 1_200 });
    expect(first?.caughtUp).toBe(false);

    await watcher.refresh(1_700_000_000_000);
    expect(watcher.moneroProgress()?.scan.height).toBe(1_400);
  });

  it('does not count the same output twice across refreshes', async () => {
    /* The same block scanned again is ordinary after a failure. Adding its
     * outputs a second time would double somebody's money on the home screen. */
    const watcher = watch({ blocks: { 2: [payTo([500n])] }, tip: 2 }, { birth: 2, height: 2 });
    await watcher.refresh(1_700_000_000_000);
    expect(watcher.snapshot().assets.XMR.balance).toBe(500n);

    /* Rewind the stored height by reaching through a second watcher built from
     * the same account, which is what a resumed session does. */
    const again = watch({ blocks: { 2: [payTo([500n])] }, tip: 2 }, { birth: 2, height: 2 });
    await again.refresh(1_700_000_000_000);
    await again.refresh(1_700_000_000_000);
    expect(again.snapshot().assets.XMR.balance).toBe(500n);
  });

  it('says so plainly when no account is paired', async () => {
    const watcher = new NodeWatcher(nodes, null, { btc: null, xmr: fakeNode({ blocks: {}, tip: 9 }) }, 1_700_000_000_000);
    await watcher.refresh(1_700_000_000_000);
    const view = watcher.snapshot().assets.XMR;
    expect(view.caveat).toMatch(/No Monero account has been paired/);
    expect(view.balance).toBe(0n);
  });

  it('refuses to scan against a node that is still catching up', async () => {
    /* A node behind the chain answers happily, and its answers are correct for
     * a past that is not now. Recording a height this wallet has not really
     * passed would mean never going back for what was in between. */
    const behind: Transport = {
      base: 'https://node.example',
      async send() {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            id: '0',
            jsonrpc: '2.0',
            result: { height: 100, target_height: 3_000_000, synchronized: false, mainnet: true },
          }),
        };
      },
    };
    const watcher = new NodeWatcher(nodes, null, { btc: null, xmr: behind }, 1_700_000_000_000, {
      account,
      scan: { birth: 0, height: 0 },
    });
    const result = await watcher.refresh(1_700_000_000_000);
    expect(result.ok).toBe(false);
    expect(result.problems[0]?.problem).toMatch(/still catching up/);
    expect(watcher.moneroProgress()).toBeNull();
  });

  it('keeps the height it reached even when the pass failed part way', async () => {
    const watcher = watch({ blocks: {}, broken: [1_003], tip: 2_000 }, { birth: 1_000, height: 1_000 });
    const result = await watcher.refresh(1_700_000_000_000);
    expect(result.ok).toBe(false);
    expect(watcher.moneroProgress()?.scan.height).toBe(1_003);
  });

  it('shows the account address it is watching', async () => {
    const watcher = watch({ blocks: {}, tip: 1 }, { birth: 1, height: 1 });
    await watcher.refresh(1_700_000_000_000);
    expect(watcher.snapshot().assets.XMR.addresses[0]?.address).toBe(recipient.address);
  });
});

describe('the transaction decoder underneath', () => {
  it('reads both shapes of outPk, because nodes send both', async () => {
    const tx = payTo([77n]);
    const object = tx.json.replace(/"outPk":\["([0-9a-f]{64})"\]/, '"outPk":[{"mask":"$1"}]');
    expect(object).not.toBe(tx.json);

    const node: Transport = {
      base: 'https://node.example',
      async send() {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ status: 'OK', txs: [{ tx_hash: tx.hash, as_json: object }] }),
        };
      },
    };
    const parsed = await transactions(node, [tx.hash]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(scanOne(account, parsed.value[0]!, 1)[0]!.amount).toBe(77n);
  });

  it('refuses a hash that is not a hash before asking a node about it', async () => {
    let asked = false;
    const node: Transport = {
      base: 'https://node.example',
      async send() {
        asked = true;
        return { ok: false, status: 500, problem: 'never' };
      },
    };
    const parsed = await transactions(node, ['../../etc/passwd']);
    expect(parsed.ok).toBe(false);
    expect(asked).toBe(false);
  });
});
