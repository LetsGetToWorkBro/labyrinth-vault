/**
 * Test-only: the sliver of Node the source guard needs to read the tree.
 *
 * Deliberately not `@types/node`. That package declares `fetch`, `WebSocket`
 * and the rest as globals, which would quietly undo the thing
 * `src/platform.d.ts` exists to enforce: in the vault's source, reaching for
 * the network should not typecheck. Three functions declared here cost less
 * than losing that.
 */

declare module 'node:fs' {
  export function readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean }[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
  /** Without an encoding: the bytes, for hashing and comparing artefacts. */
  export function readFileSync(path: string): {
    length: number;
    equals(other: { length: number }): boolean;
  };
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
    options?: { stdio?: string },
  ): unknown;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

/**
 * A monotonic clock, for the one test that measures work avoided rather than
 * a value returned. `Date.now()` would do, but it moves when the system clock
 * does and this is a duration.
 */
declare const performance: { now(): number };
