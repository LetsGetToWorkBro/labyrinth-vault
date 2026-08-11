/**
 * The key image round trip, end to end, with a spend on the chain.
 *
 * The vault in these tests is the real vault code: `computeKeyImages` from
 * `@vault/keys/keyimages`, operating on a wallet whose seed is below. The
 * chain is synthetic, built by the same sender arithmetic the scanner tests
 * use. What is being proved is the whole loop this feature is:
 *
 *   scan finds outputs → wallet asks → vault answers → a spend appears on the
 *   chain carrying one of those key images → the balance drops by exactly
 *   that output.
 *
 * And the adversarial half: a reply naming keys the wallet never saw is
 * dropped, a spend can never be *invented* by a bad reply, and an answer from
 * `/is_key_image_spent` that does not line up with the question is refused.
 */

import { describe, expect, it } from 'vitest';
import {
  computeKeyImages,
  encodeKeyImageReply,
  KEYIMAGE_VERSION,
} from '@vault/keys/keyimages';
import {
  amountMask,
  commit,
  commitmentMask,
  derivationToScalar,
  derivePublicKey,
  generateKeyDerivation,
} from '@vault/keys/monerocrypto';
import { fromHex, publicFromSecret, reduceScalar, toHex, walletFromSeed } from '@vault/keys/monero';
import type { Reply, Request, Transport } from '../src/net/http';
import { isKeyImageSpent, transactions } from '../src/net/monerod';
import { openAccount, scan, type Received } from '../src/core/moneroscan';
import { buildOutputsRequest, KeyImageBook, settle } from '../src/core/keyimages';
import { moneroCaveat, moneroHistory, NodeWatcher, type MoneroStatus } from '../src/core/watcher';

// ---------------------------------------------------------------------------
// The wallet under test, and a sender

const SEED = new Uint8Array(32).map((_, i) => (i * 13 + 5) & 0xff);
const recipient = walletFromSeed(SEED);

const account = (() => {
  const opened = openAccount(recipient.address, toHex(recipient.viewSecret));
  if (!opened.ok) throw new Error(opened.problem);
  return opened.account;
})();

interface BuiltTx {
  hash: string;
  json: string;
  keys: string[];
}

/** Pay the recipient, RingCT style, the way monerod reports it. */
function payTo(amounts: bigint[], options: { ephemeral?: number; hash?: string } = {}): BuiltTx {
  const secret = reduceScalar(new Uint8Array(32).map((_, i) => (i * 3 + (options.ephemeral ?? 7)) & 0xff));
  const txPublic = publicFromSecret(secret);
  const derivation = generateKeyDerivation(fromHex(recipient.viewPublic), secret);

  const vout: unknown[] = [];
  const ecdhInfo: unknown[] = [];
  const outPk: string[] = [];
  const keys: string[] = [];

  amounts.forEach((amount, index) => {
    const oneTime = toHex(derivePublicKey(derivation, index, fromHex(recipient.spendPublic)));
    keys.push(oneTime);
    vout.push({ amount: 0, target: { tagged_key: { key: oneTime, view_tag: '00' } } });
    const shared = derivationToScalar(derivation, index);
    const mask = amountMask(shared);
    let masked = '';
    for (let byte = 0; byte < 8; byte++) {
      masked += ((Number((amount >> BigInt(byte * 8)) & 0xffn) ^ mask[byte]!) & 0xff)
        .toString(16)
        .padStart(2, '0');
    }
    ecdhInfo.push({ amount: masked });
    outPk.push(toHex(commit(amount, commitmentMask(shared))));
  });

  return {
    hash: options.hash ?? 'a'.repeat(63) + '1',
    keys,
    json: JSON.stringify({
      version: 2,
      vin: [],
      vout,
      extra: [0x01, ...Array.from(txPublic)],
      rct_signatures: { type: 6, ecdhInfo, outPk },
    }),
  };
}

/** A transaction spending by key image, which is all a spend is to a watcher. */
function spendOf(images: string[], hash: string): BuiltTx {
  return {
    hash,
    keys: [],
    json: JSON.stringify({
      version: 2,
      vin: images.map((image) => ({ key: { amount: 0, key_offsets: [1, 2, 3], k_image: image } })),
      vout: [],
      extra: [],
      rct_signatures: { type: 6 },
    }),
  };
}

interface FakeChain {
  blocks: Record<number, BuiltTx[]>;
  tip?: number;
  /** image → status for /is_key_image_spent. Absent means the route 404s. */
  spentAnswers?: Record<string, number>;
}

