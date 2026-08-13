/**
 * Test-only: the sliver of Node the source guard needs to read the tree.
 *
 * Deliberately not `@types/node`. That package declares `fetch`, `WebSocket`
 * and the rest as globals, which would quietly undo the thing
 * `src/platform.d.ts` exists to enforce: in the vault's source, reaching for
 * the network should not typecheck. A handful of functions declared here cost
 * less than losing that.
 */

declare module 'node:fs' {
  export function readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean }[];
  /** Without options: just the names. Used to check a directory holds exactly
   *  the store metadata fields App Store Connect asks for. */
  export function readdirSync(path: string): string[];
  /** For the shipping guards, which assert that a file a manifest or an asset
   *  catalog *names* is a file that is actually there. */
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  /** Without an encoding: the bytes, for hashing and comparing artefacts. */
  export function readFileSync(path: string): {
    length: number;
    equals(other: { length: number }): boolean;
  };
  /** A file's size without reading it. The site guards weigh media, and some
   *  of that media is megabytes of video; pulling it into memory to measure
   *  it would be an odd way to check it is not too big. */
  export function statSync(path: string): { size: number };
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: unknown): { digest(encoding: 'hex'): string };
  };
}

declare module 'node:child_process' {
  export function execFileSync(
    file: string,
    args: string[],
    options?: { stdio?: string; env?: Record<string, string | undefined> },
  ): unknown;
}

/** The environment, for the one test that renders the icons somewhere other
 *  than over the committed ones. */
declare const process: { env: Record<string, string | undefined> };

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

/**
 * A fresh JavaScript context, for the two tests that need to run code
 * somewhere other than here.
 *
 * `test/bare-runtime.test.ts` evaluates the shipped bundle with every host
 * global deleted, which is the nearest thing to JavaScriptCore that exists on
 * a build machine, and `test/encoding.test.ts` loads the UTF-8 polyfill into a
 * context of its own so that installing it cannot replace Node's, which is the
 * reference it is being compared against.
 */
declare module 'node:vm' {
  export function runInNewContext(
    code: string,
    sandbox?: Record<string, unknown>,
    options?: { timeout?: number },
  ): unknown;
}

/**
 * A monotonic clock, for the one test that measures work avoided rather than
 * a value returned. `Date.now()` would do, but it moves when the system clock
 * does and this is a duration.
 */
declare const performance: { now(): number };
