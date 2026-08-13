# Native primitives: what to port, what not to, and the number that decides

The engine is TypeScript compiled to one file and run on the phone in
JavaScriptCore. That is a deliberate choice and [docs/engine.md](engine.md)
argues for it: one implementation of every derivation and every refusal, and it
is the one with the cross-implementation vectors, the fuzzer and the
mutation-tested guards. A second implementation is always the one that is
subtly wrong, and here subtly wrong is a well-formed address nobody holds the
key for.

That argument is correct and it is not the whole picture. This document is the
other side of it, and the line this project draws.

## The rule

**Port primitives that have somebody else's specification and somebody else's
test vectors. Do not port judgement.**

Swapping noble's Argon2id for libsodium's is not a second implementation of
*our* logic. It is a second implementation of *RFC 9106*, and both are already
pinned to the reference C code in `test/seal.test.ts` and
`test/fixtures/primitives.json`. The oracle exists, it is external, and it does
not care which language answers.

PSBT reading, the refusal rules, change re-derivation, the approval-digest
binding, the wire format, the summary: none of these have external vectors.
*Our tests are the specification.* A Swift copy of any of them is pure downside
with nothing to check it against.

## What that leaves on each side

**Candidates for native, in order of how much they would buy:**

| Primitive | Native option | Vectors that already exist |
| --- | --- | --- |
| Argon2id | libsodium, or the argon2 reference C | reference C, in `primitives.json` |
| XChaCha20-Poly1305 | libsodium | libsodium, in `primitives.json` |
| Keccak-256 | libsodium (`crypto_hash_sha3` is *not* it, see below) | published, in `primitives.json` |

Note the trap in the third row, because it is the same trap `src/keys/monero.ts`
already guards against at launch: SHA3-256 is not Keccak-256. They differ in one
padding byte and every Monero view key and address checksum depends on which one
you have. CryptoKit ships SHA-2 and offers no Keccak at all.

Two more CryptoKit gaps worth knowing before anybody plans around it: it has
`ChaChaPoly` (the IETF 96-bit-nonce construction) and **not** XChaCha20, and it
has no Argon2 of any kind. It also deliberately hides Curve25519 point
arithmetic, so nothing in `src/keys/monerocrypto.ts` could use it even in
principle. A native port means adopting libsodium, which is a new third-party
dependency outside the audited noble/scure family that
`test/supply-chain.test.ts` currently enforces. That is a real cost and it
should be paid deliberately.

**Staying in TypeScript, permanently, not just for now:** everything in
`src/keys/psbt.ts`, `src/airgap/`, `src/bridge/summary.ts`, and the derivations
in `src/keys/bitcoin.ts`, `src/keys/monero.ts` and `src/keys/monerocrypto.ts`.

## The measurement

The KDF is the whole of the interesting case, so it gets measured rather than
argued about. `npm run bench:kdf`, on a modern server CPU, with a JIT:

```
  floor this build accepts     t=1 m=8MiB p=1           69 ms
  default (RFC 9106 #2)        t=3 m=64MiB p=1        1554 ms
  default, doubled memory      t=3 m=128MiB p=1       3100 ms
  ceiling this build accepts   t=3 m=512MiB p=1      12778 ms
```

That is a **floor**. JavaScriptCore inside a third-party iOS app does not get a
JIT. The dynamic-codesigning entitlement is Apple's, and WKWebView only has
one because it runs in a separate entitled process. So the engine is
interpreted, on a decade-old phone.

This document used to stop there and say the factor was one nobody here could
guess honestly. That was true, and it was the wrong place to stop, because a
number withheld is a number the reader supplies, and the one a reader supplies
is small. It is not small. `node --jitless` turns off every tier of V8's
compiler and leaves the bytecode interpreter, which is one flag on the same
script:

```
  floor this build accepts     t=1 m=8MiB p=1         2351 ms      28x
  default (RFC 9106 #2)        t=3 m=64MiB p=1       57517 ms      41x
  default, doubled memory      t=3 m=128MiB p=1     114605 ms      43x
```

**Read that as an analogy rather than as a measurement of the shipping
engine.** V8's interpreter is not JavaScriptCore's LLInt, and nothing in this
repository can run JSC. What it establishes is an order of magnitude: an engine
with no compiler pays something like forty times, not something like twice, and
the device is slower hardware on top of that. **Build the target, run the
derivation on the device, write the real number down.**

Four things follow, and the third one is what changed.

**It is a latency problem, not a strength problem.** `calibrateKdf` starts at
the default and only ever walks upward, so a slow device gets a slow unlock and
never a weaker vault.

**Calibration is currently doing nothing useful.** `app/storage.ts` calls
`calibrateForThisDevice`, which targets 1000 ms, and the default already costs
1554 ms on hardware far faster than the target device. So the walk exits on its
first iteration, always, and the only thing calibration achieves today is
spending one full derivation at setup to rediscover the default. It is harmless
and it is not free. If the native port happens, calibration starts mattering
again and the target should be revisited then; if it does not, this is a
candidate for deletion.