function fakeNode(chain: FakeChain): Transport & { askedSpent: string[][] } {
  const byHash = new Map<string, BuiltTx>();
  for (const list of Object.values(chain.blocks)) for (const tx of list) byHash.set(tx.hash, tx);
  const askedSpent: string[][] = [];

  return {
    base: 'https://node.example',
    askedSpent,
    async send(request: Request): Promise<Reply> {
      const body = (request.body ?? {}) as Record<string, unknown>;

      if (request.path === '/json_rpc' && body['method'] === 'get_info') {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            id: '0', jsonrpc: '2.0',
            result: { height: chain.tip ?? 1, target_height: 0, synchronized: true, mainnet: true, status: 'OK' },
          }),
        };
      }
      if (request.path === '/json_rpc' && body['method'] === 'get_block') {
        const height = Number((body['params'] as { height?: number }).height);
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            id: '0', jsonrpc: '2.0',
            result: {
              block_header: { hash: 'c'.repeat(64), height, timestamp: 1_700_000_000, miner_tx_hash: 'd'.repeat(64) },
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
              return tx ? [{ tx_hash: hash, as_json: tx.json }] : [];
            }),
          }),
        };
      }
      if (request.path === '/is_key_image_spent') {
        const images = (body['key_images'] ?? []) as string[];
        askedSpent.push(images);
        if (!chain.spentAnswers) return { ok: false, status: 404, problem: 'not here' };
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: 'OK',
            spent_status: images.map((image) => chain.spentAnswers![image] ?? 0),
          }),
        };
      }
      return { ok: false, status: 404, problem: `nothing here for ${request.path}` };
    },
  };
}

/** The vault's half of the trip, as the real code the vault runs. */
function vaultReplyFor(found: readonly Received[]): Uint8Array {
  const request = buildOutputsRequest(found);
  if (!request.ok) throw new Error(request.problem);
  const parsed = JSON.parse(new TextDecoder().decode(request.payload)) as Parameters<typeof computeKeyImages>[1];
  return encodeKeyImageReply(computeKeyImages(recipient, parsed));
}

// ---------------------------------------------------------------------------

describe('the round trip against the chain walk', () => {
  it('finds a spend of an imported key image during the scan', async () => {
    const paid = payTo([5_000n, 7_000n]);
    const chainA = fakeNode({ blocks: { 10: [paid] }, tip: 10 });

    const first = await scan(chainA, account, { birth: 10, height: 10 }, 10);
    expect(first.received).toHaveLength(2);
    expect(first.spent).toEqual([]);

    const book = new KeyImageBook();
    const outcome = book.offerReply(vaultReplyFor(first.received), new Set(first.received.map((r) => r.key)));
    expect(outcome).toMatchObject({ ok: true, added: 2, unknown: 0, refusedByVault: 0 });

    /* The chain moves on: block 11 spends the first output. The walk carries
     * the watch set and reports the match without any extra request. */
    const image = [...book.watch()][0]!;
    const chainB = fakeNode({ blocks: { 11: [spendOf([image], 'e'.repeat(64))] }, tip: 11 });
    const second = await scan(chainB, account, { birth: 10, height: 11 }, 11, { watch: book.watch() });
    expect(second.spent.map((event) => event.image)).toEqual([image]);
    expect(second.spent[0]).toMatchObject({ txid: 'e'.repeat(64), height: 11 });

    book.markSpent(second.spent.map((event) => event.image));
    const settled = settle(first.received, book);
    expect(settled.spentCount).toBe(1);
    /* The balance is exactly the output that was not spent, whichever of the
     * two the image belonged to. */
    const unspent = first.received.find((entry) => !book.isSpent(entry.key))!;
    expect(settled.balance).toBe(unspent.amount);
    expect(settled.spentTotal + settled.balance).toBe(12_000n);
    expect(settled.uncovered).toBe(0);
  });

  it('ignores chain key images nobody asked it to watch', async () => {
    const noise = spendOf(['9'.repeat(64)], 'f'.repeat(64));
    const node = fakeNode({ blocks: { 5: [noise] }, tip: 5 });
    const result = await scan(node, account, { birth: 5, height: 5 }, 5, { watch: new Set(['a'.repeat(64)]) });
    expect(result.spent).toEqual([]);
  });
});

