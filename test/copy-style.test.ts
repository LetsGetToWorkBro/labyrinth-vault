/**
 * The house style, checked instead of remembered.
 *
 * Two rules, both applied repository-wide in one pass and neither of them
 * enforced by anything until now:
 *
 *   - US spelling, everywhere. Half a repository in each is worse than either.
 *   - No em dashes in anything a person reads. That means every markdown file
 *     and every string the apps put on a screen.
 *
 * The second rule has a real reason behind it and it is not typography. An em
 * dash bolts two thoughts together and lets a sentence avoid deciding which it
 * is making. In a README that is a style preference; on a confirmation screen,
 * where somebody is deciding whether money leaves, a sentence that has not
 * decided what it is saying is a defect. Rewriting them turned out to improve
 * the sentences, which is the usual outcome when punctuation is doing work the
 * words should have been doing.
 *
 * Code comments are exempt and stay exempt. They are not front-facing copy and
 * the prose in this repository runs to several thousand words of internal
 * argument that would be worse for being flattened.
 *
 * This guard exists because the rule was applied once, by hand, and a rule
 * applied once by hand is a rule that decays from the next commit onward. The
 * pass that introduced it shipped without a test; this is that test, written
 * after the second pass had to redo the same work.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * On disk, but not this product.
 *
 * `scratchpad/` is where upstream projects get cloned while their formats are
 * being read: Monero, Electrum, Coldcard's firmware, the BBQr reference,
 * BlueWallet. It is git-ignored, but this walk is over the filesystem and not
 * over the index, so without this line it starts holding BlueWallet's README
 * to our house style — which is meaningless, and was briefly confusing.
 */
const NOT_OURS = new Set(['node_modules', '.git', '.build', 'scratchpad']);

/** Every markdown file that is part of the product, wherever it lives. */
function markdown(dir = '.', found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (NOT_OURS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) markdown(path, found);
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}

const BRITISH = [
  /\bnormalis[a-z]*\b/i,
  /\brecognis[a-z]*\b/i,
  /\bbehaviour[s]?\b/i,
  /\bdefence[s]?\b/i,
  /\bcentre[s]?\b/i,
  /\bcolour[s]?\b/i,
  /\bserialis[a-z]*\b/i,
  // Only the -ise family is British: "optimistic" and "optimism" are not.
  /\boptimis(e|es|ed|ing|ation)\b/i,
  // Likewise "organism", which is nobody's spelling variant.
  /\borganis(e|es|ed|ing|ation)\b/i,
  /\bminimis[a-z]*\b/i,
  /\blabelled\b/i,
  /\bcancelled\b/i,
];

describe('the house style holds', () => {
  const files = markdown();

  it('found the documentation, so a pass means something', () => {
    expect(files.length).toBeGreaterThan(6);
    expect(files).toContain('README.md');
    expect(files.some((f) => f.startsWith('wallet/'))).toBe(true);
    expect(files.some((f) => f.startsWith('docs/'))).toBe(true);
  });

  it('has no em dashes in anything a person reads', () => {
    const guilty = files
      .map((path) => ({ path, lines: readFileSync(path, 'utf8').split('\n') }))
      .flatMap(({ path, lines }) =>
        lines
          .map((line, i) => ({ where: `${path}:${i + 1}`, line }))
          .filter(({ line }) => line.includes('—')),
      );
    expect(
      guilty.map((g) => g.where),
      'rewrite the sentence rather than swapping the dash for a hyphen',
    ).toEqual([]);
  });

  it('spells in US English', () => {
    const guilty: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      for (const pattern of BRITISH) {
        const found = pattern.exec(text);
        if (found) guilty.push(`${path}: ${found[0]}`);
      }
    }
    expect(guilty).toEqual([]);
  });
});
