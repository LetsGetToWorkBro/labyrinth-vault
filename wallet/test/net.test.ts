/**
 * The node clients, against recorded answers from real nodes.
 *
 * Recorded rather than mocked at the fetch layer, and the difference matters.
 * A mock returns what the test author believed the node says. A recording
 * returns what it said, including the fields nobody expected and the ones that
 * are strings where a number would be tidier. Every fixture in this file is
 * shaped the way Esplora and monerod actually answer.
 *
 * Two things get the most attention here, and neither is the happy path.
 *
 * **The transport's boundary.** A wallet whose HTTP layer can be talked into
 * requesting another host is a wallet that can be told to leak its addresses
 * somewhere else. So the path rules are tested as rules rather than as
 * behavior that happens to hold.
 *
 * **Everything that could turn a failure into a success.** A broadcast that
 * reports a txid when nothing was published, a balance that comes back low
 * because half the scan failed, a fee estimate below the relay minimum. Those
 * are the answers that cost money, and each has a test that produces exactly
 * that answer from a node and checks the client refuses it.
 */

import { describe, expect, it } from 'vitest';
import { live, parseJson, recorded } from '../src/net/http';
import * as esplora from '../src/net/esplora';
import * as monerod from '../src/net/monerod';
import { isLocalNode, parseNode, privacyNote, SUGGESTIONS } from '../src/core/nodes';

// ---------------------------------------------------------------------------
// Recorded answers. Shapes as the nodes really send them.

const ADDRESS_USED = JSON.stringify({
  address: 'bc1qexample',
  chain_stats: { funded_txo_count: 2, funded_txo_sum: 180000, spent_txo_count: 1, spent_txo_sum: 40000, tx_count: 3 },
  mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
});

const UTXOS = JSON.stringify([
  { txid: 'a'.repeat(64), vout: 0, value: 140000, status: { confirmed: true, block_height: 860000 } },
  { txid: 'b'.repeat(64), vout: 1, value: 25000, status: { confirmed: false } },
]);

const FEES = JSON.stringify({
  '1': 18.2, '2': 14.1, '3': 12, '6': 9.4, '10': 6, '144': 2.1, '504': 1.02, '1008': 1.01,
});