describe('the book', () => {
  const paid = payTo([100n, 200n]);

  async function foundOutputs(): Promise<Received[]> {
    const node = fakeNode({ blocks: { 1: [paid] }, tip: 1 });
    const result = await scan(node, account, { birth: 1, height: 1 }, 1);
    return result.received;
  }

  it('drops images for keys the scan never found, and counts them', async () => {
    const found = await foundOutputs();
    const book = new KeyImageBook();
    const reply = encodeKeyImageReply({
      v: KEYIMAGE_VERSION,
      chain: 'xmr',
      images: [{ key: 'b'.repeat(64), image: 'c'.repeat(64) }],
      refused: [],
    });
    const outcome = book.offerReply(reply, new Set(found.map((r) => r.key)));
    expect(outcome).toMatchObject({ ok: true, added: 0, unknown: 1 });
    expect(book.size()).toBe(0);
  });

  it('cannot be talked into inventing a spend', async () => {
    /* A hostile reply's only lever is images for unknown keys, and those are
     * dropped. Nothing in the book marks anything spent except a chain match
     * or the node's answer, both of which name images already imported. */
    const found = await foundOutputs();
    const book = new KeyImageBook();
    book.offerReply(vaultReplyFor(found), new Set(found.map((r) => r.key)));
    book.markSpent(['f'.repeat(64)]);
    const settled = settle(found, book);
    expect(settled.spentCount).toBe(0);
    expect(settled.balance).toBe(300n);
  });

  it('surfaces what the vault refused', async () => {
    const found = await foundOutputs();
    const book = new KeyImageBook();
    const reply = encodeKeyImageReply({ v: KEYIMAGE_VERSION, chain: 'xmr', images: [], refused: ['d'.repeat(64)] });
    expect(book.offerReply(reply, new Set(found.map((r) => r.key))).refusedByVault).toBe(1);
  });

  it('treats a re-import as idempotent', async () => {
    const found = await foundOutputs();
    const book = new KeyImageBook();
    const known = new Set(found.map((r) => r.key));
    const reply = vaultReplyFor(found);
    expect(book.offerReply(reply, known).added).toBe(2);
    expect(book.offerReply(reply, known).added).toBe(0);
    expect(book.size()).toBe(2);
  });

  it('starts every imported image unsettled, and settles it once', async () => {
    const found = await foundOutputs();
    const book = new KeyImageBook();
    book.offerReply(vaultReplyFor(found), new Set(found.map((r) => r.key)));
    expect(book.unsettled()).toHaveLength(2);
    book.markSettled(book.unsettled());
    expect(book.unsettled()).toHaveLength(0);
  });

  it('refuses a request built from nothing', () => {
    const empty = buildOutputsRequest([]);
    expect(empty.ok).toBe(false);
  });

  it('deduplicates outputs found by overlapping scans', async () => {
    const found = await foundOutputs();
    const request = buildOutputsRequest([...found, ...found, ...found]);
    expect(request.ok).toBe(true);
    if (request.ok) expect(request.outputs).toBe(2);
  });
});

describe('asking the node about history', () => {
  it('marks pool spends as spent, like unconfirmed payments count as used', async () => {
    const node = fakeNode({ blocks: {}, spentAnswers: { ['a'.repeat(64)]: 1, ['b'.repeat(64)]: 2, ['c'.repeat(64)]: 0 } });
    const answer = await isKeyImageSpent(node, ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
    expect(answer.ok).toBe(true);
    if (answer.ok) expect(answer.value.map((entry) => entry.spent)).toEqual([true, true, false]);
  });

  it('refuses an answer that does not line up with the question', async () => {
    const node: Transport = {
      base: 'https://node.example',
      async send() {
        return { ok: true, status: 200, text: JSON.stringify({ status: 'OK', spent_status: [1] }) };
      },
    };
    const answer = await isKeyImageSpent(node, ['a'.repeat(64), 'b'.repeat(64)]);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.problem).toMatch(/once per key image/);
  });

  it('refuses to send anything that is not a key image', async () => {
    let asked = false;
    const node: Transport = {
      base: 'https://node.example',
      async send() { asked = true; return { ok: false, status: 500, problem: 'never' }; },
    };
    expect((await isKeyImageSpent(node, ['not hex'])).ok).toBe(false);
    expect(asked).toBe(false);
  });

  it('asks nothing when there is nothing to ask', async () => {
    let asked = false;
    const node: Transport = {
      base: 'https://node.example',
      async send() { asked = true; return { ok: false, status: 500, problem: 'never' }; },
    };
    expect((await isKeyImageSpent(node, [])).ok).toBe(true);
    expect(asked).toBe(false);
  });
});

