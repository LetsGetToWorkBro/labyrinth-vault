/**
 * Which node this wallet talks to, and why there is no answer by default.
 *
 * ## No default node, on purpose
 *
 * Most light wallets ship pointing at a server the developer runs or picked.
 * It makes the app work the moment it is installed, and it means the developer
 * chose, once, on behalf of everybody, who gets to watch every user's
 * addresses forever. That is a real decision and it is usually made silently.
 *
 * This app makes it out loud. There is no node until somebody sets one, the
 * screen says what setting one costs, and running your own is presented as the
 * ordinary thing rather than the advanced one. The wallet is less convenient
 * for it. That is the trade, and it is the same trade the rest of this product
 * makes everywhere else.
 *
 * ## What a node learns
 *
 * For Bitcoin: every address in the account, because a light client has to ask
 * about each one, and they arrive in sequence from one IP. The node operator
 * can assemble the whole wallet from that traffic. This is inherent to
 * light clients, not a flaw in this implementation.
 *
 * For Monero: nothing, if the scan is local. A node serving blocks does not
 * know which outputs you found in them. That is a genuine and large difference
 * from Bitcoin, and it is worth saying to somebody choosing between the two.
 * It stops being true the moment a light wallet server is used instead, since
 * that means handing over the view key.
 *
 * ## Why the suggestions exist at all
 *
 * Somebody who has not yet run a node needs somewhere to start, and refusing
 * to name any host is a purity that pushes people to whatever they find in a
 * search result. So there is a short list, every entry is labeled with who
 * runs it, and nothing on it is selected until somebody selects it.
 */

export type NodeKind = 'esplora' | 'monerod';

export interface NodeConfig {
  kind: NodeKind;
  /** Base URL, scheme included. Trailing slashes are stripped when stored. */
  url: string;
  /** What to call it on screen. Defaults to the host. */
  label: string;
  /** True when the owner said this is their own machine. Changes the copy. */
  mine: boolean;
}

export type NodeCheck = { ok: true; config: NodeConfig } | { ok: false; problem: string };

/**
 * Validate a node address before anything is sent to it.
 *
 * The rules are about not sending a wallet's traffic somewhere it did not
 * mean to go, so each refusal is specific rather than "invalid URL".
 */
export function parseNode(kind: NodeKind, raw: string, label?: string, mine = false): NodeCheck {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, problem: 'Enter the address of a node.' };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, problem: 'That is not an address. It needs a scheme, like https://' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, problem: 'A node address is http or https.' };
  }

  /* Plain http is allowed and only for the case it exists for: a node on the
   * same machine or the same house. Over the open internet it hands every
   * address in the wallet to anybody on the path, which is the one thing
   * choosing your own node was supposed to avoid. */
  if (url.protocol === 'http:' && !isLocal(url.hostname)) {
    return {
      ok: false,
      problem: 'Plain http is only allowed to a node on your own network. Anything else needs https.',
    };
  }

  if (url.username || url.password) {
    /* Credentials in a URL end up in logs, in screenshots and in whatever the
     * app copies to a clipboard. A node that needs authentication needs a
     * design for it, not a convention smuggled through the address bar. */
    return { ok: false, problem: 'Put credentials somewhere other than the address.' };
  }

  if (url.search || url.hash) {
    return { ok: false, problem: 'A node address has no query or fragment.' };
  }

  return {
    ok: true,
    config: {
      kind,
      url: (url.origin + url.pathname).replace(/\/+$/, ''),
      label: (label ?? '').trim() || url.hostname,
      mine,
    },
  };
}

