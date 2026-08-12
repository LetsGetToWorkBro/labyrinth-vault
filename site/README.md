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
| Framework preset | Vite |
| Build command | `npm install && npm run build` |
| Build output directory | `dist` |
| **Root directory** | `site` |

The root directory is the one that catches people. Without it, Cloudflare
installs the vault's dependencies at the repository root, finds no `dist`, and
fails in a way that reads like a build error rather than a path error.

Add one environment variable, to production and preview both:

```
VITE_SITE_ORIGIN = https://<the domain this is served from>
```

It is used once, to build the absolute `og:image` URL in `index.html`. Social
scrapers will not resolve a relative one, so a wrong value here means a link
preview with no picture. `site/.env` holds the default used by local builds.

Every push to `main` then rebuilds and deploys, and pull requests get their own
preview URL, which is worth having for a page this visual.

### What is already handled, so nothing has to be set in the dashboard

- **Caching**, in `public/_headers`. Every asset Vite emits is named with a hash
  of its own contents, so an old name can never go stale and is marked immutable
  for a year; `index.html` keeps revalidating so a deploy reaches people at once.
  The media this replaced was served with no `Cache-Control` at all, which meant
  revalidating 30 MB on every visit.
- **Security headers**, in the same file. A strict CSP, `frame-ancestors 'none'`,
  no referrer. The page talks to nothing and the header says so, which means a
  script introduced by any future mistake has nowhere to send what it finds.
- **Routing**, in `public/_redirects`. There is one page; every path lands on it
  rather than on a Cloudflare error belonging to nobody.

### Deploying without the dashboard

```sh
npm run build
npx wrangler pages deploy dist --project-name labyrinth-site
```

Fine for a one-off. The Git connection is better for anything ongoing, because
it deploys what is on `main` rather than what happened to be in somebody's
working tree.

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