describe('the decoder carries spends', () => {
  it('reads vin key images and skips coinbase inputs', async () => {
    const spend = spendOf(['1'.repeat(64), '2'.repeat(64)], 'a'.repeat(64));
    const coinbase = {
      hash: 'b'.repeat(64),
      json: JSON.stringify({ version: 2, vin: [{ gen: { height: 5 } }], vout: [], extra: [], rct_signatures: { type: 0 } }),
    };
    const node: Transport = {
      base: 'https://node.example',
      async send() {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: 'OK',
            txs: [
              { tx_hash: spend.hash, as_json: spend.json },
              { tx_hash: coinbase.hash, as_json: coinbase.json },
            ],
          }),
        };
      },
    };
    const parsed = await transactions(node, [spend.hash, coinbase.hash]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value[0]!.spends).toEqual(['1'.repeat(64), '2'.repeat(64)]);
      expect(parsed.value[1]!.spends).toEqual([]);
    }
  });
});

describe('the watcher, whole', () => {
  const nodes = { btc: null, xmr: { kind: 'monerod' as const, url: 'https://node.example', label: 'x', mine: false } };
  const watcher = (transport: Transport) =>
    new NodeWatcher(nodes, null, { btc: null, xmr: transport }, 1_700_000_000_000, {
      account,
      scan: { birth: 10, height: 10 },
    });

  it('turns received into a balance once images arrive and a spend lands', async () => {
    const paid = payTo([5_000n, 7_000n]);
    const first = watcher(fakeNode({ blocks: { 10: [paid] }, tip: 10, spentAnswers: {} }));
    await first.refresh(1_700_000_000_000);
    expect(first.snapshot().assets.XMR.balance).toBe(12_000n);
    expect(first.snapshot().assets.XMR.caveat).toContain('cannot tell which of them you have already spent');

    const request = first.keyImageRequest();
    expect(request.ok).toBe(true);

    const outcome = first.importKeyImages(vaultReplyFor(first.moneroOutputs()));
    expect(outcome).toMatchObject({ ok: true, added: 2 });

    /* Nothing spent yet: the settle pass asks the node once, the answer is
     * all zeros, and the number may now honestly subtract nothing. */
    await first.refresh(1_700_000_000_000);
    const view = first.snapshot().assets.XMR;
    expect(view.balance).toBe(12_000n);
    expect(view.caveat).toContain('No spends found so far');
    expect(view.caveat).not.toContain('cannot tell which of them you have already spent');
    expect(first.moneroProgress()?.images).toBe(2);
  });

  it('subtracts a spend the settle query reports', async () => {
    const paid = payTo([5_000n, 7_000n]);
    /* The node knows one image is spent; which one is settled by asking the
     * book after import rather than assuming an order. */
    const node = fakeNode({ blocks: { 10: [paid] }, tip: 10, spentAnswers: {} });
    const w = watcher(node);
    await w.refresh(1_700_000_000_000);
    w.importKeyImages(vaultReplyFor(w.moneroOutputs()));

    /* Answer "spent" for every image: both outputs gone, balance zero. The
     * per-output subtraction is proved by the chain-walk test above; this one
     * proves the settle path affects the balance at all. */
    const allSpent = fakeNode({ blocks: { 10: [paid] }, tip: 10, spentAnswers: new Proxy({}, { get: () => 1 }) as Record<string, number> });
    const w2 = watcher(allSpent);
    await w2.refresh(1_700_000_000_000);
    w2.importKeyImages(vaultReplyFor(w2.moneroOutputs()));
    await w2.refresh(1_700_000_000_000);
    expect(w2.snapshot().assets.XMR.balance).toBe(0n);
    expect(w2.moneroProgress()?.spentOutputs).toBe(2);
    expect(w2.snapshot().assets.XMR.caveat).toContain('2 spent outputs are subtracted');
  });

  it('keeps images unsettled when the node cannot answer, and says so in the balance', async () => {
    const paid = payTo([5_000n]);
    /* No spentAnswers: the settle route 404s. The image stays unsettled, the
     * output counts as unspent, and the next refresh asks again. */
    const node = fakeNode({ blocks: { 10: [paid] }, tip: 10 });
    const w = watcher(node);
    await w.refresh(1_700_000_000_000);
    w.importKeyImages(vaultReplyFor(w.moneroOutputs()));
    await w.refresh(1_700_000_000_000);
    expect(w.snapshot().assets.XMR.balance).toBe(5_000n);
    expect(node.askedSpent.length).toBeGreaterThan(0);

    await w.refresh(1_700_000_000_000);
    /* Still asking: unsettled images are retried, not forgotten. */
    expect(node.askedSpent.length).toBeGreaterThan(1);
  });
});

