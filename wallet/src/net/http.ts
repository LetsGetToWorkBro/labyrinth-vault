/**
 * The one place this app talks to a network, and the rules it does it under.
 *
 * ## Why a transport type instead of calling fetch
 *
 * The same reason `core/swap.ts` takes one. Every module that needs the
 * network takes this as an argument, so the modules stay pure and testable,
 * and so there is exactly one file to read when the question is "what can this
 * app reach". That question gets asked about a wallet, and the answer should
 * be a short file rather than a grep.
 *
 * It also means a test can be the network. `recorded()` below turns captured
 * responses into a transport, which is how the node clients are tested against
 * real answers without a node.
 *
 * ## What talking to a node costs you
 *
 * This is not a neutral pipe and the app should never present it as one. When
 * this wallet asks a Bitcoin node about an address, that node learns the
 * address is interesting to whoever is asking, and it learns their IP. Ask it
 * about twenty addresses in a row and it learns they belong to one wallet.
 * That is the privacy cost of a light client and it is inherent, not a bug to
 * be fixed by being careful.
 *
 * The defenses are real but partial: run your own node, or use one over Tor,
 * or accept it. What this file does is make the cost visible rather than
 * quiet. There is no default node baked in anywhere in this app, because
 * choosing a default is choosing who watches you and that is not a decision to
 * make on somebody's behalf.
 *
 * ## The rules
 *
 * **One host per client.** A transport is built for a base URL and refuses to
 * request anything else. A node that answers with a redirect to somewhere
 * interesting cannot move this app to another host.
 *
 * **Everything times out.** A wallet that hangs on a dead node is a wallet
 * whose owner force quits it during a broadcast.
 *
 * **Nothing throws across the boundary.** Every call returns a result, so a
 * screen renders "the node did not answer" rather than a red box.
 */

/** What a node was asked. */
export interface Request {
  method: 'GET' | 'POST';
  /** Path only, joined onto the client's base. Never a whole URL. */
  path: string;
  /** JSON for a JSON-RPC node, or raw text for a REST one. */
  body?: unknown;
  /** POST bodies that are not JSON, such as a raw transaction in hex. */
  contentType?: 'application/json' | 'text/plain';
}

export type Reply =
  | { ok: true; status: number; text: string }
  | { ok: false; status: number | null; problem: string };

export interface Transport {
  /** The host everything goes to, for a screen that wants to name it. */
  readonly base: string;
  send(request: Request): Promise<Reply>;
}

/** Parsed JSON, or a problem. Node errors are not sentences for a person. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

export function parseJson<T>(reply: Reply): Parsed<T> {
  if (!reply.ok) return { ok: false, problem: reply.problem };
  try {
    return { ok: true, value: JSON.parse(reply.text) as T };
  } catch {
    return { ok: false, problem: 'The node answered with something that is not JSON.' };
  }
}

const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * A transport that really goes to the network.
 *
 * `base` is normalized once, here, and every path is joined onto it. A path
 * that tries to leave — a scheme, a host, a `..` — is refused rather than
 * cleaned, because a request that was not the one intended should fail loudly
 * and not quietly become a different one.
 */
export function live(base: string, timeoutMs = DEFAULT_TIMEOUT_MS): Transport {
  const root = base.replace(/\/+$/, '');

  return {
    base: root,
    async send(request: Request): Promise<Reply> {
      if (!/^\//.test(request.path) || /^\/\//.test(request.path) || request.path.includes('..')) {
        return { ok: false, status: null, problem: 'That request would leave the configured node.' };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = {};
        let body: string | undefined;
        if (request.body !== undefined) {
          headers['content-type'] = request.contentType ?? 'application/json';
          body = request.contentType === 'text/plain' ? String(request.body) : JSON.stringify(request.body);
        }

        const response = await fetch(root + request.path, {
          method: request.method,
          signal: controller.signal,
          /* A node is not a browser origin and this app has no cookies. Saying
           * so keeps a redirect from carrying anything, and keeps a
           * misconfigured node from being handed credentials it never asked
           * for. */
          credentials: 'omit',
          redirect: 'error',
          ...(Object.keys(headers).length ? { headers } : {}),
          ...(body !== undefined ? { body } : {}),
        });

        const text = await response.text();
        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            problem: nodeProblem(response.status, text),
          };
        }
        return { ok: true, status: response.status, text };
      } catch (error) {
        const message = (error as Error)?.name === 'AbortError'
          ? 'The node did not answer in time.'
          : 'The node could not be reached.';
        return { ok: false, status: null, problem: message };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * A node's failure, in words a person can act on.
 *
 * The body of a node error is for an operator, not an owner. What somebody
 * holding a phone needs is which of the three things went wrong: the node is
 * wrong, the request was wrong, or the node is unwell. Everything else is
 * available in the logs of the node they chose.
 */
function nodeProblem(status: number, body: string): string {
  if (status === 404) return 'That node does not answer this request. Check the address and the kind.';
  if (status === 401 || status === 403) return 'That node refused the request. It may require credentials.';
  if (status === 429) return 'That node is rate limiting this wallet. Wait, or use your own.';
  if (status >= 500) return 'That node is having trouble. Nothing was changed.';
  const first = body.trim().split('\n')[0] ?? '';
  return first.length > 0 && first.length < 160 ? first : `The node answered ${status}.`;
}

/**
 * A transport built from captured answers, for tests.
 *
 * Keys are `METHOD /path`. A request nothing was recorded for fails rather
 * than returning empty, so a test that quietly stopped exercising a call fails
 * instead of passing.
 */
export function recorded(
  answers: Record<string, string | { status: number; body: string }>,
  base = 'https://node.example',
): Transport & { asked: string[] } {
  const asked: string[] = [];
  return {
    base,
    asked,
    async send(request: Request): Promise<Reply> {
      const key = `${request.method} ${request.path}`;
      asked.push(key);
      const answer = answers[key];
      if (answer === undefined) {
        return { ok: false, status: null, problem: `nothing recorded for ${key}` };
      }
      if (typeof answer === 'string') return { ok: true, status: 200, text: answer };
      return answer.status < 400
        ? { ok: true, status: answer.status, text: answer.body }
        : { ok: false, status: answer.status, problem: nodeProblem(answer.status, answer.body) };
    },
  };
}