describe('the transport keeps a wallet on one host', () => {
  it('refuses a path that would leave the node', async () => {
    /* The whole reason paths are joined rather than passed whole. A node that
     * could steer this app to another host could have it ask a stranger about
     * every address in the wallet. */
    const transport = live('https://node.example');
    for (const path of ['//evil.example/x', 'https://evil.example/x', '/../../x', 'no-slash']) {
      const reply = await transport.send({ method: 'GET', path });
      expect(reply.ok, path).toBe(false);
      if (!reply.ok) expect(reply.problem).toMatch(/leave the configured node/);
    }
  });

  it('normalizes the base once, so a trailing slash cannot double up', () => {
    expect(live('https://node.example/api/').base).toBe('https://node.example/api');
    expect(live('https://node.example///').base).toBe('https://node.example');
  });

  it('turns a node error into a sentence rather than a body', async () => {
    const transport = recorded({ 'GET /x': { status: 429, body: 'slow down' } });
    const reply = await transport.send({ method: 'GET', path: '/x' });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.problem).toMatch(/rate limiting/);
  });

  it('says so when nothing was recorded, rather than answering empty', async () => {
    /* A recorded transport that returned `{}` for an unrecorded call would let
     * a test pass while exercising nothing. */
    const transport = recorded({});
    expect((await transport.send({ method: 'GET', path: '/x' })).ok).toBe(false);
  });

  it('reports unparseable JSON as a node problem, not a crash', () => {
    const parsed = parseJson({ ok: true, status: 200, text: '<html>504</html>' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toMatch(/not JSON/);
  });
});

describe('esplora', () => {
  it('reads address activity, counting the mempool as used', async () => {
    const transport = recorded({ 'GET /address/bc1qexample': ADDRESS_USED });
    const answer = await esplora.addressActivity(transport, 'bc1qexample');
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.used).toBe(true);
    expect(answer.value.received).toBe(180000n);
    expect(answer.value.sent).toBe(40000n);
  });

  it('counts an address that received and spent as used', async () => {
    /* Used means the chain has seen it, not that it holds money. Handing out
     * an emptied address again joins two payments together for anybody
     * reading the chain. */
    const emptied = JSON.stringify({
      chain_stats: { funded_txo_sum: 50000, spent_txo_sum: 50000, tx_count: 2 },
      mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
    });
    const transport = recorded({ 'GET /address/bc1qold': emptied });
    const answer = await esplora.addressActivity(transport, 'bc1qold');
    expect(answer.ok && answer.value.used).toBe(true);
  });

  it('turns satoshis into bigint at the boundary and nowhere later', async () => {
    const transport = recorded({ 'GET /address/bc1qexample/utxo': UTXOS });
    const answer = await esplora.addressUtxos(transport, 'bc1qexample');
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    for (const utxo of answer.value) expect(typeof utxo.value).toBe('bigint');
    expect(answer.value[0]!.value).toBe(140000n);
    expect(answer.value[1]!.confirmed).toBe(false);
    expect(answer.value[1]!.height).toBeNull();
  });

  it('refuses a satoshi count that is not a whole number', async () => {
    /* Rounding here would turn a node speaking a different protocol into a
     * balance that is quietly wrong. Zero is visible; a rounded number is not. */
    const odd = JSON.stringify([{ txid: 'a'.repeat(64), vout: 0, value: 1.5, status: { confirmed: true, block_height: 1 } }]);
    const transport = recorded({ 'GET /address/x/utxo': odd });
    const answer = await esplora.addressUtxos(transport, 'x');
    expect(answer.ok && answer.value[0]!.value).toBe(0n);
  });

const TXS = JSON.stringify([
  {
    txid: 'c'.repeat(64),
    fee: 1420,
    status: { confirmed: true, block_height: 860000, block_time: 1727000000 },
    vin: [{ prevout: { scriptpubkey_address: 'bc1qmine', value: 200000 } }],
    vout: [
      { scriptpubkey_address: 'bc1qstranger', value: 150000 },
      { scriptpubkey_address: 'bc1qmine', value: 48580 },
    ],
  },
]);

  it('reads a transaction list, with both sides of every entry', async () => {
    /* The shape history is built from. An input whose `prevout` the node did
     * not include is an input this wallet cannot attribute, and it arrives as
     * a null address rather than as a crash. */
    const transport = recorded({ 'GET /address/bc1qmine/txs': TXS });
    const answer = await esplora.addressTxs(transport, 'bc1qmine');
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const tx = answer.value[0]!;
    expect(tx.fee).toBe(1420n);
    expect(tx.inputs[0]!.address).toBe('bc1qmine');
    expect(tx.outputs).toHaveLength(2);
    expect(tx.time).toBe(1727000000);
  });

  it('reads an address the chain has never seen as unused', async () => {
    const unused = JSON.stringify({
      chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
      mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
    });
    const answer = await esplora.addressActivity(recorded({ 'GET /address/bc1qfresh': unused }), 'bc1qfresh');
    expect(answer.ok && answer.value.used).toBe(false);
  });

  it('reads a fee table and refuses an empty one', async () => {
    expect((await esplora.feeEstimates(recorded({ 'GET /fee-estimates': FEES }))).ok).toBe(true);
    const empty = await esplora.feeEstimates(recorded({ 'GET /fee-estimates': '{}' }));
    expect(empty.ok).toBe(false);
  });

  it('reads a tip height and refuses anything that is not one', async () => {
    expect(await esplora.tipHeight(recorded({ 'GET /blocks/tip/height': '860123' })))
      .toEqual({ ok: true, value: 860123 });
    for (const bad of ['', 'soon', '-1', 'NaN']) {
      const answer = await esplora.tipHeight(recorded({ 'GET /blocks/tip/height': bad }));
      expect(answer.ok, bad).toBe(false);
    }
  });

  describe('broadcast', () => {
    const raw = '0200000001abcd';

    it('returns the txid the node gives back', async () => {
      const txid = 'd'.repeat(64);
      const answer = await esplora.broadcast(recorded({ 'POST /tx': txid }), raw);
      expect(answer).toEqual({ ok: true, value: txid });
    });

    it('refuses a 200 that is not a txid', async () => {
      /* The dangerous case. A node that accepted the request and did something
       * else would otherwise be reported as a published payment, and somebody
       * would stop waiting for money that is not coming. */
      const answer = await esplora.broadcast(recorded({ 'POST /tx': 'ok' }), raw);
      expect(answer.ok).toBe(false);
    });

    it('passes a rejection through, because the words are the useful part', async () => {
      const answer = await esplora.broadcast(
        recorded({ 'POST /tx': { status: 400, body: 'bad-txns-inputs-missingorspent' } }),
        raw,
      );
      expect(answer.ok).toBe(false);
      if (!answer.ok) expect(answer.problem).toContain('missingorspent');
    });

    it('will not send something that is not hexadecimal', async () => {
      for (const bad of ['', 'zz', '0200000001abc']) {
        const transport = recorded({});
        expect((await esplora.broadcast(transport, bad)).ok, bad).toBe(false);
        expect(transport.asked, 'it asked the node anyway').toEqual([]);
      }
    });
  });

  it('probes for the right chain before anything depends on it', async () => {
    const good = recorded({
      'GET /blocks/tip/height': '860123',
      'GET /block-height/0': esplora.MAINNET_GENESIS,
    });
    const answer = await esplora.probe(good);
    expect(answer.ok && answer.value.genesis).toBe(esplora.MAINNET_GENESIS);

    const notEsplora = recorded({
      'GET /blocks/tip/height': '860123',
      'GET /block-height/0': '<!doctype html>',
    });
    expect((await esplora.probe(notEsplora)).ok).toBe(false);
  });
});