describe('the activity list', () => {
  async function scannedAndImported(amounts: bigint[]) {
    const paid = payTo(amounts);
    const node = fakeNode({ blocks: { 10: [paid] }, tip: 10 });
    const result = await scan(node, account, { birth: 10, height: 10 }, 10);
    const book = new KeyImageBook();
    book.offerReply(vaultReplyFor(result.received), new Set(result.received.map((r) => r.key)));
    return { paid, received: result.received, book };
  }

  it('lists a receipt, grouped by transaction, at its block time', async () => {
    const { paid, received, book } = await scannedAndImported([5_000n, 7_000n]);
    const rows = moneroHistory(received, [], book, 12);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      asset: 'XMR',
      direction: 'received',
      amount: 12_000n,
      txid: paid.hash,
      blockHeight: 10,
      confirmations: 3,
      fiatCents: null,
    });
    expect(rows[0]!.at).toBe(1_700_000_000 * 1000);
  });

  it('shows a spend as what actually left, netting off the change', async () => {
    /* The wallet2 convention: a transaction that spends your 5000 output and
     * pays 1000 back to you is a payment of 4000, not a sent-5000 row next to
     * a received-1000 row about the same coins. */
    const { received, book } = await scannedAndImported([5_000n]);
    const image = book.imageFor(received[0]!.key)!;
    book.markSpent([image]);

    const changeBack = { ...received[0]!, txid: 'f'.repeat(64), key: 'a1'.repeat(32), amount: 1_000n };
    const spend = { image, txid: 'f'.repeat(64), height: 11, at: 1_700_000_600 };
    const rows = moneroHistory([...received, changeBack], [spend], book, 11);

    const sent = rows.find((row) => row.direction === 'sent')!;
    expect(sent.amount).toBe(4_000n);
    expect(sent.txid).toBe('f'.repeat(64));
    /* And the change receipt is folded into the payment, not listed twice. */
    expect(rows.filter((row) => row.txid === 'f'.repeat(64))).toHaveLength(1);
  });

  it('lists nothing for an output whose amount was never proved', async () => {
    const paid = payTo([9n]);
    const node = fakeNode({ blocks: { 3: [paid] }, tip: 3 });
    const result = await scan(node, account, { birth: 3, height: 3 }, 3);
    const broken = result.received.map((entry) => ({ ...entry, amount: null, unknownBecause: 'x' }));
    expect(moneroHistory(broken, [], new KeyImageBook(), 3)).toEqual([]);
  });

  it('reaches the snapshot: the watcher merges both chains newest first', async () => {
    const paid = payTo([5_000n]);
    const node = fakeNode({ blocks: { 10: [paid] }, tip: 10, spentAnswers: {} });
    const nodes = { btc: null, xmr: { kind: 'monerod' as const, url: 'https://node.example', label: 'x', mine: false } };
    const w = new NodeWatcher(nodes, null, { btc: null, xmr: node }, 1_700_000_000_000, {
      account,
      scan: { birth: 10, height: 10 },
    });
    await w.refresh(1_700_000_000_000);

    const listed = w.snapshot().transactions;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ asset: 'XMR', direction: 'received', amount: 5_000n });
  });
});

describe('the sentence under the number', () => {
  const status = (over: Partial<MoneroStatus> = {}): MoneroStatus => ({
    scan: { birth: 0, height: 100 },
    tip: 100,
    fraction: 1,
    caughtUp: true,
    outputs: 3,
    unvalued: 0,
    images: 0,
    spentOutputs: 0,
    ...over,
  });

  it('keeps the permanent warning while there are no images', () => {
    expect(moneroCaveat(status(), 0)).toContain('cannot tell which of them you have already spent');
  });

  it('says where the images came from once they exist', () => {
    const sentence = moneroCaveat(status({ images: 3 }), 0, { images: 3, uncovered: 0, spentCount: 1, spentUnknown: 0 });
    expect(sentence).toContain('key images your vault computed');
    expect(sentence).not.toContain('cannot tell which of them you have already spent');
  });

  it('admits a balance that reads high when a spent amount was unproved', () => {
    const sentence = moneroCaveat(status({ images: 2 }), 1, { images: 2, uncovered: 0, spentCount: 0, spentUnknown: 1 });
    expect(sentence).toContain('reads high');
  });

  it('counts the outputs still waiting for an image', () => {
    const sentence = moneroCaveat(status({ images: 1 }), 0, { images: 1, uncovered: 2, spentCount: 0, spentUnknown: 0 });
    expect(sentence).toContain('2 outputs have no key image yet');
  });
});
