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

- **No em dashes** anywhere: code, comments, docs, user-facing copy. Use a
  colon, a comma, or two sentences.
- **US spelling.** Both are enforced by `test/copy-style.test.ts`, which walks
  the filesystem.
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

    npm test                      # vault: 1015 tests, includes typecheck and swift-check
    cd wallet && npx vitest run   # companion: 631 tests
    cd wallet && npx tsc --noEmit

`npm test` also rebuilds the engine bundle and writes its SHA-256 into
`ios/LabyrinthVault/Support/BundleDigest.swift`. Skipping it and then building
in Xcode produces an app that correctly refuses to launch.

**After any pull that touches `ios/`, run `xcodegen generate`.** The
`.xcodeproj` is generated and never committed, so new Swift files are invisible
until it is regenerated, and the errors that produces name entirely different
files.

## What the suite cannot see

`Package.swift` builds the platform-free half of the vault for real, but
`Vault.swift` and every screen are on its `exclude:` list because they import
SwiftUI. They are parsed for syntax and type-checked by nobody until Xcode
opens. Three Mac-only build errors reached `main` through a green suite. Two
specific holes now have guards; the general one needs a Mac in CI.

The same shape of gap at other layers is listed under "Still true, still
unverified" in `docs/handoff.md`: no daemon has accepted a broadcast, no
physical device has run the Monero surface, and no real Cake or Feather has
imported a key-image file.

## Scope

`countlinesofcode` is a separate project and is paused. Work happens in
`/home/user/labyrinth-vault`.
