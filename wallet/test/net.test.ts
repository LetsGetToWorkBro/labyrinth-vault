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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { live, parseJson, recorded } from '../src/net/http';
import { obliviousFetch } from '../src/net/oblivious';
import { routedTransport } from '../src/net/nodeproxy';
import { proxyTransport } from '../src/net/swapproxy';
import * as esplora from '../src/net/esplora';
import * as monerod from '../src/net/monerod';
import { hostOf, isLocalNode, parseNode, privacyNote, SUGGESTIONS } from '../src/core/nodes';

/** Every module in the layer, comments removed, for the guards at the end. */
function netSources(dir = 'src/net'): { name: string; code: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return netSources(path);
    if (!entry.name.endsWith('.ts')) return [];
    const code = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    return [{ name: path, code }];
  });
}

/**
 * The text of every call to `fetch` or to an injected `doFetch`, arguments
 * included.
 *
 * Parentheses are balanced rather than the line being read, because every one
 * of these calls spans a dozen lines and a line-based check would report on
 * the first line of each and see none of the arguments.
 */
function fetchCalls(code: string): string[] {
  const sites: string[] = [];
  const opener = /\b(?:doFetch|fetch)\s*\(/g;
  for (let match = opener.exec(code); match !== null; match = opener.exec(code)) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < code.length; end += 1) {
      if (code[end] === '(') depth += 1;
      else if (code[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    sites.push(code.slice(match.index, end + 1));
  }
  return sites;
}

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

  describe('the output distribution, which decides every decoy', () => {
    /*
     * W-M20's tail. `base` is added to element 0 and the loop after it is a
     * monotonic repair, not the base carry-forward its comment used to claim.
     * The two are the same only when `base` is zero, which is the only case
     * that has ever run, because the sole caller asks from height zero. The
     * obvious reason to pass anything else is refreshing the tail of a cached
     * distribution, and whoever writes that is one wrong assumption away from
     * an offset applied to every element or to none. This sequence maps an
     * output's age to its global index, so a shifted one picks decoys from
     * the wrong stretch of the chain and hands the network a ring whose real
     * member is the odd one out: a privacy loss with no error message.
     *
     * So a partial fetch is refused until somebody settles it against
     * monerod's own code, the way `docs/verification.md` requires. This pins
     * the refusal so that removing it is a decision rather than a default.
     */
    const served = (body: unknown) =>
      recorded({ 'POST /json_rpc': JSON.stringify({ jsonrpc: '2.0', id: '0', result: body }) });

    it('reads a whole-chain answer', async () => {
      const answer = await monerod.outputDistribution(
        served({ distributions: [{ distribution: [10, 20, 30], start_height: 0, base: 0 }] }),
        0,
        2,
      );
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      expect(answer.value.cumulative).toEqual([10, 20, 30]);
      expect(answer.value.startHeight).toBe(0);
    });

    it('forces the sequence to climb, whatever the node sent', async () => {
      /* The repair under its real name. A cumulative count that goes down is
       * an answer this wallet cannot map an age onto. */
      const answer = await monerod.outputDistribution(
        served({ distributions: [{ distribution: [10, 4, 30, 12], start_height: 0, base: 0 }] }),
        0,
        3,
      );
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      expect(answer.value.cumulative).toEqual([10, 10, 30, 30]);
    });

    it('refuses to fetch part of it, without asking the node', async () => {
      let asked = false;
      const watching = {
        base: 'https://node.example',
        async send() {
          asked = true;
          return { ok: true as const, status: 200, text: '{}' };
        },
      };
      const answer = await monerod.outputDistribution(watching, 1_000_000, 3_200_000);
      expect(answer.ok).toBe(false);
      expect(asked, 'it went to the node with a question it cannot read the answer to').toBe(false);
      if (answer.ok) return;
      expect(answer.problem).toMatch(/start of the chain/);
      expect(answer.problem, 'a refusal that is a code rather than a sentence').toMatch(/decoys/);
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

  it('does not mistake a public name that starts like a private address', () => {
    /* This check was a prefix match, `/^10\./` against the hostname, and
     * `10.evil.com` is an ordinary public domain that starts with `10.`. It
     * passed, and so did `192.168.evil.com` and `172.16.attacker.net`.
     *
     * The consequence is specific rather than theoretical. Plain http is
     * permitted *only* to a local node, so a name that merely looks local buys
     * an unencrypted connection carrying every address in the wallet, off the
     * one screen whose whole purpose is deciding who gets to watch you. A
     * private address is a number in a range, so the check parses the number. */
    for (const wolf of [
      'http://10.evil.com:18081',
      'http://192.168.evil.com:18081',
      'http://172.16.attacker.net:18081',
      'http://127.0.0.1.evil.com:18081',
      'http://10.0.0.5.attacker.net:18081',
      'http://localhost.evil.com:18081',
    ]) {
      expect(parseNode('monerod', wolf).ok, `${wolf} was accepted as local`).toBe(false);
    }
  });

  it('still accepts every address that really is private', () => {
    /* The other half of the same fix. A check that refuses everything is not a
     * check, it is an outage, and the person it strands is the one running
     * their own node, which is the behavior this screen exists to argue for. */
    for (const home of [
      'http://10.0.0.5:18081',
      'http://10.255.255.254:18081',
      'http://192.168.1.1:18081',
      'http://172.16.0.1:18081',
      'http://172.31.255.254:18081',
      'http://127.0.0.1:18081',
      'http://169.254.10.20:18081',
      'http://monero.local:18081',
      'http://localhost:18081',
    ]) {
      expect(parseNode('monerod', home).ok, `${home} was refused`).toBe(true);
    }
    /* Adjacent to the private ranges and not in them. 172.15 and 172.32 sit
     * either side of RFC 1918's 172.16 through 172.31, and an off-by-one in
     * either direction is a public address treated as a private one. */
    for (const away of [
      'http://172.15.0.1:18081',
      'http://172.32.0.1:18081',
      'http://11.0.0.1:18081',
      'http://192.169.1.1:18081',
      'http://999.999.999.999:18081',
    ]) {
      expect(parseNode('monerod', away).ok, `${away} was accepted as local`).toBe(false);
    }
  });

  it('never disagrees with WHATWG about which host it is talking to', () => {
    /* The check above is worth exactly as much as the parser under it, and
     * that parser used to be `new URL()`, which is a different program on a
     * phone than it is here.
     *
     * React Native ships its own URL in `Libraries/Blob/URL.js`, built from
     * regular expressions rather than the WHATWG algorithm. Its hostname
     * pattern stops at the class `[^:/?#]`, which does not contain a
     * backslash, and WHATWG treats a backslash as a path separator for http.
     * Measured against that file rather than assumed:
     *
     *     http://evil.com\@10.0.0.5/
     *       WHATWG (here, and iOS networking)  ->  evil.com
     *       React Native                       ->  10.0.0.5
     *
     * On a device that parsed as a private address, passed as local, was
     * stored, and would then have been handed to a networking stack that
     * resolves `evil.com` and opens an unencrypted connection to it carrying
     * every address in the wallet. No test here could have seen it, because
     * this runs where the string parses the safe way.
     *
     * So the invariant is not "matches a list of bad inputs", which the next
     * trick gets past. It is that for any input, `hostOf` either refuses or
     * names the same host the platform will actually connect to. Where the
     * two could differ, the address does not get in. */
    const corpus = [
      'https://mempool.space/api',
      'http://10.0.0.5:18081',
      'http://[::1]:18081',
      'http://evil.com\\@10.0.0.5/',
      'http://evil.com\\@192.168.1.1/',
      'http://10.0.0.5@evil.com/',
      'http://10.0.0.5\t.evil.com/',
      'http://10.0.0.5\n:18081',
      'http://10.0.0.5 .evil.com/',
      'http://0x0a000005/',
      'https://node..example.com',
      'https://.example.com',
      'https://EXAMPLE.com',
      'https://example.com.',
      'http://10.0.0.5:18081/#@192.168.1.1/',
      'http://10.0.0.5:18081/?@192.168.1.1/',
    ];

    for (const address of corpus) {
      const ours = hostOf(address);
      if (ours === null) continue; // refused, which is always a safe answer

      let theirs: string | null = null;
      try {
        theirs = new URL(address).hostname.toLowerCase();
      } catch {
        theirs = null;
      }
      expect(
        ours,
        `${JSON.stringify(address)} was accepted as ${JSON.stringify(ours)} ` +
          `but the platform would connect to ${JSON.stringify(theirs)}`,
      ).toBe(theirs);
    }
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

describe('what a node request carries, and what it deliberately does not', () => {
  /*
   * `credentials: 'omit'` is set through a spread rather than written into
   * the fetch init, because the Worker bundles this module and typechecks it
   * against `@cloudflare/workers-types`, whose `RequestInit` has no such
   * field. That indirection is exactly the kind a later refactor drops
   * without noticing, so the flag is checked on the init that reaches fetch
   * rather than in the source. The pair below is the point: a fixture that
   * only asserted the flag would pass against a transport that had stopped
   * sending anything at all.
   */
  const spying = async (): Promise<RequestInit> => {
    const original = globalThis.fetch;
    let seen: RequestInit = {};
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init ?? {};
      return Promise.resolve(new Response('7', { status: 200 }));
    }) as typeof fetch;
    try {
      const reply = await live('https://node.example').send({ method: 'GET', path: '/blocks/tip/height' });
      expect(reply.ok, 'the request did not go through, so the init proves nothing').toBe(true);
    } finally {
      globalThis.fetch = original;
    }
    return seen;
  };

  it('omits credentials, so a redirect cannot carry any', async () => {
    const init = await spying();
    expect((init as Record<string, unknown>)['credentials']).toBe('omit');
  });

  it('refuses to follow a redirect at all, and keeps its deadline', async () => {
    const init = await spying();
    expect(init.redirect).toBe('error');
    expect(init.signal, 'the deadline went with the refactor').toBeTruthy();
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

// ---------------------------------------------------------------------------
// The rule at the top of http.ts, held for every transport rather than for one.

describe('everything times out', () => {
  /* `http.ts` states the rule for the layer: "a wallet that hangs on a dead
   * node is a wallet whose owner force quits it during a broadcast." For a
   * long time `live()` was the only transport and the rule was true by
   * accident. Three more were added, each calling fetch itself, and none of
   * them passed a signal, so the sentence at the top of the file described one
   * function out of four. */

  /** A server that accepts the connection and then never says anything. */
  const hangs = (): typeof fetch =>
    ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const stopped = new Error('aborted');
          stopped.name = 'AbortError';
          reject(stopped);
        });
      })) as typeof fetch;

  it('gives the swap proxy a deadline, in words a person can act on', async () => {
    const proxy = proxyTransport('https://proxy.example', hangs(), 5);
    await expect(proxy.quote({ provider: 'exolix', from: 'btc', to: 'xmr', amount: 1 })).rejects.toThrow(
      /did not answer in time/,
    );
  });

  it('gives the node relay a deadline, without throwing across its boundary', async () => {
    const node = parseNode('esplora', 'https://mempool.space/api');
    expect(node.ok).toBe(true);
    if (!node.ok) return;
    const relayed = routedTransport(node.config, live('https://mempool.space/api'), 'https://proxy.example', hangs(), 5);
    const reply = await relayed.send({ method: 'GET', path: '/blocks/tip/height' });
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.problem).toMatch(/did not answer in time/);
  });

  it('gives the oblivious client a deadline on the leg that fetches the keys', async () => {
    const relay = { operator: 'somebody else', url: 'https://relay.example/x', keysUrl: 'https://relay.example/keys' };
    const through = obliviousFetch(relay, { doFetch: hangs(), timeoutMs: 5 });
    await expect(through('https://gateway.example/v1/health')).rejects.toThrow();
  });

  it('lets the transport above it abandon the relay leg', async () => {
    /* The layered case, and the reason `deadline` takes an upstream signal at
     * all. `obliviousFetch` is handed to `proxyTransport` as its fetch, so
     * without this the relay would keep a request running for its own full
     * timeout after the swap screen had already told the person nobody
     * answered. */
    const seen: (AbortSignal | undefined)[] = [];
    const watchful = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.signal ?? undefined);
      return new Promise<Response>((_resolve, reject) => {
        const stopped = new Error('aborted');
        stopped.name = 'AbortError';
        if (init?.signal?.aborted) reject(stopped);
        else init?.signal?.addEventListener('abort', () => reject(stopped));
      });
    }) as typeof fetch;

    const relay = { operator: 'somebody else', url: 'https://relay.example/x', keysUrl: 'https://relay.example/keys' };
    const through = obliviousFetch(relay, { doFetch: watchful, timeoutMs: 60_000 });
    const giving = new AbortController();
    giving.abort();
    /* The rejection is not what is being checked: an already-aborted caller
     * could plausibly be refused before a fetch happens at all. What matters
     * is that the signal handed down was aborted, because that is the thing
     * that stops the leg. */
    await through('https://gateway.example/v1/health', { signal: giving.signal }).catch(() => undefined);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.aborted, 'the relay leg was started with a live signal').toBe(true);
  });

  it('passes a signal at every fetch call site under src/net', () => {
    /* The guard, because the four tests above cover the four transports that
     * exist today and the fifth is the one that will be written without them.
     * Comments are stripped first: this rule is argued at length in prose two
     * files over, and a guard that fires on the paragraph explaining it
     * teaches people to delete the paragraph. */
    const files = netSources();
    expect(files.length, 'the walk found no sources').toBeGreaterThanOrEqual(6);
    const sites = files.flatMap(({ name, code }) => fetchCalls(code).map((text) => ({ name, text })));
    /* A `for` loop over an empty list asserts nothing and reports green, which
     * is how a guard ends up watching a call site its own matcher stopped
     * finding. Four transports call the network today. */
    expect(sites.length, 'the matcher found no fetch call sites at all').toBeGreaterThanOrEqual(4);
    for (const { name, text } of sites) {
      expect(text, `${name} calls fetch with no deadline: ${text.slice(0, 60)}`).toMatch(/\bsignal\s*:/);
    }
  });
});