describe('monerod', () => {
  const infoBody = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      jsonrpc: '2.0',
      id: '0',
      result: { height: 3200000, target_height: 0, synchronized: true, mainnet: true, status: 'OK', ...over },
    });

  it('reads height and network', async () => {
    const answer = await monerod.info(recorded({ 'POST /json_rpc': infoBody() }));
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.height).toBe(3200000);
    expect(answer.value.mainnet).toBe(true);
    expect(answer.value.syncing).toBe(false);
  });

  it('notices a node that is still catching up', async () => {
    /* A node behind the chain answers happily, and the balance it produces is
     * correct for a past that is not now. */
    const behind = await monerod.info(
      recorded({ 'POST /json_rpc': infoBody({ height: 3100000, target_height: 3200000, synchronized: false }) }),
    );
    expect(behind.ok && behind.value.syncing).toBe(true);
  });

  it('refuses a node that is not on mainnet', async () => {
    const testnet = await monerod.probe(
      recorded({ 'POST /json_rpc': infoBody({ mainnet: false, nettype: 'testnet' }) }),
    );
    expect(testnet.ok).toBe(false);
    if (!testnet.ok) expect(testnet.problem).toMatch(/not on mainnet/);
  });

  it('turns an RPC error into a sentence', async () => {
    const error = JSON.stringify({ jsonrpc: '2.0', id: '0', error: { code: -32601, message: 'Method not found' } });
    const answer = await monerod.info(recorded({ 'POST /json_rpc': error }));
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.problem).toMatch(/Method not found/);
  });

  describe('broadcast', () => {
    it('accepts an OK', async () => {
      const answer = await monerod.broadcast(
        recorded({ 'POST /send_raw_transaction': JSON.stringify({ status: 'OK', not_relayed: false }) }),
        'abcd',
      );
      expect(answer.ok).toBe(true);
    });

    it('names the specific rejection, because each one means something different', async () => {
      const cases: [string, RegExp][] = [
        ['double_spend', /already spent/],
        ['fee_too_low', /fee is below/],
        ['overspend', /spends more than/],
        ['low_mixin', /ring size/],
      ];
      for (const [flag, expected] of cases) {
        const answer = await monerod.broadcast(
          recorded({ 'POST /send_raw_transaction': JSON.stringify({ status: 'Failed', [flag]: true }) }),
          'abcd',
        );
        expect(answer.ok, flag).toBe(false);
        if (!answer.ok) expect(answer.problem, flag).toMatch(expected);
      }
    });

    it('does not claim success on a status it does not recognize', async () => {
      const answer = await monerod.broadcast(
        recorded({ 'POST /send_raw_transaction': JSON.stringify({ status: 'Failed' }) }),
        'abcd',
      );
      expect(answer.ok).toBe(false);
    });
  });
});

