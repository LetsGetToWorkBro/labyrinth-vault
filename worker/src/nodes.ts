/**
 * Standing between a wallet and a public chain node.
 *
 * The swap was not the worst leak in this app. Asking a public Esplora server
 * about your addresses tells that server your entire Bitcoin wallet, every
 * address at once, tied to one IP; the swap only ever leaked one trade. And
 * broadcasting from the phone puts the IP that first announced a transaction
 * next to the transaction, on both chains, which is the classic way somebody
 * is found. So the same treatment applies here, with one rule that matters
 * more than the rest.
 *
 * **A node somebody runs themselves is never proxied.** If a person points
 * this wallet at their own machine, the traffic already goes to somebody they
 * trust, over a network they control, and putting Labyrinth in that path
 * would take a private arrangement and route it through a stranger. That is
 * strictly worse, and the wallet decides it (`routeFor` in
 * `wallet/src/net/nodeproxy.ts`) rather than this file, because the wallet is
 * the side that knows whose machine it is.
 *
 * **Only the published public nodes may be proxied.** Not any URL. An open
 * relay that would fetch whatever it was handed is a free anonymizer for
 * whoever finds it, and a custom node is somebody's own arrangement anyway.
 * The list below is exactly the suggestions the app ships, so the set of
 * hosts this Worker can reach is the set a person could have picked from a
 * screen.
 *
 * ## Built, and not switched on
 *
 * Everything above is true of this route and none of it is happening yet.
 * `routedTransport`, the wallet's half, has no production caller: every
 * address query and every broadcast still goes straight to the node the
 * person chose, which is what the Nodes screen tells them and is therefore
 * not a lie anybody is being told. It is written down here because the trap
 * is small and expensive. Going live is one string, `SWAP_PROXY`, and filling
 * it in turns on swaps and prices while leaving chain traffic direct, so
 * somebody reading this file after that deploy would believe their addresses
 * were behind Cloudflare when they were not. Connecting the two is a change
 * in the wallet, not in this file.
 */

/**
 * The public nodes this Worker will relay to, by origin.
 *
 * Kept in step with `SUGGESTIONS` in `wallet/src/core/nodes.ts`, and a test
 * holds the two lists together so that adding a suggestion without adding it
 * here fails rather than silently falling back to a direct connection.
 */
export const PUBLIC_NODES: Record<string, { kind: 'esplora' | 'monerod'; base: string }> = {
  'mempool.space': { kind: 'esplora', base: 'https://mempool.space/api' },
  'blockstream.info': { kind: 'esplora', base: 'https://blockstream.info/api' },
  'xmr-node.cakewallet.com': { kind: 'monerod', base: 'https://xmr-node.cakewallet.com:18081' },
  'node.monerodevs.org': { kind: 'monerod', base: 'https://node.monerodevs.org:18089' },
};

export type NodeTarget = { ok: true; url: string } | { ok: false; problem: string };

/**
 * Where a request is actually allowed to go.
 *
 * The path is taken as a path and nothing else: it must begin with a slash,
 * may not climb with `..`, and may not carry a scheme or an authority, which
 * is what stops `/..%2f..%2fevil` or `//evil.example/x` from turning a node
 * relay into a general one. The origin is then chosen from the table above,
 * never from anything the caller sent.
 */
export function nodeTarget(host: string, path: string): NodeTarget {
  const entry = PUBLIC_NODES[String(host ?? '').toLowerCase()];
  if (!entry) {
    return {
      ok: false,
      problem: 'That node is not one this proxy relays to. A node you run yourself is reached directly.',
    };
  }

  const raw = String(path ?? '');
  if (!raw.startsWith('/') || raw.startsWith('//')) {
    return { ok: false, problem: 'That is not a path.' };
  }
  /* Decoded before the check, because `%2e%2e%2f` is `../` by the time it
   * reaches a URL parser, and a check that only reads the raw form is a check
   * somebody walks straight past. */
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { ok: false, problem: 'That path is not readable.' };
  }
  if (decoded.includes('..') || decoded.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(decoded.slice(1))) {
    return { ok: false, problem: 'That is not a path.' };
  }
  if (raw.length > 512) return { ok: false, problem: 'That path is too long.' };

  /* Built from the table's origin, so the only thing the caller influenced is
   * what comes after it. */
  const url = new URL(entry.base + raw);
  if (url.origin !== new URL(entry.base).origin) {
    return { ok: false, problem: 'That is not a path.' };
  }
  return { ok: true, url: url.toString() };
}
