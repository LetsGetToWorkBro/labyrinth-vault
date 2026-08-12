/**
 * The two privacy policies, rendered from the markdown that is the source of
 * truth for them, into the two URLs App Store Connect will be given.
 *
 * ## Why this exists
 *
 * App Store Connect demands a privacy-policy URL per app and a reviewer
 * follows it. Before this script neither URL served a policy, and the failure
 * was quiet rather than loud: `site/wrangler.jsonc` sets `not_found_handling`
 * to `single-page-application`, so every unmatched path answers **200 with the
 * marketing page**. A reviewer clicking through would have landed on the
 * landing page and concluded there was no policy, with nothing anywhere
 * reporting an error.
 *
 * ## Why it renders rather than duplicates
 *
 * `store/vault/privacy-policy.md` and `store/wallet/privacy-policy.md` are
 * versioned next to the claims they repeat, and `test/store.test.ts` holds
 * some of those claims against the code: the wallet's says the swap proxy and
 * Oblivious HTTP are not switched on, and a test fails if either ever is. A
 * hand-copied HTML version would be a second copy that drifts from the one
 * under guard, and the drifted copy would be the one the public reads.
 *
 * ## Why the renderer refuses instead of coping
 *
 * This is deliberately not a markdown library. Both documents are plain prose
 * with headings, bold and italic, and this handles exactly that. Anything else
 * throws with a file and line number and fails the build.
 *
 * That is the right failure for this document in particular. A general parser
 * meeting a construct it half-knows renders something plausible and drops the
 * rest, and a privacy policy that quietly loses a sentence about what a node
 * operator can see is worse than a build that stopped. If a policy grows a
 * list or a link, this file has to grow with it, on purpose, in the same
 * commit.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const dist = join(here, '..', 'dist');

/**
 * Which document is served where. These paths are quoted in
 * `docs/shipping.md` as the URLs to paste into App Store Connect, and
 * `test/store.test.ts` checks the two agree, because a runbook promising one
 * URL while the build emits another is the same rejection as serving nothing.
 */
const POLICIES = [
  { source: 'store/vault/privacy-policy.md', route: 'vault/privacy', app: 'Labyrinth Vault' },
  { source: 'store/wallet/privacy-policy.md', route: 'privacy', app: 'Labyrinth Wallet' },
];

const escape = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Bold and italic, after escaping, so a stray angle bracket cannot open a tag. */
const inline = (text) =>
  escape(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');

/** Everything this renderer refuses, with the name of the thing it refuses. */
const UNSUPPORTED = [
  [/^\s*[-+]\s/, 'a bullet list'],
  [/^\s*\*\s/, 'a bullet list'],
  [/^\s*\d+\.\s/, 'a numbered list'],
  [/^\s*>/, 'a block quote'],
  [/^\s*\|/, 'a table'],
  [/^\s*```/, 'a code fence'],
  [/`/, 'inline code'],
  [/\[[^\]]*\]\([^)]*\)/, 'a link'],
  [/^\s*!\[/, 'an image'],
  [/^\s*(-{3,}|_{3,})\s*$/, 'a horizontal rule'],
];

function render(markdown, source) {
  const lines = markdown.split('\n');
  lines.forEach((line, index) => {
    for (const [pattern, what] of UNSUPPORTED) {
      if (pattern.test(line)) {
        throw new Error(
          `${source}:${index + 1} uses ${what}, which site/scripts/render-policies.mjs ` +
            `does not render. Teach it that construct in this commit rather than ` +
            `letting the hosted policy lose the text.\n    ${line.trim()}`
        );
      }
    }
  });

  const html = [];
  let title = null;
  for (const block of markdown.split(/\n\s*\n/)) {
    const text = block.trim();
    if (!text) continue;
    const heading = /^(#{1,6})\s+(.*)$/s.exec(text);
    if (heading) {
      const level = heading[1].length;
      const body = heading[2].replace(/\s+/g, ' ').trim();
      if (level === 1 && title === null) title = body;
      html.push(`<h${level}>${inline(body)}</h${level}>`);
      continue;
    }
    html.push(`<p>${inline(text.replace(/\n/g, ' '))}</p>`);
  }
  if (!title) throw new Error(`${source} has no top-level heading to title the page with`);
  return { title, body: html.join('\n    ') };
}

/* Self-contained and offline. The site's CSP is `default-src 'self'` with
 * `style-src 'self' 'unsafe-inline'`, so the inline stylesheet is allowed and
 * an external font or script would not be. That suits a document whose whole
 * subject is what does and does not leave your device. */
const page = ({ title, body, app }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="The privacy policy for ${escape(app)}.">
<meta name="robots" content="index, follow">
<link rel="icon" href="/favicon.ico">
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: clamp(3rem, 8vw, 7rem) clamp(1.25rem, 6vw, 6rem) 8rem;
    background: #07090b; color: #f1f3f4;
    font: 16px/1.65 "Helvetica Neue", "Arial Narrow", Arial, sans-serif;
  }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { margin: 0 0 2.5rem; font-size: clamp(2.2rem, 7vw, 3.4rem); line-height: 1.02; letter-spacing: -0.04em; }
  h2 { margin: 3.5rem 0 1rem; font-size: 0.75rem; letter-spacing: 0.16em; text-transform: uppercase;
       color: #c7332e; font-family: "SFMono-Regular", "SF Mono", Consolas, monospace; }
  p { margin: 0 0 1.25rem; color: #c9cfd4; }
  strong { color: #f1f3f4; font-weight: 700; }
  a { color: inherit; }
  .back { display: inline-block; margin-top: 4rem; padding-top: 1.5rem; border-top: 1px solid rgb(241 243 244 / 0.14);
          font: 700 11px/1 "SFMono-Regular", "SF Mono", Consolas, monospace; letter-spacing: 0.12em; }
</style>
</head>
<body>
  <main>
    ${body}
    <a class="back" href="/">LABYRINTH</a>
  </main>
</body>
</html>
`;

let wrote = 0;
for (const { source, route, app } of POLICIES) {
  const markdown = readFileSync(join(repo, source), 'utf8');
  const { title, body } = render(markdown, source);
  const out = join(dist, route, 'index.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, page({ title, body, app }));
  console.log(`  /${route}  <-  ${source}`);
  wrote += 1;
}
console.log(`rendered ${wrote} privacy ${wrote === 1 ? 'policy' : 'policies'}`);
