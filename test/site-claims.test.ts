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
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
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

describe('the site carries its own media', () => {
  /* It shipped loading every video and photograph from a generated-asset CDN
   * on a user-scoped path, which is a marketing site that goes blank the day
   * somebody else's bucket expires. It was also 30 MB, most of it PNGs used as
   * photographs, including a 2048x2048 four-megabyte favicon fetched by every
   * browser to draw a 32-pixel square. */

  it('loads no media from a third-party host', () => {
    const remote = /https?:\/\/[^"'`\s)]+\.(png|jpe?g|webp|avif|gif|mp4|webm|mov)\b/i;
    for (const { path, body } of text) {
      const found = body.match(remote);
      expect(found?.[0] ?? null, `${path} loads media from ${found?.[0]}`).toBeNull();
    }
  });

  /**
   * ## What this budget is actually counting
   *
   * It used to add up every file in the directory and hold the sum under 6 MB,
   * with the reason above: the page is the first thing somebody on a bad
   * connection meets. The reason is right and the arithmetic did not match it.
   *
   * **Nobody downloads the directory.** The hero ships a desktop clip and a
   * mobile clip and fetches exactly one, chosen by media query, and the same
   * goes for the two posters. So a phone was being charged for a 3.1 MB clip
   * only a laptop ever asks for. Measured, a phone pulls about 1.5 MB of the
   * 4.7 MB the old sum was policing, and the number that was failing builds
   * was a number no visitor ever experiences.
   *
   * Two budgets now, because they answer different questions:
   *
   * - **The worst single visitor.** Everything every visitor gets, plus the
   *   larger side of each either-or pair. This is the one with teeth, because
   *   it is the only one somebody waits for.
   * - **The repository total.** Looser, and still there: a runaway addition
   *   should fail even if it lands in a variant nobody's device picks.
   *
   * The pairing has to be written down rather than guessed from filenames, so
   * a new variant that nobody adds here counts against the strict budget by
   * default. That is the safe direction to be wrong in.
   */
  const EITHER_OR: Array<[string, string]> = [
    ['hero-desktop.mp4', 'hero-mobile.mp4'],
    ['hero-poster.webp', 'hero-poster-mobile.webp'],
  ];
  /* Fetched by a link-preview scraper and by iOS when somebody saves the page
   * to their home screen. Neither happens during a page load. */
  const NOT_IN_A_PAGE_LOAD = ['og.jpg', 'apple-touch-icon.png'];

  const mediaFiles = (dir: string) =>
    (existsSync(dir) ? readdirSync(dir) : [])
      .filter((name) => /\.(png|jpe?g|webp|avif|gif|mp4|webm|mov|ico)$/i.test(name))
      .map((name) => ({ name, size: statSync(join(dir, name)).size }));

  const everything = [...mediaFiles('site/src/assets'), ...mediaFiles('site/public')];

  it('found the media to weigh', () => {
    expect(everything.length).toBeGreaterThan(4);
    /* A stale pairing silently relaxes the strict budget, which is the one
     * failure this whole rewrite could introduce. */
    for (const pair of EITHER_OR) {
      for (const name of pair) {
        expect(
          everything.some((file) => file.name === name),
          `${name} is in the either-or table but not on disk, so the visitor budget is measuring the wrong set`,
        ).toBe(true);
      }
    }
  });

  it('never ships a single image bigger than a photograph needs to be', () => {
    /* A photograph over 400 KB is a PNG that should have been a WebP, which
     * is exactly how this started: a 10 MB drawer photo and a 4 MB favicon. */
    for (const { name, size } of everything) {
      if (!/\.(png|jpe?g|webp|avif)$/i.test(name)) continue;
      expect(size, `${name} is ${(size / 1024).toFixed(0)} KB`).toBeLessThan(400 * 1024);
    }
  });

  it('keeps what one visitor actually downloads to a weight a phone can open', () => {
    const eitherOr = new Set(EITHER_OR.flat());
    const shared = everything
      .filter((file) => !eitherOr.has(file.name) && !NOT_IN_A_PAGE_LOAD.includes(file.name))
      .reduce((sum, file) => sum + file.size, 0);
    const worstOfEachPair = EITHER_OR.reduce((sum, pair) => {
      const sizes = pair.map((name) => everything.find((file) => file.name === name)?.size ?? 0);
      return sum + Math.max(...sizes);
    }, 0);
    const worst = shared + worstOfEachPair;
    /* 4.5 MB, and the shape of that number matters: 3.1 MB of it is the
     * desktop hero clip, which cannot be made smaller. The masters were never
     * committed, only the already-encoded files, so re-encoding is a second
     * generation of loss rather than a saving, and the short keyframe interval
     * that the scrubbing depends on is most of what it costs. So the real
     * headroom for anything new is the megabyte and a half above it, and the
     * number a phone lives with is far lower: it takes the 1.3 MB clip, which
     * puts a whole visit around 1.5 MB. */
    expect(
      worst,
      `the heaviest single visit is ${(worst / 1048576).toFixed(2)} MB`,
    ).toBeLessThan(4.5 * 1024 * 1024);
  });

  it('keeps the whole vendored set from growing without anybody noticing', () => {
    const total = everything.reduce((sum, file) => sum + file.size, 0);
    expect(total, `site media is ${(total / 1048576).toFixed(2)} MB`).toBeLessThan(8 * 1024 * 1024);
  });

  it('never sets a caching header twice for the same file', () => {
    /* Cloudflare appends every matching rule in `_headers` rather than
     * letting the most specific one win, so a path matching two blocks gets
     * both values in one comma-joined header. Live, the hashed assets came
     * back as `max-age=0, must-revalidate, ..., max-age=31536000, immutable`,
     * and a cache reads the first one. The fingerprinting was doing nothing.
     *
     * The invariant that prevents it: the catch-all carries no caching, so
     * anything it matches falls through to Cloudflare's default, and every
     * other block is specific enough not to overlap another. */
    const headers = readFileSync('site/public/_headers', 'utf8');
    const blocks = headers
      .split(/\n(?=\/)/)
      .map((block) => block.split('\n').filter((line) => !line.trim().startsWith('#')));
    for (const block of blocks) {
      const pattern = block[0]?.trim();
      if (!pattern) continue;
      const caching = block.filter((line) => /^\s*Cache-Control:/i.test(line));
      if (pattern === '/*') {
        expect(caching, 'the catch-all must set no Cache-Control, or it doubles every other rule').toEqual([]);
      } else {
        expect(caching.length, `${pattern} sets Cache-Control ${caching.length} times`).toBeLessThanOrEqual(1);
      }
    }
    /* And no rules by extension: the media lives under /assets/, so a
     * `/*.webp` rule would be a third value on the same response. */
    expect(headers).not.toMatch(/^\/\*\.[a-z0-9]+$/im);
  });

  it('has a favicon that is a favicon', () => {
    /* The one that was 4 MB. Browsers fetch this on every page load. */
    expect(existsSync('site/public/favicon.ico')).toBe(true);
    expect(statSync('site/public/favicon.ico').size).toBeLessThan(50 * 1024);
  });
});

describe('the page holds still while somebody reads it', () => {
  /**
   * "The page just skips around as you scroll" and "can't even read the wallet
   * section" were one bug, and it was a choice of unit.
   *
   * `dvh` is the *dynamic* viewport height. On a phone it tracks the browser's
   * own chrome, so it changes continuously while you scroll, as the URL bar
   * collapses and expands. Twenty-eight declarations across this site were
   * sized in it, and full-height sections stack, so the error compounds with
   * depth. Measured at 390x844: a 56px URL bar took 900px off the document and
   * moved the wallet section 636px up the page. The wallet section was the one
   * named because it sits below eleven of them.
   *
   * `svh` is the *small* viewport height, the one assuming the chrome is
   * shown, and the spec requires it to stay put for the life of the page.
   *
   * A headless browser has no URL bar, so none of this is reproducible in a
   * test that renders the page. What a test can do is refuse the unit.
   */
  const stylesheets = files.filter((path) => /\.(css|tsx?)$/.test(path));

  it('sizes nothing in the unit that changes while you scroll', () => {
    for (const path of stylesheets) {
      const body = readFileSync(path, 'utf8');
      const found = body.match(/\b\d+(\.\d+)?dvh\b/);
      expect(
        found?.[0] ?? null,
        `${path} sizes something in ${found?.[0]}, which changes as the phone's URL bar moves`,
      ).toBeNull();
    }
  });

  it('uses the stable viewport unit instead, so this is not passing by having no heights at all', () => {
    const all = stylesheets.map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(all).toMatch(/\bsvh\b/);
  });

  it('does not make every programmatic scroll animate across 30,000px', () => {
    /* `scroll-behavior: smooth` on the root applies to the nav anchors and to
     * the browser's own scroll restoration. On a page this tall, tapping GET
     * STARTED animated 26,000px of travel, dragging the scroll-driven hero and
     * three sticky stacks through the whole journey on the way past. The hero
     * still animates its own chapter jumps, in JavaScript, over about one
     * screen; that is a local decision and stays. */
    const css = readFileSync('site/src/labyrinth.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const root = /(^|\})\s*html\s*\{([^}]*)\}/m.exec(css)?.[2] ?? '';
    expect(root, 'html sets scroll-behavior: smooth').not.toMatch(/scroll-behavior:\s*smooth/);
  });

  it('never snaps a sideways scroller hard enough to steal a vertical swipe', () => {
    /* `scroll-snap-type: x mandatory` on a strip inside a vertically scrolling
     * page captures a thumb that drifts a few degrees off vertical, which
     * lands as the page refusing to move. */
    const css = readFileSync('site/src/labyrinth.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/scroll-snap-type:\s*[xy]\s+mandatory/);
  });

  it('stops animating the hero once the hero is not on screen', () => {
    /* The loop recursed unconditionally, so it kept running, and kept walking
     * every segment looking for a video to seek, for the whole of the 30,000px
     * below the hero and for as long as a background tab stayed open. */
    const source = readFileSync('site/src/components/scroll-scrub.tsx', 'utf8');
    expect(source, 'the hero loop has no visibility gate').toMatch(/new IntersectionObserver/);
    expect(source).toMatch(/onscreen\s*&&\s*!document\.hidden/);
    expect(source, 'the observer is never disconnected').toMatch(/\.disconnect\(\)/);
  });
});

describe('the display type fits the phone it is read on', () => {
  /**
   * Three rounds of "some phones are cut off" and "SHOW THE TRANSACTIO" came
   * from one mistake repeated across the stylesheet, and it is not the one it
   * looks like.
   *
   * Every headline here is sized `clamp(floor, Nvw, ceiling)`, which reads as
   * responsive. It is not, on a phone. At 320px wide, `8.5vw` is 27px and the
   * floor is `4rem`, so the floor wins at every width below about 750px: the
   * vw term is decorative and a fixed 64px decides how the page looks on
   * every phone there is. Nobody had checked those floors against the words
   * they had to hold, and `.philosophy` was setting a 12-character word at
   * 70px in a 350px column, which is 490px of word.
   *
   * ## What this test knows and how it knows it
   *
   * `em` below is that heading's longest unbreakable word, measured in the
   * browser at its own weight and letter-spacing, with `Range.getBoundingClientRect`
   * over each whitespace- and hyphen-delimited run. `column` is the width the
   * heading actually gets at a 320px viewport: the viewport less two 1.25rem
   * gutters, less any padding of a panel it sits inside.
   *
   * So the check is arithmetic on a measurement, not a guess: the size the
   * CSS resolves to at 320px, times the word's width in em, must fit the
   * column. It fails on a size that grew and on a copy change that made a
   * word longer, and the fix for the second is to re-measure the table, not
   * to raise the number until it passes.
   *
   * It cannot see wrapping, sticky positioning, or anything above 320px. It
   * is one shape of bug, held still.
   */
  const measured: Array<{ sel: string; word: string; em: number; column: number }> = [
    { sel: '.idea-copy h2', word: 'HARDWARE', em: 5.33, column: 280 },
    { sel: '.half h2', word: 'OFFLINE', em: 3.79, column: 280 },
    { sel: '.architecture h2', word: 'EXPOSURE.', em: 5.2, column: 280 },
    { sel: '.sacred-copy h2', word: 'PERSON.', em: 3.98, column: 280 },
    { sel: '.fail-section h2', word: 'CANNOT', em: 3.83, column: 280 },
    { sel: '.failure-stack b', word: 'CANNOT', em: 3.83, column: 240 },
    { sel: '.airgap h2', word: 'CONNECT.', em: 4.51, column: 280 },
    { sel: '.qr-copy h2', word: 'LANGUAGE.', em: 5.37, column: 230 },
    { sel: '.wallet-copy h2', word: 'WALLET', em: 3.66, column: 280 },
    { sel: '.swap-title h2', word: 'WITHOUT', em: 4.18, column: 280 },
    { sel: '.chains-section > h2', word: 'DIFFERENT', em: 4.94, column: 280 },
    { sel: '.chain-worlds h3', word: 'BITCOIN', em: 3.69, column: 216 },
    { sel: '.drawer-section h2', word: 'DRAWER', em: 4.02, column: 280 },
    { sel: '.manifesto h2', word: 'NETWORK', em: 4.68, column: 280 },
    { sel: '.verify-call', word: 'VERIFY', em: 3.11, column: 280 },
    { sel: '.source-section h2', word: 'VERIFY.', em: 3.25, column: 280 },
    { sel: '.philosophy p', word: 'COMPROMISED.', em: 6.98, column: 280 },
    { sel: '.comparison > h2', word: 'WATCHES.', em: 4.64, column: 280 },
    { sel: '.start-section > h2', word: 'SYSTEM.', em: 3.86, column: 280 },
    { sel: '.product-panels h3', word: 'LABYRINTH', em: 5.19, column: 216 },
    { sel: '.final-cta h2', word: 'OFFLINE.', em: 3.92, column: 280 },
  ];

  const css = readFileSync('site/src/labyrinth.css', 'utf8');
  const mobileAt = css.indexOf('@media (max-width: 700px)');
  const base = css.slice(0, mobileAt);
  const mobile = css.slice(mobileAt, css.indexOf('\n}', mobileAt));

  /* One rule per line is the house style in this stylesheet, which is what
   * makes a regex honest here rather than the usual mistake. */
  const fontSizeOf = (selector: string, scope: string): string | null => {
    let found: string | null = null;
    for (const line of scope.split('\n')) {
      const rule = /^\s*([^{@}]+)\{(.*)\}\s*$/.exec(line);
      if (!rule) continue;
      const selectors = (rule[1] ?? '').split(',').map((s) => s.trim().replace(/\s+/g, ' '));
      if (!selectors.includes(selector)) continue;
      const declared = /font-size:\s*([^;]+);/.exec(rule[2] ?? '');
      if (declared?.[1]) found = declared[1].trim();
    }
    return found;
  };

  const at320 = (value: string): number => {
    const px = (term: string): number => {
      const t = term.trim();
      if (t.endsWith('rem')) return Number.parseFloat(t) * 16;
      if (t.endsWith('vw')) return Number.parseFloat(t) * 3.2;
      if (t.endsWith('px')) return Number.parseFloat(t);
      throw new Error(`cannot resolve "${t}" at a 320px viewport`);
    };
    const clamped = /^clamp\(([^,]+),([^,]+),([^)]+)\)$/.exec(value);
    if (!clamped) return px(value);
    return Math.max(px(clamped[1]!), Math.min(px(clamped[2]!), px(clamped[3]!)));
  };

  it('gives every measured heading a size the stylesheet actually resolves', () => {
    /* A selector that has been renamed away silently stops being checked,
     * which is the failure mode of every table like this one. */
    for (const { sel } of measured) {
      const declared = fontSizeOf(sel, mobile) ?? fontSizeOf(sel, base);
      expect(declared, `${sel} has no font-size in site/src/labyrinth.css, so this table is stale`).not.toBeNull();
    }
  });

  it('fits the longest word of each heading in the column it gets at 320px', () => {
    for (const { sel, word, em, column } of measured) {
      const declared = fontSizeOf(sel, mobile) ?? fontSizeOf(sel, base);
      if (!declared) continue;
      const size = at320(declared);
      const width = size * em;
      expect(
        width,
        `${sel} sets "${word}" at ${size.toFixed(1)}px on a 320px screen, which is ` +
          `${width.toFixed(0)}px of word in a ${column}px column. Re-measure the word ` +
          `in em before changing the number in the table.`,
      ).toBeLessThanOrEqual(column);
    }
  });

  it('does not bleed a device mockup off the edge of a container that clips', () => {
    /* `.half` hides its overflow and `.device-compact` was translated down by
     * a fifth of its own height, which took 56px off the bottom of the phone
     * at 320 and 75px at 390. Bleeding a mockup past a section edge is a real
     * technique; doing it inside a bordered half just looks like a bug, and
     * was reported as one twice. */
    const half = /\.half\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    const compact = /\.device-compact\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(half, 'the .half rule moved; this guard is checking nothing').toMatch(/overflow:\s*hidden/);
    expect(compact, '.device-compact is transformed inside a container that clips it').not.toMatch(/transform:/);
  });
});

describe('the site reads the way everything else here reads', () => {
  /**
   * Comments removed first, the way `wallet/test/copy.test.ts` does it.
   * The rule is about what a person reads on the page, and prose explaining
   * the rule is not the rule being broken. This repository has now had five
   * guards fail on exactly that mistake, including this one, on its first run.
   */
  const withoutComments = (body: string, path: string): string =>
    path.endsWith('.html')
      ? body.replace(/<!--[\s\S]*?-->/g, '')
      : body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('has no em dashes in anything a person reads', () => {
    /* The rule the wallet and the vault already hold, which the site was
     * outside of: `test/copy-style.test.ts` covers the markdown and
     * `wallet/test/copy.test.ts` covers the app's strings, and between them
     * the loudest surface in the product was unguarded. An em dash bolts two
     * thoughts together and lets a sentence avoid deciding which one it is
     * making, and this page is read by somebody deciding whether to trust
     * this with money.
     *
     * Both spellings, because JSX writes it as an entity and HTML as the
     * character, and only one of those is greppable by eye. */
    for (const { path, body } of text) {
      expect(withoutComments(body, path), `${path} contains an em dash`).not.toMatch(/&mdash;|\u2014/);
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