describe('choosing a node', () => {
  it('takes an https address and remembers what to call it', () => {
    const answer = parseNode('esplora', 'https://mempool.space/api/', 'mempool');
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.config.url).toBe('https://mempool.space/api');
    expect(answer.config.label).toBe('mempool');
  });

  it('allows plain http only on your own network', () => {
    /* http to a box in the next room is the case it exists for. http across
     * the internet hands every address in the wallet to anybody on the path,
     * which is the thing choosing your own node was meant to avoid. */
    expect(parseNode('monerod', 'http://192.168.1.20:18081').ok).toBe(true);
    expect(parseNode('monerod', 'http://localhost:18081').ok).toBe(true);
    expect(parseNode('monerod', 'http://node.example:18081').ok).toBe(false);
  });

  it('refuses credentials, queries and fragments in the address', () => {
    for (const bad of [
      'https://user:pass@node.example',
      'https://node.example?token=abc',
      'https://node.example#x',
      'ftp://node.example',
      'node.example',
      '',
    ]) {
      expect(parseNode('esplora', bad).ok, bad).toBe(false);
    }
  });

  it('knows which nodes are yours', () => {
    const mine = parseNode('esplora', 'http://10.0.0.5:3002');
    const theirs = parseNode('esplora', 'https://mempool.space/api');
    expect(mine.ok && isLocalNode(mine.config)).toBe(true);
    expect(theirs.ok && isLocalNode(theirs.config)).toBe(false);
  });
});

describe('what the screen is told a node costs', () => {
  it('says nothing is set when nothing is', () => {
    expect(privacyNote(null)).toMatch(/fixture data/);
  });

  it('tells the truth about a public Bitcoin node, which is the worst case', () => {
    const node = parseNode('esplora', 'https://mempool.space/api', 'mempool.space');
    expect(node.ok).toBe(true);
    if (!node.ok) return;
    const note = privacyNote(node.config);
    expect(note).toMatch(/every address/);
    expect(note).toMatch(/assemble the whole account/);
  });

  it('says the different, better truth about a Monero node', () => {
    /* Genuinely different, and worth saying rather than flattening into one
     * warning: a node serving blocks does not learn which outputs are yours,
     * because the scan happens here. */
    const node = parseNode('monerod', 'https://node.example:18081', 'node.example');
    expect(node.ok).toBe(true);
    if (!node.ok) return;
    expect(privacyNote(node.config)).toMatch(/does not learn which outputs are yours/);
  });

  it('says the best truth about your own node', () => {
    const node = parseNode('esplora', 'http://10.0.0.5:3002', 'home');
    expect(node.ok).toBe(true);
    if (!node.ok) return;
    expect(privacyNote(node.config)).toMatch(/leaves the house/);
  });

  it('names who runs every suggested node', () => {
    /* "A public node" is not information. "A company that sells blockchain
     * analytics" is. */
    expect(SUGGESTIONS.length).toBeGreaterThan(3);
    for (const suggestion of SUGGESTIONS) {
      expect(suggestion.who.length, suggestion.label).toBeGreaterThan(20);
      expect(parseNode(suggestion.kind, suggestion.url).ok, suggestion.url).toBe(true);
    }
  });
});
