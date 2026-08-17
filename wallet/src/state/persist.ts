/**
 * The little that survives a relaunch, and why nothing here is trusted.
 *
 * ## What is stored
 *
 * Which nodes to talk to, and where a Monero scan got to. That is the whole
 * list, and it is short on purpose.
 *
 * There is no wallet in it. No key, no seed, no view key, no extended public
 * key. Those arrive from the vault through a camera and live in memory for the
 * session, and adding them here would mean this file had become the most
 * interesting thing on the phone. A node address is not that: it is a URL and
 * a label, and the worst it can do is be wrong.
 *
 * ## Why a file rather than a key-value store
 *
 * `AsyncStorage` on iOS is `NSUserDefaults`, which is one of Apple's
 * required-reason APIs. Using it would mean the app's privacy manifest could
 * no longer declare an empty `NSPrivacyAccessedAPITypes`, and that declaration
 * is currently true and worth keeping true. A file in the app's own documents
 * directory is not a required-reason API and buys exactly the same thing.
 *
 * It is also easier to reason about. One file, JSON, versioned, and a person
 * auditing what this app keeps can read it.
 *
 * ## Nothing read back is trusted
 *
 * This is the part worth reading twice. Everything loaded from disk goes
 * through the same validation as everything typed by a person: a stored node
 * address is re-parsed by `parseNode`, a stored height is bounds-checked, an
 * unknown schema version is discarded rather than migrated by guesswork.
 *
 * Not because the threat model has somebody editing the file. It might, on a
 * jailbroken phone, and pointing a wallet at an attacker's node is a real
 * enough attack to be worth the eight lines. Mostly it is because a file
 * written by an older build of this app *is* untrusted input, in the same way
 * and for the same reasons, and the code that handles both cases correctly is
 * the code that treats them the same.
 *
 * A file that fails validation is dropped, not repaired. A wallet that boots
 * with no node is a wallet that says so on its home screen; a wallet that
 * boots with a half-repaired one is a wallet talking to somewhere nobody
 * chose.
 */

import { parseNode, type NodeConfig } from '../core/nodes';
import { parsePendingSwap, type PendingSwap } from '../core/swaptrack';

/**
 * Bumped when the shape changes in a way an older reader would misread.
 *
 * Two, because `moneroScan` became `moneroScans`: one scan position became one
 * per account when the wallet learned to watch more than one. A version 1 file
 * is dropped rather than migrated, which is this file's standing policy and
 * costs nothing real here: a scan position is a cache of work, and the work is
 * walking blocks the node still has. The wallet re-derives it by scanning, and
 * the alternative, guessing which account a lone stored position belonged to,
 * would resume the wrong account from the wrong height and silently miss every
 * payment before it.
 */
export const SCHEMA = 2;

/** Where one account's Monero scan got to. */
export interface ScanPosition {
  height: number;
  birth: number;
}

export interface Persisted {
  nodes: { btc: NodeConfig | null; xmr: NodeConfig | null };
  /**
   * Where each account's Monero scan got to, keyed by account id.
   *
   * Keyed rather than a single position, because two accounts scan two
   * different sets of blocks for two different view keys and a shared position
   * would hand one account's progress to the other. That is not a slow scan,
   * it is a scan that starts too late and reports a balance that is missing
   * money.
   */
  moneroScans: Record<string, ScanPosition>;
  /** The one swap in flight, so a relaunch can still ask the provider about
   *  it. An order id and two amounts: no address, no key, nothing that helps
   *  anyone who reads this file. See core/swaptrack.ts for the argument. */
  pendingSwap: PendingSwap | null;
}

export const EMPTY: Persisted = {
  nodes: { btc: null, xmr: null },
  moneroScans: {},
  pendingSwap: null,
};

/**
 * Somewhere to put a small amount of text.
 *
 * An interface rather than a direct call to the filesystem, for the same
 * reason every other boundary in this package is one: the tests are the
 * storage, and the module under test is the real one.
 */
export interface Store {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
  clear(): Promise<void>;
}

/** A store backed by nothing, for tests and for a first run. */
export function memoryStore(initial: string | null = null): Store & { text: string | null } {
  const state = {
    text: initial,
    async read() {
      return state.text;
    },
    async write(text: string) {
      state.text = text;
    },
    async clear() {
      state.text = null;
    },
  };
  return state;
}

