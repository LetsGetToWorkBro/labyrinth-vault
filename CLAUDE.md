# Working in this repository

Two applications and one shared engine. `src/` is TypeScript that both halves
use, `ios/` is the vault's Swift, `wallet/` is the companion React Native app,
`oracle/` builds Monero at a pinned commit and asks it questions.

**Read `docs/handoff.md` first.** It carries the decisions that constrain
current work and do not read out of the code.

## The rules that are not negotiable

**No multisig, and it must stay visibly not offered.** Single-sig BIP84 only.
A tree-wide guard in `test/app-wiring.test.ts` walks `src/` and
`ios/LabyrinthVault/` and fails on `sortedmulti`, `wsh(` or `sh(wsh(`. This is
a product decision, not a gap waiting to be filled.

**A vault-paired account is watch-only in the wallet, forever.** `canSignHere`
in `wallet/src/core/keyvault.ts` takes a source and nothing else. The
convenience that breaks it is "if we happen to hold a seed, sign with it",
which would produce a signature against an account somebody believes is
offline.

**Round trips prove nothing about a format.** `docs/verification.md` is the
argument and the ledger. Wherever this repository holds both halves of
somebody else's format, the test has to be upstream's own code, not ours
agreeing with itself. Three real defects were found this way, all invisible to
a then-900-test suite.

## House style

- **No em dashes and US spelling in anything a person reads**: every string in
  the apps, every document, every word on the site. Use a colon, a comma, or
  two sentences. **Code comments are exempt**, and the exemption is deliberate
  rather than an oversight: several thousand words of internal argument would
  be worse for being flattened, `test/copy-style.test.ts` says so in as many
  words, and `wallet/test/copy.test.ts` asserts the exemption is real so that
  nobody tightens it by accident. This line used to say "code, comments, docs,
  user-facing copy", which two guards contradicted, and a stated rule the
  suite disagrees with teaches people that the stated rules are decoration.
  Four guards enforce the real one over comment-stripped source:
  `test/copy-style.test.ts` for the markdown, the engine, the vault's Swift
  and the Worker; `wallet/test/copy.test.ts` for the companion's screens; and
  `test/site-claims.test.ts` for the site.
- Comments explain **why**, not what. A comment that restates the line above it
  is noise; a comment naming the failure a line prevents is the reason the line
  survives a refactor.
- Sentences in refusals, not codes. A person reading a refusal should learn
  what to do next.

## How to work

**Verify, do not assert.** Run the thing. Render the page. Read the output. A
claim made without a check is the class of mistake this project keeps finding.

**Guards over comments.** When a rule matters, write the test that fails when
it breaks, and prove the test fails by breaking it. A rule with only a comment
gets broken two hundred lines away by somebody who did not scroll.

**Strip comments before grepping source in a guard.** Twice now a guard has
fired on the prose explaining the rule it enforces. A guard that fails on its
own documentation teaches people to delete the documentation.

**Watch for degenerate fixtures.** A test whose input cannot exercise the
branch it asserts on is a test reporting on itself. `keyvault.test.ts` carries
the example: 32 bytes of `0x07` reduce to a seed with no letters in it, so a
case-sensitivity check uppercased a string with no case to change.

**Commit and push each piece as it lands.** Small, green, independently
useful. Never leave key handling half-built in a tree that is on TestFlight.

## Before you commit

    npm test                      # vault: 1078 tests, includes typecheck and swift-check
    cd wallet && npx vitest run   # companion: 963 tests
    cd wallet && npx tsc --noEmit
    cd worker && npm test         # the Worker: 68 tests, plus npm run typecheck

The counts are there so that a suite quietly shrinking is visible, not as a
target. They were 1015 and 631 for long enough to be wrong by two hundred
tests, which is the failure this line exists to catch pointed at itself.

They are no longer kept by hand. Each vitest config writes a JSON report as it
runs, and after all three suites `node scripts/test-counts.mjs` compares the
three totals against these lines and against `docs/handoff.md`. Run it with
`--write` when a count changes on purpose; it edits both files. It is not a
test, because a test that knew its own suite's total would have to run that
suite inside itself, and a report from a partial run is refused rather than
believed.

All three suites run on push: `.github/workflows/tests.yml` had one job that
stopped after the companion, so every guard under `worker/test` was enforced
only by whoever remembered, and `cd worker && npm run typecheck` had never once
been run. `test/shipping.test.ts` fails if a suite falls out of that file
again, or if the count check stops running after them.

`npm test` also rebuilds the engine bundle and writes its SHA-256 into
`ios/LabyrinthVault/Support/BundleDigest.swift`. Skipping it and then building
in Xcode produces an app that correctly refuses to launch.

**`swift:check` inside it skips on a container with no Swift, and says so.**
`./scripts/install-swift.sh` puts one there: an 840 MB download, verified
against the Swift project's signature and this repository's pinned digest,
neither skippable. It is worth the couple of minutes on any container where
you touch `ios/`, because with a toolchain that step compiles the
platform-free model, runs its 67 Swift tests, and parses every Apple-only
file for syntax. Without one it is silent, which is the shape of check that
stops being a check.

**After any pull that touches `ios/`, run `xcodegen generate`.** The
`.xcodeproj` is generated and never committed, so new Swift files are invisible
until it is regenerated, and the errors that produces name entirely different
files.

## Mounting a screen

`wallet/test/harness/` runs the companion's screens under Node. `mount(...)`
returns something you ask in a person's words: `shows`, `press`, `type`,
`controls`. Every screen `App.tsx` registers is mounted by
`wallet/test/screens-mounted.test.tsx`, and a screen added there without being
added here fails that file.

The modules a phone provides and Node does not are stood in for under
`test/harness/native/`, aliased in `vitest.config.mts`. Read the head of
`native/react-native.tsx` before trusting a result: this runs JavaScript, not
layout. A control it can press may be under another view on a real screen.
`wallet/test/harness.test.ts` keeps the stand-ins honest, including the rule
that reaching for an unmodeled member throws rather than yielding `undefined`.

## What the suite cannot see

`Package.swift` builds the platform-free half of the vault for real, but
`Vault.swift` and every screen are on its `exclude:` list because they import
SwiftUI. They are parsed for syntax and type-checked by nobody until Xcode
opens. Three Mac-only build errors reached `main` through a green suite. Two
specific holes now have guards; the general one needs a Mac in CI. This is now
the only layer of either app where nothing runs the interface: the companion's
screens are mounted, the vault's are not.

The same shape of gap at other layers is listed under "Still true, still
unverified" in `docs/handoff.md`: no daemon has accepted a broadcast, no
physical device has run the Monero surface, and no real Cake or Feather has
imported a key-image file.

## Scope

`countlinesofcode` is a separate project and is paused. Work happens in
`/home/user/labyrinth-vault`.
