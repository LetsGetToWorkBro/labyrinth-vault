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

describe('a wallet with no chain behind it says so, everywhere it shows a number', () => {
  /* The claim the store metadata makes and the App Store listing repeats. It
   * has to be true on screen, and it has to stay true as the app grows keys of
   * its own.
   *
   * Two states and two different sentences now, where there were three. The
   * one that went is fixture data, which was never a state of the chain but a
   * state of this app's own honesty. What is left: a node whose last answer
   * did not arrive, and a live one. A wallet that showed nothing in the first
   * case would be presenting yesterday's balance as today's. */

  const home = readFileSync('src/screens/Home.tsx', 'utf8');
  const nodes = readFileSync('src/screens/Nodes.tsx', 'utf8');
  const watcher = readFileSync('src/core/watcher.ts', 'utf8');

  it('shows no number at all rather than a fixture behind a label', () => {
    /* This asserted the opposite until the accounts list existed: a chip
     * reading DEMO DATA over a home screen rendered from `core/demo.ts`. The
     * audit's finding was that the label loses to the balance, every time, and
     * a screenshot of the two is indistinguishable from a screenshot of money.
     *
     * So the fixture is gone from the running app and the empty state is a
     * sentence. The assertions are inverted deliberately: the strings that
     * used to be required are now forbidden. */
    const accounts = readFileSync('src/core/accounts.ts', 'utf8');
    expect(accounts).toMatch(/No accounts yet/);
    expect(home).toMatch(/NOTHING_WATCHED/);
    expect(home).toMatch(/watchingNothing\(accounts\)/);

    const code = codeOnly(home);
    expect(code, 'the fixture chip is back').not.toMatch(/DEMO DATA/);
    expect(code, 'a home screen may not read a demo flag off the snapshot').not.toMatch(
      /snapshot\.demo/,
    );
  });

  it('never lets a fixture reach the running app through the store', () => {
    /* The other half, and the one that matters more: the chip could go while
     * the fixture stayed, which would be worse than before. The store must
     * build a `NodeWatcher` unconditionally, and no screen may read a `demo`
     * flag that no longer exists. */
    const store = codeOnly(readFileSync('src/state/store.tsx', 'utf8'));
    expect(store, 'the demo watcher is back in the running app').not.toMatch(/DemoWatcher/);
    /* One watcher per account, built from the real keys. The fixture cannot
     * come back through here without this line changing. */
    expect(store).toMatch(/new Watchers\(nodes, accountKeys/);
    const watchers = codeOnly(readFileSync('src/core/watchers.ts', 'utf8'));
    expect(watchers).toMatch(/new NodeWatcher\(nodes, account\.zpub/);
    expect(watchers, 'the fixture reached the watcher layer').not.toMatch(/DemoWatcher/);

    const chain = readFileSync('src/core/chain.ts', 'utf8');
    expect(chain, 'ChainSnapshot has a demo flag again').not.toMatch(/demo: boolean/);
  });

  it('labels a snapshot that did not come back', () => {
    expect(home).toMatch(/NOT UP TO DATE/);
    expect(watcher).toMatch(/stale: !ok/);
  });

  it('starts stale, because nothing has been fetched yet', () => {
    /* A fresh-looking snapshot full of zeroes is the most misleading state
     * this app can be in: it reads as "you have nothing" rather than as
     * "nothing has been asked". */
    const constructor = watcher.slice(watcher.indexOf('constructor('), watcher.indexOf('snapshot():'));
    expect(constructor).toMatch(/stale: true/);
  });

  it('never picks a node for somebody', () => {
    /* The default that other wallets ship as a constant. There is no constant
     * here, and this fails if one appears. */
    const store = readFileSync('src/state/store.tsx', 'utf8');
    expect(store).toMatch(/NO_NODES: WatcherNodes = \{ btc: null, xmr: null \}/);
    expect(nodes).toMatch(/no node set by/i);
  });

  it('says what is remembered, and lists nothing more than is', () => {
    /* The claim on the screen and the code behind it have to agree, and the
     * failure that matters is the screen understating what it keeps.
     *
     * It understated it for the whole of the hot-spending work. This assertion
     * used to require the sentence "No keys and no payment history", pinning it
     * in place on a build whose keychain holds a seed, and this test's own
     * comment named the failure it was letting through. So the requirement is
     * inverted: the denial is forbidden, and the screen has to name the
     * keychain wherever a seed is actually in it. */
    const code = codeOnly(nodes);
    expect(code).toMatch(/WHAT IS REMEMBERED/);
    expect(code, 'the screen denies holding keys again').not.toMatch(/No keys and/);
    expect(code).toMatch(/store\.hot === null \? null :/);
    expect(code).toMatch(/keychain/);
    const persisted = readFileSync('src/state/persist.ts', 'utf8');
    expect(persisted).toMatch(/nodes: \{ btc: NodeConfig \| null; xmr: NodeConfig \| null \}/);
    expect(persisted).toMatch(/moneroScans: Record<string, ScanPosition>/);
    expect(persisted).toMatch(/height: number;\n  birth: number;/);
  });

  it('offers a way to throw the stored file away, named for what it throws away', () => {
    /* FORGET EVERYTHING STORED cleared the node file and neither keychain
     * item, one notice below a claim that no keys were kept. Two wrong things
     * agreeing: a person reading both would conclude they had wiped a phone
     * they had not. A button is allowed to promise only what it does. */
    const code = codeOnly(nodes);
    expect(code).toMatch(/FORGET THE NODES AND THE SCAN/);
    expect(code, 'a button that clears two of four things may not say everything').not.toMatch(
      /FORGET EVERYTHING STORED/,
    );
  });

  it('has one control that actually forgets the keys, and says what that costs', () => {
    /* W-H12. `forgetHotKeys` was written, documented, exported and called by
     * nothing, while two screens told people to use it. A store function with
     * no caller is not a feature, and a refusal naming one is a dead end. */
    const security = codeOnly(readFileSync('src/screens/Vault.tsx', 'utf8'));
    expect(security).toMatch(/forgetHotKeys\(\)/);
    /* Two taps, with the cost between them. A single destructive tap on the
     * only copy of a spending key is the one place this app should be slow. */
    expect(security).toMatch(/THE WORDS ARE THE ONLY WAY BACK/);
    expect(security).toMatch(/setAsking\(true\)/);
  });

  it('says what a view key cannot see, on the screen that shows the number', () => {
    /* The one claim in this app that a person could be materially wrong about:
     * a received total under the word BALANCE would tell somebody who has
     * spent money that they still have it. */
    const watcher = readFileSync('src/core/watcher.ts', 'utf8');
    /* Through the selector, because there are two of these sentences now and
     * the whole point of the pair is that a caller has to say which account
     * it is talking about. A watcher that reached for either constant
     * directly would be one that had stopped asking. */
    expect(watcher).toMatch(/spendBlindness\(source\)/);
    const home = readFileSync('src/screens/Home.tsx', 'utf8');
    expect(home).toMatch(/monero\.caveat/);
    const asset = readFileSync('src/screens/Asset.tsx', 'utf8');
    expect(asset).toMatch(/view\.caveat/);
  });
});
