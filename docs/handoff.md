# Handoff: hot spending mode and the swap rework

Written at `1f0d60c`, extended after sections 1, 2, 3 and 5 below were built.
Everything described here is on `main`, green, and pushed. Nothing in the tree
is half-built: each commit stands on its own, and the pieces that are not
started are not referenced by anything that is.

Read this before writing code. The decisions below took a session to reach and
most of them are not recoverable from the diff.

## The state of the tree

Both suites pass: **1017 vault, 707 companion.** `npx tsc --noEmit` is clean
in `wallet/`. The vault's own typecheck runs inside `npm test`.

The vault and the companion are both on TestFlight at build 11, which is
**older than everything in this document**. Nothing described here has been on
a phone.

## What was decided, and why

These are the decisions that constrain everything below. Changing one of them
is a product decision, not a refactor.

### The wallet holds its own keys now, and the vault still means something

`core/keyvault.ts` is the store. The rule that keeps the airgap from becoming
decoration is `canSignHere`, which takes a `Source` and nothing else: an
account paired from a vault is watch-only on this device **forever**, whatever
else is stored. A test asserts the function's arity, because the convenience
that breaks it is "if we happen to hold a seed, sign with it", and that would
produce a signature against an account somebody believes is offline.

### The seed is protected by the device, not by a passphrase

`seal.ts` cannot be the wallet's lock. Its `DEFAULT_KDF` is Argon2id at 64 MiB
and three passes, which the vault runs through a native module and this app has
no module for; the vault measured one derivation at roughly 57 seconds
interpreted **on a server CPU**. A minute per unlock is not a wallet, and
lowering the parameters is a weak seal on a seed, which is worse than an honest
absence of one.

