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
import { sourcesUnder } from './support/source';

/**
 * On disk, but not this product.
 *
 * `scratchpad/` is where upstream projects get cloned while their formats are
 * being read: Monero, Electrum, Coldcard's firmware, the BBQr reference,
 * BlueWallet. It is git-ignored, but this walk is over the filesystem and not
 * over the index, so without this line it starts holding BlueWallet's README
 * to our house style — which is meaningless, and was briefly confusing.
 *
 * `.work/` is the same thing one directory down: `oracle/build.sh` clones
 * Monero and rapidjson into `oracle/.work`, and rapidjson's changelog is not
 * ours to spell. The oracle's own prose lives in `oracle/README.md`, which is
 * tracked and is still walked.
 */
const NOT_OURS = new Set(['node_modules', '.git', '.build', 'scratchpad', '.work']);

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

describe('the house style holds in the strings the apps put on a screen', () => {
  /* The half the docstring above always claimed and never had.
   *
   * The walk was over `.md` only, so "every string the apps put on a screen"
   * was enforced for the companion by `wallet/test/copy.test.ts` and for the
   * marketing site by `test/site-claims.test.ts`, and for the vault and the
   * shared engine by nothing at all. That is how an em dash reached a shipping
   * Button label one tap from key material: `SHOW KEY AS TEXT — FOR ELECTRUM`
   * sat in `Screens/Export.swift` through every green run of this file.
   *
   * Comments are stripped rather than searched, which keeps the exemption the
   * docstring states: several thousand words of internal argument are not
   * front-facing copy and would be worse for being flattened. What is left
   * after stripping is a string literal or an identifier, and both are fair
   * game. An identifier spelled `normalise` in a repository that spells in US
   * English is the same decay this file exists to stop.
   *
   * `wallet/src` has its own guard in `wallet/test/copy.test.ts` and `site/`
   * has one in `test/site-claims.test.ts`, so neither is walked twice.
   * `worker/src` is here rather than in the Worker's own suite because that
   * suite is not run on push, and a refusal the Worker writes is a sentence
   * the companion shows. `test/` is deliberately absent: this file names a
   * British spelling in the paragraph above in order to forbid it, and a
   * guard that walks itself is the failure it exists to prevent.
   */
  const sources = [
    ...sourcesUnder('ios/LabyrinthVault', ['.swift']),
    ...sourcesUnder('src', ['.ts', '.js']),
    ...sourcesUnder('worker/src', ['.ts']),
  ];

  it('found the source, so a pass means something', () => {
    expect(sources.length).toBeGreaterThan(30);
    expect(sources.some((f) => f.path.endsWith('Screens/Export.swift')), 'the vault screens are not walked').toBe(true);
    expect(sources.some((f) => f.path === 'src/bridge/summary.ts'), 'the engine is not walked').toBe(true);
    expect(sources.some((f) => f.path.startsWith('worker/src/')), 'the Worker is not walked').toBe(true);
    /* The stripping has to leave the code behind. A `codeOnly` that ate
     * everything would turn all three checks below into checks over nothing,
     * and they would pass. */
    const kept = sources.reduce((total, f) => total + f.code.length, 0);
    expect(kept, 'comment stripping left nothing to check').toBeGreaterThan(100_000);
  });

  it('has no em dashes outside the comments', () => {
    const guilty: string[] = [];
    for (const file of sources) {
      file.code.split('\n').forEach((line, index) => {
        if (line.includes('—')) guilty.push(`${file.path}:${index + 1}: ${line.trim().slice(0, 70)}`);
      });
    }
    expect(guilty, 'rewrite the sentence rather than swapping the dash for a hyphen').toEqual([]);
  });

  it('spells in US English outside the comments', () => {
    const guilty: string[] = [];
    for (const file of sources) {
      for (const pattern of BRITISH) {
        const found = pattern.exec(file.code);
        if (found) guilty.push(`${file.path}: ${found[0]}`);
      }
    }
    expect(guilty).toEqual([]);
  });
});