**The parameter dial cannot solve this, so the port is not optional.** Read the
floor row rather than the default row. `t=1 m=8 MiB` is the weakest thing
`KDF_LIMITS` permits, and interpreted it costs 2.4 seconds on a server CPU.
Anything a person would call a fast unlock is below that floor, and the floor
is where it is because a vault sealed under weaker parameters brute-forces over
a weekend. So no setting inside the limits is both usable and memory-hard in an
interpreter, and lowering `DEFAULT_KDF` is not a smaller version of the fix, it
is a trade of security for patience with nothing left over. Every route except
a native implementation is closed. The port used to be an optimization; it is
now the only move.

**The ceiling is not reachable in this engine.** 512 MiB is in `KDF_LIMITS`
because a *hostile file* may claim it and the reader has to refuse before
allocating. Nothing should ever seal at it here.

## The gate

Do not port the KDF because this document lists it. Port it when the measured
on-device number for `t=3, m=64 MiB` is bad enough that a person would rather
weaken their vault than wait, because *that* is the moment the JavaScript
implementation starts costing security instead of patience.

**Status: open. The device was asked and it answered.**

    iPhone 17 Pro Max, build 3, first-run vault creation

      Argon2id pass 1 (seal)               ~67 s
      Argon2id pass 2 (reopen)             ~67 s
      creation, wall clock                 ~2 min 15 s

Read off the setup screen's own `ELAPSED` and `REMAINING` rows, which is part
of why they are there. An unlock runs one pass, so an unlock is about **67
seconds** on the fastest phone Apple currently sells. Every other device is
slower.

That is not tens of seconds instead of a few. It is over a minute to open a
wallet, and the 41x analogy above turns out to have flattered the
device, because it was measured against a server core.

The gate asked whether the number was bad enough that a person would rather
weaken their vault than wait. It is worse than that. The first build to run
this crashed, because a phone left untouched for two minutes locks itself and
iOS stops the work of a backgrounded app. The `isIdleTimerDisabled` guard in
`test/app-wiring.test.ts` records what that cost and why it is now pinned. A
vault that cannot be created without the app fighting the operating system is
not slow, it is broken, and dropping `m` to make it bearable is precisely the
trade this gate exists to refuse.

Port it.

Nothing else in this document is blocked on it. The port is specified below and
the specification does not change with the number; only whether to start does.
Do not skip the measurement to save an hour, because the whole method of this
repository is that the thing that ships is the thing that was measured, and a
41x figure from a different engine is not that thing.

When the gate opens, the order is (steps 1 and 2 are done; see below):

1. Add libsodium to the iOS target and nothing else. One dependency, one
   reason, written down in `NOTICE.md`.
2. Make the Swift test target pass every vector in
   `test/fixtures/primitives.json`, the same file `test/primitives.test.ts`
   checks TypeScript against. Neither side gets to be the oracle for the other.
3. Move *only* `deriveKey` across, as a function the bridge calls out to. The
   sealed-blob format, the parameter floors and ceilings, the header
   authentication and every refusal stay in `src/keys/seal.ts`, because those
   are judgement and judgement does not get a second implementation.
4. Keep the JavaScript path in the build and keep testing it. Two
   implementations of a standard, both pinned to the reference, is a
   cross-check. Deleting one throws that away.

## Where the port actually is

**Step 2 is finished and it is the one that mattered.** `swift test`, inside
`npm test`, derives keys through libsodium and reproduces every vector in
`test/fixtures/primitives.json` that the library can express, and asserts a
named refusal for the ones it cannot. Both implementations answer to
argon2-cffi, which wraps the reference C, so neither is the oracle for the
other.

The fixture gained a third vector while doing it, because the two it had used
neither `DEFAULT_KDF` nor a salt of `SALT_BYTES`. The configuration this app
actually ships was pinned by nothing outside this repository until now.

    Argon2id, t=3 m=64MiB p=1, dkLen=32

      JavaScriptCore on an iPhone 17 Pro Max      ~67 s     (measured, build 3)
      libsodium on the build machine              ~0.16 s

Different hardware, so that is not a ratio to quote at anyone. What it settles
is that the cost is the interpreter and not the algorithm, which the 41x
analogy above could only suggest.

**Step 1 is finished too, and not with libsodium.** The Argon2 reference C is
vendored at `vendor/argon2`: thirteen files, about 3,300 lines, pinned
individually in its `MANIFEST.json` and checked by `test/vendor.test.ts`, the
same tamper-evidence the engine bundle gets. It compiles on Linux, on a Mac and
on a phone from one target, so there is no platform where this works and
another where it has to be arranged.

That replaced a libsodium `.systemLibrary` which reached apt here and Homebrew
on a Mac and could never have reached iOS. Two reasons, and the second is the
one that decided it:

