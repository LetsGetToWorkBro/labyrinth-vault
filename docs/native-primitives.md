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
binding, the wire format, the summary — none of these have external vectors.
*Our tests are the specification.* A Swift copy of any of them is pure downside
with nothing to check it against.

## What that leaves on each side

**Candidates for native, in order of how much they would buy:**

| Primitive | Native option | Vectors that already exist |
| --- | --- | --- |
| Argon2id | libsodium, or the argon2 reference C | reference C, in `primitives.json` |
| XChaCha20-Poly1305 | libsodium | libsodium, in `primitives.json` |
| Keccak-256 | libsodium (`crypto_hash_sha3` is *not* it — see below) | published, in `primitives.json` |

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
JIT — the dynamic-codesigning entitlement is Apple's, and WKWebView only has
one because it runs in a separate entitled process. So the engine is
interpreted, on a decade-old phone, and the honest statement about how much
worse than 1554 ms that is is that nobody here knows. Nobody should guess it in
a document either. **Build the target, run the derivation on the device, write
the number down.**

Three things follow from the numbers that are already in hand:

**It is a latency problem, not a strength problem.** `calibrateKdf` starts at
the default and only ever walks upward, so a slow device gets a slow unlock and
never a weaker vault. This was fixed earlier for exactly this reason and it is
what makes the port optional rather than urgent.

**Calibration is currently doing nothing useful.** `app/storage.ts` calls
`calibrateForThisDevice`, which targets 1000 ms — and the default already costs
1554 ms on hardware far faster than the target device. So the walk exits on its
first iteration, always, and the only thing calibration achieves today is
spending one full derivation at setup to rediscover the default. It is harmless
and it is not free. If the native port happens, calibration starts mattering
again and the target should be revisited then; if it does not, this is a
candidate for deletion.

**The ceiling is not reachable in this engine.** 512 MiB is in `KDF_LIMITS`
because a *hostile file* may claim it and the reader has to refuse before
allocating. Nothing should ever seal at it here.

## The gate

Do not port the KDF because this document lists it. Port it when the measured
on-device number for `t=3, m=64 MiB` is bad enough that a person would rather
weaken their vault than wait — because *that* is the moment the JavaScript
implementation starts costing security instead of patience.

When that happens, the order is:

1. Add libsodium to the iOS target and nothing else. One dependency, one
   reason, written down in `NOTICE.md`.
2. Make the Swift test target pass every vector in
   `test/fixtures/primitives.json` — the same file `test/primitives.test.ts`
   checks TypeScript against. Neither side gets to be the oracle for the other.
3. Move *only* `deriveKey` across, as a function the bridge calls out to. The
   sealed-blob format, the parameter floors and ceilings, the header
   authentication and every refusal stay in `src/keys/seal.ts`, because those
   are judgement and judgement does not get a second implementation.
4. Keep the JavaScript path in the build and keep testing it. Two
   implementations of a standard, both pinned to the reference, is a
   cross-check. Deleting one throws that away.

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
deliberately implemented twice — NFKD, in Swift and in TypeScript. It is
allowed because it is a Unicode operation with a specification, both
implementations are the platform's rather than ours, and
`test/fixtures/primitives.json` pins the exact bytes for inputs chosen to catch
a disagreement. `test/primitives.test.ts` checks the TypeScript half;
`ios/LabyrinthVaultTests/PassphraseContractTests.swift` checks the Swift half,
and both now run in the same `npm test` — the Swift through a SwiftPM target
that needs no Xcode.

One honest limit on that. NFKD under `swift test` on Linux comes from
swift-corelibs-foundation; on a phone it comes from Apple's Foundation. Those
are two implementations of the same Unicode annex, so a Linux pass is evidence
of the same kind as agreeing with libsodium — real, and not a statement about
iOS. The test target is in `project.yml`, so confirming it on a device costs
one ⌘U.

## Not on the list

**The Secure Enclave**, which comes up whenever this subject does. It is worth
doing and it is not a port: nothing in `src/` moves. Wrapping the sealed blob's
key with an SE-backed key gated on biometrics or the passcode is a change to
`app/storage.ts`'s Keychain usage, and it would help far more than a faster KDF
— it makes the file useless off the device it was sealed on. It belongs in its
own piece of work, against a real device, and it is the strongest remaining
item on this list.
