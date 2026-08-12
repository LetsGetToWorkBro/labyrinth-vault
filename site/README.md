# The Labyrinth site

The scroll-driven marketing site for Labyrinth Vault and Labyrinth Wallet. A
Vite + React single page, built to `dist/`, with every asset it needs checked in
beside it. No CMS, no server, nothing collected, nothing to configure at
runtime.

```sh
cd site
npm install
npm run dev      # local, on :5173
npm run build    # type-check, then build to dist/
```

## Hosting it on Cloudflare, from this repository

The site lives in a subdirectory of a monorepo, which is the one setting worth
getting right. In the dashboard, **Workers & Pages → Create → Pages → Connect to
Git**, pick this repository, and set:

| Field | Value |
| --- | --- |
| Production branch | `main` |
| **Root directory** | `site` |
| **Build command** | `npm install && npm run build` |
| Deploy command | `npx wrangler deploy` |

**The root directory is the one that catches people.** Left at `/`, Cloudflare
installs the vault's dependencies at the repository root and `wrangler deploy`
finds no configuration there at all, because `wrangler.jsonc` lives in this
directory. It fails in a way that reads like a build error rather than a path
error.

`site/wrangler.jsonc` is what `wrangler deploy` reads. Its `name` must match
the Workers project, or the deploy lands on a different Worker than the one
the domain points at.

Add one environment variable, to production and preview both:

```
VITE_SITE_ORIGIN = https://<the domain this is served from>
```

It is used once, to build the absolute `og:image` URL in `index.html`. Social
scrapers will not resolve a relative one, so a wrong value here means a link
preview with no picture. `site/.env` holds the default used by local builds.

Every push to `main` then rebuilds and deploys, and pull requests get their own
preview URL, which is worth having for a page this visual.

**Changing these settings does not deploy anything.** Workers Builds fires on a
push to the production branch, so a corrected build command sits there doing
nothing until the next commit or a manual retry in the dashboard. The site
spent a while serving `index.html` straight from source for this reason: the
page loaded, referenced `/src/main.tsx`, and rendered white, because a browser
cannot execute TypeScript. If the deployed page ever references `/src/`
instead of `/assets/`, that is what happened.

### What is already handled, so nothing has to be set in the dashboard

- **Caching**, in `public/_headers`. Every asset Vite emits is named with a hash
  of its own contents, so an old name can never go stale and is marked immutable
  for a year; `index.html` keeps revalidating so a deploy reaches people at once.
  The media this replaced was served with no `Cache-Control` at all, which meant
  revalidating 30 MB on every visit.
- **Security headers**, in the same file. A strict CSP, `frame-ancestors 'none'`,
  no referrer. The page talks to nothing and the header says so, which means a
  script introduced by any future mistake has nowhere to send what it finds.
- **Routing**, in `wrangler.jsonc`. `not_found_handling` is set to
  `single-page-application`, so any path that is not a built asset lands on the
  one page there is. Done natively rather than with a `/*` rule in
  `_redirects`, which would sit in front of every asset request too.

### Deploying without the dashboard

```sh
npm run build
npx wrangler deploy
```

Fine for a one-off. The Git connection is better for anything ongoing, because
it deploys what is on `main` rather than what happened to be in somebody's
working tree.

## Why the page holds still

Reported as "the scrolling is choppy and the page just skips around", and
separately as the wallet section being unreadable. One cause: **`dvh`**.

`dvh` is the *dynamic* viewport height, and on a phone it tracks the browser's
own chrome, so it changes continuously while you scroll as the URL bar
collapses and expands. Twenty-eight declarations here were sized in it, and
full-height sections stack, so the error compounds with depth. Measured at
390x844, a 56px URL bar took 900px off the document and moved the wallet
section 636px up the page. The wallet section was the one named because it
sits below eleven of them.

Everything is `svh` now, the *small* viewport height, which the spec requires
to stay put for the life of the page. The cost is that a full-height section
is about 56px shorter than the screen once the bar retracts. Every section
here is a flat color, so that seam is invisible, and a page that holds still
is worth more than a seam nobody can see.

Three other things were spending the scroll budget:

- **`scroll-behavior: smooth` on `html`** made every programmatic scroll
  animate, including the nav anchors. On a 30,000px page, GET STARTED asked
  the phone to animate 26,000px of travel and drag the hero and three sticky
  stacks through the whole journey on the way past. Gone. The hero still
  animates its own chapter jumps in JavaScript, over about one screen.
- **The hero's animation loop never stopped.** It recursed unconditionally, so
  it kept running and kept walking every segment looking for a video to seek,
  for the whole page below the hero and for as long as a background tab stayed
  open. It is gated on an IntersectionObserver now: measured, 60 frames per
  second in the hero, zero at the bottom of the page, and it resumes on the
  way back up.
- **`scroll-snap-type: x mandatory`** on the architecture strip captured a
  thumb that drifted a few degrees off vertical, which lands as the page
  refusing to move. It is `proximity` now.

`test/site-claims.test.ts` refuses `dvh`, refuses a smooth root, refuses a
mandatory snap, and checks the hero loop still has its gate. **A headless
browser has no URL bar**, so the `dvh` behavior itself cannot be reproduced in
a test that renders the page; refusing the unit is what a test can do.

## Sizing the display type

Every headline is set `clamp(floor, Nvw, ceiling)`, and on a phone **only the
floor is doing anything**. At 320px wide, `8.5vw` is 27px, so a `4rem` floor
wins at every width below about 750px: the vw term looks responsive and is
decorative, and one fixed number decides how the page reads on every phone
there is. That is how a 12-character word ended up 490px wide in a 350px
column, cut off at the screen edge.

So the sizes in the `max-width: 700px` block are not taste. Each one was
picked by measuring that heading's longest unbreakable word in em, in the
browser, at its own weight and tracking, then dividing the width the heading
actually gets at 320px by it. `test/site-claims.test.ts` holds the table of
those measurements and re-does the arithmetic against the stylesheet on every
run, so a size that grows fails, and so does a copy change that makes a word
longer. **Re-measure the word before changing a number in that table.**

## Media

`src/assets/README.md` records what each file is, how it was encoded, and why
the video settings should not be casually changed: the hero is driven by scroll
position and seeks constantly, so its keyframe interval is load-bearing.

## Claims

`test/site-claims.test.ts`, at the repository root, holds this page's security
claims against what the app can actually do, and fails the build on the ones it
cannot make. The short version: **the app cannot see the device's radios, so
nothing here may report them.** It states what is true of the build, which is
checkable against the binary, and asks the person to do their half in Settings.

The same file fails if the media grows past what a phone can reasonably open, or
if any of it moves back onto a third-party host. Read it before rewriting the
copy or adding a photograph.
