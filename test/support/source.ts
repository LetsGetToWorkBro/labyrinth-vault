/**
 * Reading source, for the tests that guard properties by grepping it.
 *
 * Three of those guards have now failed the same way: a pattern that looks for
 * a forbidden thing matched the *comment explaining that the thing is
 * forbidden*. `\bprocess\.` matched "the life of the process." A search for
 * "override" matched a doc comment promising there is no override. A search
 * for "continue anyway" matched a comment saying there is no continue anyway.
 *
 * Each time the fix was local and each time the next guard rediscovered the
 * bug, so it lives here now. A source guard should look at code. Prose about
 * the code is the documentation working, not the rule breaking.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SourceFile {
  path: string;
  /** Verbatim, comments and all. Use when the prose is the point. */
  text: string;
  /** Comments stripped. Use for every "this must not appear" check. */
  code: string;
}

/**
 * Remove comments, leaving the code at the same line count.
 *
 * Deliberately not a parser. It handles `//`, `/* *\/` and Swift's `///`,
 * which is all this codebase contains, and it leaves string literals alone
 * because a forbidden identifier inside a string is still worth catching —
 * that is how a name gets called across a bridge.
 */
export function codeOnly(text: string): string {
  let out = '';
  let inBlock = false;
  for (const line of text.split('\n')) {
    let kept = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) { i = line.length; break; }
        inBlock = false;
        i = end + 2;
        continue;
      }
      if (line.startsWith('//', i)) break;          // line comment: drop the rest
      if (line.startsWith('/*', i)) { inBlock = true; i += 2; continue; }
      kept += line[i];
      i += 1;
    }
    out += kept + '\n';
  }
  return out;
}

/** Every file under `dir` with one of these extensions, comments stripped. */
export function sourcesUnder(dir: string, extensions: string[]): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (extensions.some((extension) => entry.name.endsWith(extension))) {
        const text = readFileSync(path, 'utf8');
        out.push({ path, text, code: codeOnly(text) });
      }
    }
  };
  walk(dir);
  return out;
}