/**
 * True only for a name or literal that cannot leave the owner's own network.
 *
 * ## This used to be a prefix match, and a prefix match is not an address
 *
 * The previous version tested `/^10\./` against the hostname. `10.evil.com`
 * starts with `10.` and is a perfectly ordinary public domain, so it passed,
 * and so did `192.168.evil.com` and `172.16.attacker.net`. The consequence is
 * specific rather than theoretical: `parseNode` allows plain http *only* to a
 * local node, so a name that merely looks local buys an attacker an
 * unencrypted connection carrying every address in the wallet, from the one
 * screen whose entire purpose is choosing who gets to watch you.
 *
 * A private address is a number in a range, so this parses the number. Four
 * decimal octets, each in range, and then the range test. Anything that is
 * not an IPv4 literal is not private, and the answer is no.
 *
 * Names are separate and both are safe by construction: `localhost` resolves
 * to the loopback by definition, and `.local` is reserved for mDNS and cannot
 * be registered publicly, so neither can be pointed at somebody's server.
 */
function isLocal(hostname: string): boolean {
  /* WHATWG URL keeps the brackets on an IPv6 literal. Strip them before
   * comparing, or `[::1]` is silently not the loopback. */
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (host === '::1') return true;

  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!octets) return false;

  const parts = octets.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];

  if (a === 127) return true;                      // loopback
  if (a === 10) return true;                       // RFC 1918
  if (a === 192 && b === 168) return true;         // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 169 && b === 254) return true;         // link-local, RFC 3927
  return false;
}

/** True for an address that never leaves the owner's own network. */
export function isLocalNode(config: NodeConfig): boolean {
  try {
    return isLocal(new URL(config.url).hostname);
  } catch {
    return false;
  }
}

/**
 * What this node arrangement costs, in a sentence the screen shows.
 *
 * Four cases and four different truths. A wallet that showed the same warning
 * regardless of whether the node is in the next room would be training people
 * to ignore it.
 */
export function privacyNote(config: NodeConfig | null): string {
  if (!config) {
    return 'No node is set, so this wallet is showing fixture data and cannot see any real balance.';
  }
  if (config.kind === 'monerod') {
    return isLocalNode(config)
      ? 'Your own node, on your own network. It serves blocks and never learns which outputs in them are yours.'
      : `${config.label} serves blocks to this wallet. Scanning happens on this device, so the node does not learn which outputs are yours. It does learn your IP address and that you are running a wallet.`;
  }
  return isLocalNode(config)
    ? 'Your own node, on your own network. Nothing about your addresses leaves the house.'
    : `${config.label} will be asked about every address in this wallet, in sequence, from your IP address. Whoever runs it can assemble the whole account from that. Running your own node is the only fix.`;
}

/**
 * Somewhere to start, for somebody who has not run a node yet.
 *
 * Named with who operates them, because "a public node" is not information and
 * "a company that sells blockchain analytics" is. Nothing here is chosen for
 * anybody: the list is inert until somebody picks one.
 */
export const SUGGESTIONS: { kind: NodeKind; url: string; label: string; who: string }[] = [
  {
    kind: 'esplora',
    url: 'https://mempool.space/api',
    label: 'mempool.space',
    who: 'Mempool Space K.K. Public and widely used. Sees every address you ask about.',
  },
  {
    kind: 'esplora',
    url: 'https://blockstream.info/api',
    label: 'blockstream.info',
    who: 'Blockstream. Public. Sees every address you ask about.',
  },
  {
    kind: 'monerod',
    url: 'https://xmr-node.cakewallet.com:18081',
    label: 'cakewallet',
    who: 'Cake Labs. Serves blocks; scanning stays on this device.',
  },
  {
    kind: 'monerod',
    url: 'https://node.monerodevs.org:18089',
    label: 'monerodevs.org',
    who: 'Community operated. Serves blocks; scanning stays on this device.',
  },
];

/**
 * What to run at home, for the screen that suggests it.
 *
 * Kept next to the suggestions so that the alternative to a public node is
 * visible in the same place as the public nodes, rather than in a document
 * nobody opens.
 */
export const OWN_NODE_HINT: Record<NodeKind, string> = {
  esplora:
    'bitcoind plus electrs, or Blockstream esplora. Both run on an ordinary machine and expose the address this wallet wants.',
  monerod:
    'monerod with --rpc-bind-ip 0.0.0.0 --confirm-external-bind. A phone on the same network can reach it over plain http.',
};
