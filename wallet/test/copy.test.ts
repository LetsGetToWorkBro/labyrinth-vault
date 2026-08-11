/**
 * Nothing this app puts on a screen contains an em dash.
 *
 * The rule and its reason are in ../test/copy-style.test.ts, which covers the
 * markdown. This covers the strings, and the strings are the half that
 * actually matters: a dash bolts two thoughts together and lets a sentence
 * avoid deciding which one it is making, and this app's sentences are read by
 * somebody deciding whether money leaves.
 *
 * Comments are stripped first. The prose explaining a rule is not the rule
 * being broken, and this repository has now had four guards fail on exactly
 * that mistake.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function sources(dir = 'src', found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** Comments removed, line count preserved so a report points somewhere. */
function codeOnly(text: string): string {
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
      if (line.startsWith('//', i)) break;
      if (line.startsWith('/*', i)) { inBlock = true; i += 2; continue; }
      kept += line[i];
      i += 1;
    }
    out += kept + '\n';
  }
  return out;
}

describe('the copy the app shows', () => {
  const files = sources();

  it('found the screens, so a pass means something', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.includes('screens/Send'))).toBe(true);
    expect(files.some((f) => f.includes('screens/Swap'))).toBe(true);
  });

  it('has no em dashes in it', () => {
    const guilty: string[] = [];
    for (const path of files) {
      const code = codeOnly(readFileSync(path, 'utf8'));
      code.split('\n').forEach((line, i) => {
        if (line.includes('—')) guilty.push(`${path}:${i + 1}`);
      });
    }
    expect(guilty, 'rewrite the sentence rather than swapping the dash').toEqual([]);
  });

  it('leaves the comments alone, which is the point of stripping them', () => {
    /* A guard that also policed internal prose would either be ignored or
     * would flatten several thousand words of argument that are better for
     * having a dash in them. This asserts the exemption is real rather than
     * accidental, so nobody "tightens" it later. */
    const withComments = files
      .map((path) => readFileSync(path, 'utf8'))
      .filter((text) => text.includes('—'));
    expect(withComments.length, 'no comment uses one, so the exemption is untested').toBeGreaterThan(0);
  });
});