So: keychain storage at `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, and **Face ID per
signature** via `core/signgate.ts`. That closes the one hole keychain storage
leaves, which is a phone taken while unlocked, at under a second instead of
ten times the friction. Per signature, never per session: a session-long unlock
is a phone that signs anything for as long as somebody keeps it awake.

**This is a real reduction against the vault and `keyvault.ts` says so in as
many words.** Anything worth more than a phone belongs on the other half. A
passphrase remains the documented upgrade, and it means shipping the vendored
Argon2id C into a React Native build that `expo prebuild --clean` regenerates.

### Both halves of a record are optional

A person restoring twenty-five words out of Feather has a Monero wallet and no
Bitcoin one. A record insisting on both would have had to invent a Bitcoin seed
to hold their Monero, and inventing key material to satisfy a shape is how a
wallet ends up with an account nobody backed up. At least one half must be
present; `parseHotRecord` refuses a record holding neither.

### A swap deposit is paid from anywhere

The sending side offered two coins because the wallet built and broadcast the
deposit itself. That was a limit of the implementation wearing the costume of a
limit of the product. `SwapDeposit.tsx` shows what somebody needs to pay from
wherever they keep the coin, and the sending side is twenty-four coins now
without watching a single new chain. Paying from this wallet is one lever on
that screen, gated on `coin.ours !== null`.

### Every coin row names its chain

The deliberate divergence from the wallet this flow otherwise imitates. That
one shows a trade as `USDC -> XMR` and prints a Solana deposit address with the
word Solana nowhere on screen. Three tests hold the catalog to it, including
one that fails if a multi-chain asset is ever relabelled with its bare ticker,
which is how it would actually break: somebody shortening a label to tidy a
list.

## What is built, and where

| what | where | tests |
| --- | --- | --- |
| Key store, generation, parsing, restore | `wallet/src/core/keyvault.ts` | `test/keyvault.test.ts`, 27 |
| Face ID gate | `wallet/src/core/signgate.ts` | `test/signgate.test.ts`, 8 |
| Coin search, grouping, address chunking | `wallet/src/core/coinpick.ts` | `test/coinpick.test.ts`, 21 |
| Coin picker screen | `wallet/src/screens/CoinPicker.tsx` | screen-coverage guard |
| Deposit screen | `wallet/src/screens/SwapDeposit.tsx` | `test/swap.test.ts` |
| Provider selection | `preferredProvider` in `core/swap.ts` | `test/swap.test.ts`, 9 |
| Disclosure atom | `wallet/src/design/atoms.tsx` | used on Home |
| Writing keys down, and the ordering | `wallet/src/core/backup.ts` | `test/backup.test.ts`, 32 |
| Backup, creation and restore screens | `wallet/src/screens/Backup.tsx`, `Restore.tsx` | `test/backup.test.ts` |
| Accounts, and what signs where | `wallet/src/core/accounts.ts` | `test/accounts.test.ts`, 17 |
| Accounts screen | `wallet/src/screens/Accounts.tsx` | `test/accounts.test.ts` |
| Signing on this device | `wallet/src/core/hotsign.ts` | `test/hotsign.test.ts`, 20 |
| The Face ID prompt itself | `wallet/src/state/biometrics.ts` | `test/hotsign.test.ts` |

`makeHotRecord` has a caller now, and the ordering that earned it one is in
`core/backup.ts`: a record is not written to the keychain until its words have
been on screen, held in a transition table rather than in a disabled button.

The airgap rule is now load-bearing in two independent places, and each was
proved by breaking it on its own. `session.ts` has no transition that takes a
vault account to the `signing` step, and `hotsign.ts` checks `canSignHere`
before it reads anything at all. Either one alone would refuse; both is
deliberate, because this is the rule the product rests on and one check is one
refactor from being the wrong one.

## What is not built

Only section 4 remains, and it is parked by the owner rather than blocked.
Sections 1, 2, 3 and 5 are done and their entries are kept below, struck
through in prose rather than deleted, because the reasoning in them is the part
that does not read out of a diff and is still what constrains the code.

### 1. Backup and restore screens (**built**)

The only thing standing between the key store and a usable hot wallet.

- A **backup screen**: 25 Monero words and 12 Bitcoin words, hold-to-reveal,
  the way the vault's own phrase screen does it. Look at
  `ios/LabyrinthVault/Screens/Setup.swift` for the interaction that already
  works.
- A **restore screen**: one field, paste or type. `readPhrase` already tells
  Monero from Bitcoin by word count and `withRestored` folds the result into
  whatever is already stored without discarding the other chain.
- A **creation flow** that generates entropy, calls `makeHotRecord`, saves, and
  **refuses to finish until the words have been shown**. A wallet that holds
  keys nobody has written down is the failure this whole ordering exists to
  prevent.

One subtlety already handled and easy to undo: a restored Monero wallet starts
at height zero. Nobody typing a phrase knows their birth height, and guessing a
recent one is fast and silently misses every coin received before it.

**Built.** One divergence from the plan above, and it is deliberate: the
backup screen does not blur its grid the way the vault's does. It draws dashes
instead, because a blur is a view treatment over a string that is still in the
view tree, still in a screenshot, and still in whatever the system captures
when the app is backgrounded. The vault can afford a blur; this is the half
with a camera roll and a network on it. There is no copy button either, and a
guard fails if one appears.

### 2. Accounts list, and delete the demo snapshot (**built**)

The audit's two critical findings, fixable only once an account can exist
without a vault. `snapshot.demo` and every branch reading it goes; the empty
state that replaces it says "no accounts yet" rather than showing fixtures
behind a warning chip. A vault becomes one source of an account rather than a
mode of the app, which also collapses `Vault.tsx`'s device-manager third into a
row in a list.

### 3. Wire both signers into Send (**built**)

No new cryptography is needed. `wallet/tsconfig.json` maps `@vault/*` to the
vault's own `src/`, and `scripts/stagenet-send.ts` has been doing a complete
in-process Monero sign through `@vault/keys/monerobuild` since it was written.
Bitcoin is `psbt.ts`. Every signer is already checked against Monero's own code
and BIP84's published vector.

Split `Send.tsx` in the same pass rather than before it. It is 930 lines and
six steps in one component; the seams should land where the new signing step
actually needs them, not where they look tidy beforehand.

**Built,** and the seam landed where that instruction predicted. Not one face
per file, which would have been nine files each knowing the whole flow: the
four faces that only exist on the path crossing a room are `SendHandoff.tsx`,
the one face where this phone signs is `SendSigning.tsx`, and the spine both
paths share stayed in `Send.tsx`.

`nativeGate` was documented in `signgate.ts` and had never been written.
`state/biometrics.ts` is it, and it is the only file importing
`expo-local-authentication`, with a guard holding that.

### 4. Trocador and ChangeNOW through the Labyrinth proxy

Decided and **deliberately parked** by the owner. When it happens:
`swap.ts:73` documents why only the keyless providers came across, and the
adapters already exist in the tools site at
`countlinesofcode/src/lib/swapkit.ts`. Trocador is an aggregator, so one
adapter buys many exchanges.

`PRIVACY_NOTE` has to be rewritten per provider in the same commit. Routing
through the proxy is a privacy **gain** against the exchange, which no longer
sees an IP, and a **loss** against Labyrinth, which now sees the swap. The copy
has to say both, and a provider screen becomes worth building once the list is
long enough to sort.

### 5. Export compliance (**done**)

`wallet/app.json` says `ITSAppUsesNonExemptEncryption: false`, which is correct
today and becomes a false statement on a US export form the day the wallet
holds a seed. `docs/shipping.md` says the wallet answers no **because** it is
watch-only.

Flip it in the same commit as the first key storage that reaches a user, not in
a cleanup pass. That drags the wallet onto the same BIS self-classification the
vault carries and the same per-build question in App Store Connect.

**Done,** and one detail was nearly got wrong. The key was **removed** rather
than set to `true`. Those are different edits with the same intention and only
one of them uploads: `true` in a manifest is what made Apple refuse four
uploads of the vault. Both apps answer YES in App Store Connect per build now,
and both are rows on one BIS report.

## Three things this session learned the hard way

Worth reading because each one is a class of bug rather than an incident.

**A green suite said nothing about whether the app compiled.** Three Mac-only
build errors got through 1015 passing tests: two files named `MoneroFile.swift`
in one target, and `Result<_, String>` where `String` does not conform to
`Error`. `Package.swift` builds the platform-free half for real, but
`Vault.swift` is on its `exclude:` list because it imports SwiftUI, so that
file and the screens are parsed for syntax and type-checked by nobody until
Xcode opens. Both specific holes now have guards. The general one stays open
and the only real fix is a Mac in CI.

**A guard that fires on its own documentation teaches people to delete the
documentation.** Happened twice. The `Result<_, String>` guard tripped on the
comment explaining the rule, and the swap handoff guard tripped on the sentence
"the wallet built and broadcast the deposit payment itself" in a screen
explaining why it no longer does. Both strip comments before checking now.

**A degenerate fixture is a test reporting on itself.** `keyvault.test.ts`
filled 32 bytes with `0x07`, which reduces to a seed of `0707...07`. The
case-sensitivity assertion uppercased a string with no case to change and
passed against a parser that had never been asked the question. Fixtures are
varied now, and the case is spelled out rather than derived.

## A units convention, now that there is one to break

`birth` means Monero **block heights**, everywhere: `pairing.ts`, `persist.ts`,
`moneroscan.ts` and `findcoins.ts` all mean blocks by it, and two of them bound
the value at a hundred million to say so. `createdAt` means **milliseconds**,
which is what `Draft.createdAt` already meant.

`HotRecord` violated that for one commit, with a millisecond field named
`birth` sitting next to four block-height ones of the same name and the same
`number` type. It was passed straight into a scan as a height, which does not
throw: it starts the scan at block 1,760,000,000,000, finds nothing, and reports
zero for an account with money in it.

The field is `createdAt` now, `watchOnlyFrom` is the one place the conversion
happens, and `test/backup.test.ts` fails if a millisecond field named `birth`
reappears or if the parser starts accepting one. Nothing had shipped with the
old name, so this was free to fix and it was free exactly once.

## The limitation this work leaves behind

**`NodeWatcher` holds one account key per chain.** A phone with a vault paired
*and* a seed of its own can therefore only watch one of them per chain, and
`store.tsx` resolves that in favor of the pairing: it is the account somebody is
more likely to have money in.

That is a real limit rather than a bug, and it is handled by being said out
loud. `watchedSources` in `core/accounts.ts` mirrors the store's precedence
exactly, `unwatchedChains` turns it into the chains a row is losing, and the
accounts screen prints a sentence on any row that is not being read. A guard in
`test/backup.test.ts` fails if the store and that function ever disagree,
because at that moment the screen starts describing a wallet the app is not
running and an unwatched balance goes back to being silently absent, which is
the failure the demo snapshot had pointing the other way.

The fix is a watcher that holds more than one account per chain. It touches
`watcher.ts`, the snapshot shape, and every screen that reads a single balance,
so it is a piece of work rather than a line, and it should be done before this
wallet is offered to somebody who will plausibly hold both kinds of account at
once.

## Still true, still unverified

Nothing in this session touched these. They are in `docs/verification.md` and
they still need hardware or a network this container does not have.

- **No running daemon has accepted a broadcast.**
  `MONERO_SEND_BROADCAST_VERIFIED` is `false` and refuses a mainnet Monero
  spend. `scripts/stagenet-wallet.ts` now makes the wallet a faucet pays, so
  the remaining human step is a funded stagenet address and one command.
- **No physical device has run any of this.** `docs/testflight.md` is the plan,
  and it now covers the coin picker, the deposit screen and the status bar.

  One correction to that plan, made after the owner reported an instant unlock:
  **the native Argon2id port already shipped.** `host.ts` installs it and
  `CArgon2` is in the build, so the vault's key derivation is compiled C and
  test 4 no longer measures a gate. It was telling testers to expect a minute
  and to treat anything under a second as a bug, which had inverted: a slow
  unlock now means the native module did not load and the JavaScript fell in
  behind it. The launch self-test reports the path, so the check is reading a
  word rather than holding a stopwatch.
- **No real Cake or Feather has imported a key-image file.** `wallet2` has, and
  `wallet2` is the library rather than the application.

Three more, added by the work above and stated plainly because the whole point
of this section is that it is current:

- **No hot signature has ever reached a real node.** Bitcoin is proved end to
  end in `test/hotsign.test.ts`: a real draft, the vault's own `signPsbt`, and
  the result through the real `verifySigned`. Monero is proved through the loop
  described below. Both are strong claims about the bytes and neither says
  anything about whether a daemon accepts them.
- **The Monero hot path is proved to the same depth as the cold one, and no
  further.** `monerosend.test.ts` now drives `executeMoneroSend` twice over the
  same fake node: once handing the unsigned set straight to `signMoneroSpend`,
  which is the vault standing in for itself, and once through `signHere` with a
  real `HotRecord`, which is this phone. Both plan, sign and broadcast. The
  same file checks that a `vault` source produces no broadcast at all inside
  that loop, which is the airgap held where it has to hold rather than only in
  a unit test of the signer.

  What that still does not prove is a real node's acceptance, which is the same
  gap the cold path has, closed by the same dry run:
  `scripts/stagenet-send.ts` against a funded stagenet address.
- **No phrase written by these screens has been typed into another wallet.**
  The words restore to the same address inside our own tests, which is our
  software agreeing with itself. `docs/testflight.md` has the step that would
  settle it, and it needs a person with Feather or Cake open.
