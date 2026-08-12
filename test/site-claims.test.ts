/**
 * The marketing site is a place claims go to outlive the code.
 *
 * Every other guard in this directory holds a sentence in the app or the store
 * listing against what the source actually does. The site is the loudest
 * surface of all, it is read by people deciding whether to trust this with
 * money, and until this file it was the one surface nothing checked.
 *
 * That gap was not theoretical. The site shipped with a status table reading
 * `WI-FI: OFF`, `BLUETOOTH: OFF`, `CELLULAR: OFF` in the same week the app
 * deleted exactly that table, for exactly the reason below.
 *
 * ## The rule
 *
 * **The app cannot see the radios, so nothing may say it can.** Reading the
 * radio switches would require linking the frameworks this build refuses to
 * link, which is the whole architecture. What the build can stand behind is
 * the absence of network code in its own binary, and that is checkable by
 * anybody with the source. Those are different claims, and only one of them
 * is ours to make.
 *
 * A claim about the *device* being offline is the person's to make true, by
 * hand, in Settings. The site may ask them to. It may not report it as a
 * reading.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function sources(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (/\.(tsx?|css|html)$/.test(entry.name)) found.push(path);
  }
  return found;
}

const files = sources('site/src').concat(existsSync('site/index.html') ? ['site/index.html'] : []);
const text = files.map((path) => ({ path, body: readFileSync(path, 'utf8') }));

describe('the site is there to be checked', () => {
  it('found the site to check', () => {
    /* If the site moves or is removed, this suite must fail rather than pass
     * vacuously. A guard that quietly checks nothing is worse than no guard,
     * because it reads as coverage. */
    expect(files.length).toBeGreaterThan(3);
  });
});

describe('the site does not claim a reading the app cannot take', () => {
  it('never reports a radio as off', () => {
    /* The exact shape that shipped: a definition list pairing a radio with a
     * state, which reads as an instrument panel. "CHECK IN SETTINGS" is fine
     * and is what the app itself now says; "OFF" as a value is not. */
    const offending = /<dd>\s*OFF\s*<\/dd>|(WI-?FI|BLUETOOTH|CELLULAR|RADIOS?)[^<>]{0,40}(:|<\/dt>\s*<dd>)\s*(OFF|DISABLED|DOWN)\b/i;
    for (const { path, body } of text) {
      expect(body, `${path} reports a radio state the app cannot read`).not.toMatch(offending);
    }
  });

  it('never says the vault does not connect, only that it cannot', () => {
    /* "Never connects to the internet" is a claim about a device sitting on
     * somebody's desk with its wifi on. "Has no networking code" is a claim
     * about a binary, and it is the one that survives inspection. */
    const offending = /never\s+connects?\s+to\s+the\s+internet|is\s+(always\s+)?offline\b|cannot\s+connect\s+to\s+the\s+internet/i;
    for (const { path, body } of text) {
      expect(body, `${path} claims the device is offline rather than the build`).not.toMatch(offending);
    }
  });

  it('never says the app verified the airgap', () => {
    /* The app states its half and hands over the other. "Airgap verified" is
     * the vocabulary of a measurement that was never taken. */
    const offending = /airgap\s+verified|verified\s+airgap|verify\s+(the\s+)?airgap/i;
    for (const { path, body } of text) {
      expect(body, `${path} claims the airgap was verified`).not.toMatch(offending);
    }
  });
});

describe('the site still makes the claim that is true', () => {
  it('says the binary has no network code, which is the checkable one', () => {
    const all = text.map((t) => t.body).join('\n');
    expect(all).toMatch(/no\s+network(ing)?\s+code/i);
  });

  it('asks the person to turn their own radios off', () => {
    /* Dropping the false readout must not mean dropping the instruction. The
     * person's half is the half that finishes the job, and a site that stops
     * mentioning it has made the product sound more automatic than it is. */
    const all = text.map((t) => t.body).join('\n');
    expect(all).toMatch(/settings/i);
    expect(all).toMatch(/radios?/i);
  });

  it('keeps the unaudited warning where a person will meet it', () => {
    /* The most important sentence on the page and the easiest to lose in a
     * redesign. */
    const all = text.map((t) => t.body).join('\n');
    expect(all).toMatch(/not\s+(been\s+)?independently\s+audited/i);
  });
});