**libsodium could not compute every blob this format permits.**
`crypto_pwhash` fixes the salt at its own length and fixes parallelism at one.
`SALT_BYTES` is 16 and matched; `KDF_LIMITS.maxP` is 4 and did not. The
reference C has neither restriction, and it is also the implementation that
produced `test/fixtures/primitives.json` by way of argon2-cffi, so the vector
check now runs against the code the vectors came from.

Speed did not pay for it, which was the obvious worry:

      libsodium                         0.156 s
      vendored reference C, release     0.189 s
      vendored reference C, debug       1.024 s

The third row is the trap. `swift test` builds C at `-O0`, so a timing from an
ordinary test run is five times pessimistic and says nothing about the app.

**Step 3 is done.** `deriveKey` in `src/keys/seal.ts` consults a host
derivation if one was installed and runs its own otherwise. `Engine.swift`
installs a block on the JavaScriptCore global as `__labyrinthArgon2id` before
evaluating the bundle, and `host.ts` adopts it once, at load. Bytes and four
numbers cross; nothing else does.

The three ways that seam turns a fast unlock into a lost vault are each held
by a test rather than by care:

- **Installed but never called.** `test/bundle.test.ts` loads the real bundle
  in a bare context with a fake host function on the global, and asserts both
  that `version` answers `kdf: "native"` and that the fake was actually
  reached, with the salt length and parameters it was reached with.
- **Named differently on each side.** The literal appears in Swift and in
  TypeScript and no compiler sees both. `test/app-wiring.test.ts` asserts the
  name matches and that Swift installs it *before* `evaluateScript`, since an
  install afterwards is one the bundle never sees. Mutation checked by
  renaming the Swift side.
- **Believed when it should not be.** A key of the wrong length is discarded
  and the JavaScript runs instead, because a short key is a weaker vault that
  still opens and nothing later could notice. A refusal falls back rather than
  throwing: the slow path gives the right answer, and someone waiting a minute
  still has their vault.

`test/native-kdf.test.ts` also seals with one path and opens with the other,
both ways round, and asserts the sealed bytes are identical. That is the
property that matters, because if it ever fails a vault made on one build does
not open on another and nothing on the way in would have said so.

**Step 4, keeping the JavaScript path, is what makes all of the above
possible.** It is not dead weight and it is not a legacy branch. It is the
fallback that lets a refusal be survivable, and it is half of the cross-check.

What is not proved here: that Apple's compiler builds any of it. The vendored
C and `Argon2id.swift` reach the app as a local Swift package rather than as
loose files, so `Package.swift` is the single description of how they are
built and `swift build` checks it on every `npm test`. But the iOS target
itself only ever compiles on a Mac.

## What was done instead, now

The two things that were worth doing regardless of how the KDF question lands,
because neither depends on it:

**The bundle is verified on the device.** `scripts/build-bundle.mjs` emits the
engine's SHA-256 as a Swift constant, and `Engine.swift` hashes what it loaded
and refuses to evaluate anything that does not match. The digest lives in the
signed text segment and the bundle does not, so a swapped bundle cannot rewrite
the expectation it is measured against. Before this, the digest was checked in
CI and by nothing on the phone.

**The passphrase is no longer a string.** It was crossing the bridge as text,
which meant an unwipeable copy in Swift's heap and another in JavaScriptCore's,
for the one secret a person actually types. It now becomes NFKD bytes at the
keyboard (`Passphrase.swift`), crosses as bytes, and is zeroed on every path
including the throwing one. `passphraseFromWire` in `host.ts` refuses a string
rather than encoding one, so the convenient path cannot quietly become the
unwipeable path again.

That second change is the one place in this project where the same behavior is
deliberately implemented twice: NFKD, in Swift and in TypeScript. It is
allowed because it is a Unicode operation with a specification, both
implementations are the platform's rather than ours, and
`test/fixtures/primitives.json` pins the exact bytes for inputs chosen to catch
a disagreement. `test/primitives.test.ts` checks the TypeScript half;
`ios/LabyrinthVaultTests/PassphraseContractTests.swift` checks the Swift half,
and both now run in the same `npm test`, the Swift through a SwiftPM target
that needs no Xcode.

One honest limit on that. NFKD under `swift test` on Linux comes from
swift-corelibs-foundation; on a phone it comes from Apple's Foundation. Those
are two implementations of the same Unicode annex, so a Linux pass is evidence
of the same kind as agreeing with libsodium: real, and not a statement about
iOS. The test target is in `project.yml`, so confirming it on a device costs
one ⌘U.

## Not on the list

**The Secure Enclave**, which comes up whenever this subject does. It is worth
doing and it is not a port: nothing in `src/` moves. Wrapping the sealed blob's
key with an SE-backed key gated on biometrics or the passcode is a change to
`app/storage.ts`'s Keychain usage, and it would help far more than a faster KDF
It makes the file useless off the device it was sealed on. It belongs in its
own piece of work, against a real device, and it is the strongest remaining
item on this list.
