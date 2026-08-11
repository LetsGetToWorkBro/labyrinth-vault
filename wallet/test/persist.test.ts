/**
 * What survives a relaunch, and the rule that nothing survives unchecked.
 *
 * Two properties are being held here and the second is the interesting one.
 *
 * **A round trip works.** Set a node, close the app, open it, the node is
 * still set. That is the feature and it takes four tests.
 *
 * **Nothing read back is trusted.** A stored node address goes through
 * `parseNode` again, exactly as if somebody had just typed it, and a stored
 * height is bounds-checked. The threat model is not really an attacker editing
 * the file, though on a jailbroken phone it could be. It is that a file
 * written by an older build of this app *is* untrusted input, and the code
 * that handles both cases correctly is the code that treats them the same.
 *
 * The tests below therefore spend most of their length on files that are wrong
 * in different ways, and every one of them expects the same answer: nothing is
 * loaded. A wallet that boots with no node says so on its home screen. A
 * wallet that boots with a half-repaired one is talking to somewhere nobody
 * chose.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { EMPTY, SCHEMA, load, memoryStore, save, type Persisted } from '../src/state/persist';
import { parseNode } from '../src/core/nodes';

const node = (url: string, kind: 'esplora' | 'monerod' = 'esplora') => {
  const parsed = parseNode(kind, url, 'a label');
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.config;
};

const stored = (body: unknown) => memoryStore(JSON.stringify(body));

describe('the round trip', () => {
  it('remembers a node across a relaunch', async () => {
    const store = memoryStore();
    const state: Persisted = {
      nodes: { btc: node('https://mempool.space/api'), xmr: null },
      moneroScan: null,
    };
    await save(store, state);

    expect(await load(memoryStore(store.text))).toEqual(state);
  });

  it('remembers both nodes and where the scan got to', async () => {
    const store = memoryStore();
    const state: Persisted = {
      nodes: {
        btc: node('https://blockstream.info/api'),
        xmr: node('https://node.monerodevs.org:18089', 'monerod'),
      },
      moneroScan: { birth: 3_200_000, height: 3_204_881 },
    };
    await save(store, state);
    expect(await load(memoryStore(store.text))).toEqual(state);
  });

  it('starts empty when there is no file', async () => {
    expect(await load(memoryStore())).toEqual(EMPTY);
  });

  it('writes a file a person can read', async () => {
    /* Not a preference about formatting. The claim this app makes is that it
     * stores almost nothing, and the way somebody checks that claim is by
     * opening the file. */
    const store = memoryStore();
    await save(store, { nodes: { btc: node('https://mempool.space/api'), xmr: null }, moneroScan: null });
    expect(store.text).toMatch(/"schema": 1/);
    expect(store.text).toMatch(/mempool\.space/);
    expect(store.text?.split('\n').length).toBeGreaterThan(5);
  });

  it('stores no keys, and the file proves it', async () => {
    const store = memoryStore();
    await save(store, {
      nodes: { btc: node('https://mempool.space/api'), xmr: node('http://192.168.1.20:18081', 'monerod') },
      moneroScan: { birth: 1, height: 2 },
    });
    for (const word of ['zpub', 'xprv', 'viewSecret', 'seed', 'mnemonic', 'key']) {
      expect(store.text?.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});

describe('nothing read back is trusted', () => {
  it('drops a file with an unknown schema rather than guessing at it', async () => {
    const answer = await load(
      stored({ schema: 99, nodes: { btc: node('https://mempool.space/api') } }),
    );
    expect(answer).toEqual(EMPTY);
  });

  it('drops a file that is not JSON', async () => {
    expect(await load(memoryStore('{ not json'))).toEqual(EMPTY);
  });

  it('drops a file that is JSON but not an object', async () => {
    expect(await load(memoryStore('[1,2,3]'))).toEqual(EMPTY);
    expect(await load(memoryStore('"a string"'))).toEqual(EMPTY);
    expect(await load(memoryStore('null'))).toEqual(EMPTY);
  });

  it('survives a read that throws', async () => {
    const broken = {
      async read(): Promise<string | null> { throw new Error('the disk is on fire'); },
      async write() { /* not reached */ },
      async clear() { /* not reached */ },
    };
    expect(await load(broken)).toEqual(EMPTY);
  });

  it('refuses a stored address that would be refused if typed today', async () => {
    /* Plain http to a host that is not on your own network. The rule exists
     * because it hands every address in the wallet to whoever is on the path,
     * and where the address came from does not change that. */
    const answer = await load(
      stored({
        schema: SCHEMA,
        nodes: { btc: { kind: 'esplora', url: 'http://evil.example/api', label: 'x', mine: false } },
      }),
    );
    expect(answer.nodes.btc).toBeNull();
  });

  it('refuses a stored address with credentials in it', async () => {
    const answer = await load(
      stored({
        schema: SCHEMA,
        nodes: { btc: { kind: 'esplora', url: 'https://user:pass@node.example', label: 'x', mine: false } },
      }),
    );
    expect(answer.nodes.btc).toBeNull();
  });

  it('refuses a stored entry whose kind does not match its slot', async () => {
    /* A monerod URL in the Bitcoin slot would be asked Esplora questions and
     * would answer nothing useful. Worse, it would look configured. */
    const answer = await load(
      stored({
        schema: SCHEMA,
        nodes: { btc: { kind: 'monerod', url: 'https://node.example', label: 'x', mine: false } },
      }),
    );
    expect(answer.nodes.btc).toBeNull();
  });

  it('keeps the good half of a file whose other half is bad', async () => {
    const answer = await load(
      stored({
        schema: SCHEMA,
        nodes: {
          btc: node('https://mempool.space/api'),
          xmr: { kind: 'monerod', url: 'http://not-local.example', label: 'x', mine: false },
        },
      }),
    );
    expect(answer.nodes.btc?.url).toBe('https://mempool.space/api');
    expect(answer.nodes.xmr).toBeNull();
  });

  it('refuses nodes that are not objects at all', async () => {
    const answer = await load(
      stored({ schema: SCHEMA, nodes: { btc: 'https://mempool.space/api', xmr: 42 } }),
    );
    expect(answer.nodes).toEqual({ btc: null, xmr: null });
  });

  it('carries the mine flag through, because it changes what the screen says', async () => {
    const mine = parseNode('monerod', 'http://192.168.1.20:18081', 'home', true);
    if (!mine.ok) throw new Error(mine.problem);
    const store = memoryStore();
    await save(store, { nodes: { btc: null, xmr: mine.config }, moneroScan: null });
    expect((await load(memoryStore(store.text))).nodes.xmr?.mine).toBe(true);
  });
});

describe('the stored scan height', () => {
  const withScan = (moneroScan: unknown) =>
    load(stored({ schema: SCHEMA, nodes: {}, moneroScan }));

  it('keeps a sensible one', async () => {
    expect((await withScan({ birth: 100, height: 3_000_000 })).moneroScan).toEqual({
      birth: 100,
      height: 3_000_000,
    });
  });

  it('drops a height above anything the chain could be', async () => {
    /* A height in the future resumes a scan past the tip and finds nothing,
     * forever. On screen that is a wallet with no money in it. */
    expect((await withScan({ birth: 0, height: 999_999_999 })).moneroScan).toBeNull();
  });

  it('drops a height below its own birth', async () => {
    expect((await withScan({ birth: 500, height: 100 })).moneroScan).toBeNull();
  });

  it('drops values that are not whole numbers', async () => {
    expect((await withScan({ birth: 0, height: 1.5 })).moneroScan).toBeNull();
    expect((await withScan({ birth: 'soon', height: 5 })).moneroScan).toBeNull();
    expect((await withScan({ birth: -1, height: 5 })).moneroScan).toBeNull();
  });

  it('drops a null height rather than reading it as genesis', async () => {
    /* `JSON.stringify` writes a NaN as `null` and `Number(null)` is zero, so
     * coercing here would turn a height that was never really stored into a
     * scan that walks the entire chain from block zero. */
    expect((await withScan({ birth: 0, height: null })).moneroScan).toBeNull();
    expect((await withScan({ birth: null, height: 5 })).moneroScan).toBeNull();
  });

  it('drops a scan that is not an object', async () => {
    expect((await withScan(3_000_000)).moneroScan).toBeNull();
    expect((await withScan(null)).moneroScan).toBeNull();
  });
});

describe('failing to write', () => {
  it('forgets rather than crashing', async () => {
    /* A wallet that cannot save its settings is a wallet that forgets them,
     * which is an inconvenience. One that throws when the disk is full is not. */
    const full = {
      async read(): Promise<string | null> { return null; },
      async write(): Promise<void> { throw new Error('no space left on device'); },
      async clear() { /* not reached */ },
    };
    await expect(save(full, EMPTY)).resolves.toBeUndefined();
  });
});

describe('the boundary between logic and filesystem', () => {
  it('keeps the filesystem out of the module the tests drive', () => {
    /* `persist.ts` is the real loading and saving code and it runs here under
     * Node, where there is no phone. That is only possible because the import
     * of expo-file-system lives in a separate file, and this is what keeps it
     * there. */
    const source = readFileSync('src/state/persist.ts', 'utf8');
    const code = source.slice(source.indexOf('import '));
    expect(code).not.toMatch(/expo-file-system/);
  });

  it('uses the documents directory rather than the cache', () => {
    /* iOS empties the cache directory under storage pressure without warning.
     * A wallet that silently forgot its node would send its owner back to the
     * fixture data with no explanation. */
    const source = readFileSync('src/state/fileStore.ts', 'utf8');
    expect(source).toMatch(/Paths\.document/);
    expect(source).not.toMatch(/Paths\.cache/);
  });

  it('does not reach for AsyncStorage, which would cost a privacy claim', () => {
    /* AsyncStorage on iOS is NSUserDefaults, one of Apple's required-reason
     * APIs. Both apps currently declare an empty NSPrivacyAccessedAPITypes and
     * that declaration is true. */
    const source = readFileSync('src/state/fileStore.ts', 'utf8');
    expect(source).not.toMatch(/async-storage/i);
  });
});

describe('the store wiring', () => {
  const store = readFileSync('src/state/store.tsx', 'utf8');

  it('does not write before it has read', () => {
    /* The quiet cold-start bug: the saving effect fires on the first render,
     * when the nodes are still empty because nothing has loaded, and writes an
     * empty file over a real one. */
    expect(store).toMatch(/if \(!restored\) return;/);
  });

  it('still picks no node for anybody', () => {
    expect(store).toMatch(/NO_NODES: WatcherNodes = \{ btc: null, xmr: null \}/);
  });

  it('does not rebuild the watcher every time the scan advances', () => {
    /* It would restart the scan and throw away every output found, on every
     * refresh, forever. The stored progress is handed over through a ref for
     * exactly this reason. */
    expect(store).toMatch(/scanStart = useRef/);
    expect(store).toMatch(/\[nodes, accountKey, moneroWatch\]/);
  });
});
