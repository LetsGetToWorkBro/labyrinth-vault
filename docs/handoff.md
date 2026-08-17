# Handoff: hot spending mode and the swap rework

Written at `1f0d60c`. Everything described here is on `main`, green, and
pushed. Nothing in the tree is half-built: each commit stands on its own, and
the pieces that are not started are not referenced by anything that is.

Read this before writing code. The decisions below took a session to reach and
most of them are not recoverable from the diff.

## The state of the tree

Both suites pass: **1015 vault, 631 companion.** `npx tsc --noEmit` is clean
in `wallet/`. The vault's own typecheck runs inside `npm test`.

The vault and the companion are both on TestFlight at build 11.

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

`makeHotRecord` **has no caller**, and that is correct: nothing may create keys
until there is a way to write them down. That is the next task.

## What is not built

In the order to do it. Each one is genuinely blocked by the one above it.

### 1. Backup and restore screens

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

### 2. Accounts list, and delete the demo snapshot

The audit's two critical findings, fixable only once an account can exist
without a vault. `snapshot.demo` and every branch reading it goes; the empty
state that replaces it says "no accounts yet" rather than showing fixtures
behind a warning chip. A vault becomes one source of an account rather than a
mode of the app, which also collapses `Vault.tsx`'s device-manager third into a
row in a list.

### 3. Wire both signers into Send

No new cryptography is needed. `wallet/tsconfig.json` maps `@vault/*` to the
vault's own `src/`, and `scripts/stagenet-send.ts` has been doing a complete
in-process Monero sign through `@vault/keys/monerobuild` since it was written.
Bitcoin is `psbt.ts`. Every signer is already checked against Monero's own code
and BIP84's published vector.

Split `Send.tsx` in the same pass rather than before it. It is 930 lines and
six steps in one component; the seams should land where the new signing step
actually needs them, not where they look tidy beforehand.

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

### 5. Export compliance

`wallet/app.json` says `ITSAppUsesNonExemptEncryption: false`, which is correct
today and becomes a false statement on a US export form the day the wallet
holds a seed. `docs/shipping.md` says the wallet answers no **because** it is
watch-only.

Flip it in the same commit as the first key storage that reaches a user, not in
a cleanup pass. That drags the wallet onto the same BIS self-classification the
vault carries and the same per-build question in App Store Connect.

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