/**
 * Read what was stored, keeping only what still validates.
 *
 * Returns `EMPTY` for anything it does not like, and it does not like a great
 * deal: a missing file, unreadable JSON, a schema it does not know, a node
 * address that no longer parses. Each of those is the same answer because each
 * of them means the same thing, which is that there is nothing here this app
 * should act on.
 */
export async function load(store: Store): Promise<Persisted> {
  let text: string | null;
  try {
    text = await store.read();
  } catch {
    return EMPTY;
  }
  if (!text) return EMPTY;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return EMPTY;
  }

  /* `JSON.parse` returns anything JSON can hold, and two of those are `null`
   * and a bare array. Reading a property off the first throws, which would
   * turn an empty file into a crash on launch. */
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY;

  const body = raw as { schema?: unknown; nodes?: unknown; moneroScans?: unknown; pendingSwap?: unknown };
  if (body.schema !== SCHEMA) return EMPTY;

  const stored = (body.nodes ?? {}) as { btc?: unknown; xmr?: unknown };
  return {
    nodes: {
      btc: revalidate('esplora', stored.btc),
      xmr: revalidate('monerod', stored.xmr),
    },
    moneroScans: revalidateScans(body.moneroScans),
    /* Same door a fresh order comes through: the provider must be one this
     * build speaks to, the coins ones it lists, the numbers numbers. A file
     * from an older build simply has no entry here, which parses to null. */
    pendingSwap: parsePendingSwap(body.pendingSwap),
  };
}

/**
 * A stored node, put back through the same door a typed one comes through.
 *
 * `parseNode` is the only thing in this app that decides an address is
 * acceptable, and it stays the only thing. A stored address that would be
 * refused if somebody typed it today is refused now: the rules about plain
 * http, about credentials in the URL, about query strings, are rules about
 * where this wallet's traffic may go, and where it came from does not change
 * them.
 */
function revalidate(kind: 'esplora' | 'monerod', value: unknown): NodeConfig | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as { url?: unknown; label?: unknown; mine?: unknown; kind?: unknown };
  if (entry.kind !== kind) return null;
  const parsed = parseNode(
    kind,
    typeof entry.url === 'string' ? entry.url : '',
    typeof entry.label === 'string' ? entry.label : undefined,
    entry.mine === true,
  );
  return parsed.ok ? parsed.config : null;
}

/**
 * Every stored scan position, dropping any that does not check out.
 *
 * One bad entry loses one account's progress rather than the file, because the
 * accounts are independent and there is no reason a mangled position for one
 * should restart the other.
 */
function revalidateScans(value: unknown): Record<string, ScanPosition> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, ScanPosition> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    /* The id is a key in a file, so it is untrusted text. Anything that is not
     * one of the ids this app actually uses is dropped rather than kept: a map
     * that accumulates junk keys is a file that grows forever. */
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) continue;
    const position = revalidateScan(entry);
    if (position) out[id] = position;
  }
  return out;
}

function revalidateScan(value: unknown): ScanPosition | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as { height?: unknown; birth?: unknown };
  /* Typed, not coerced. `Number(null)` is zero and JSON writes a `NaN` as
   * `null`, so coercing here would turn a height that was never really stored
   * into a scan that starts at genesis and walks the entire chain. */
  if (typeof entry.height !== 'number' || typeof entry.birth !== 'number') return null;
  const { height, birth } = entry;
  /* Then bounds. A stored height above the chain is a scan that resumes in the
   * future and finds nothing forever, which looks exactly like a wallet with
   * no money in it. */
  if (!Number.isSafeInteger(height) || !Number.isSafeInteger(birth)) return null;
  if (height < 0 || birth < 0 || height > 100_000_000 || birth > height) return null;
  return { height, birth };
}

export async function save(store: Store, state: Persisted): Promise<void> {
  try {
    await store.write(JSON.stringify({ schema: SCHEMA, ...state }, null, 1) + '\n');
  } catch {
    /* A wallet that cannot write its settings is a wallet that forgets them,
     * which is an inconvenience. Throwing here would make it a wallet that
     * crashes when the disk is full, which is not. */
  }
}
