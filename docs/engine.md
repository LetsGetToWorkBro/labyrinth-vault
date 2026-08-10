# The engine, and why the app does not reimplement it

The screens are SwiftUI. Everything that *decides* anything — what a
transaction says, whether it can be signed, what an address is, what a key
derives to — is the TypeScript in `src/`, compiled to one file and run on the
device inside JavaScriptCore.

## Why not port it to Swift

Because then there would be two implementations of every derivation and every
refusal, and only one of them would have the cross-implementation vectors, the
fuzzer, and the mutation-tested guards. The second implementation is always the
one that is subtly wrong, and on a signing device "subtly wrong" is a
well-formed address whose funds nobody can reach.

JavaScriptCore ships in iOS. It has no network stack, no DOM, no timers it is
not given, and no way to reach outside its context. That is a smaller surface
than any library we could add, and it is why this option exists at all.

## The shape of the boundary

```
SwiftUI screens
      │  strings: hex in, JSON out — except the passphrase, which is bytes
Engine.swift            ← a telephone, not a participant
      │  verifies the bundle's SHA-256 before it evaluates a line of it
      │  JSContext.invokeMethod
vault.bundle.js         ← built from src/bridge/host.ts
      │
src/keys, src/airgap    ← the tested code
```

Two of those lines are recent and are the reason to read this diagram again if
you have read it before.

**The passphrase is the one thing that does not cross as text.** A string
cannot be overwritten in either heap, so the one secret a person types would
otherwise sit unwipeable on both sides of the boundary for as long as two
garbage collectors felt like keeping it. It becomes NFKD bytes at the keyboard
and crosses as an array of byte values; `passphraseFromWire` in host.ts refuses
a string rather than encoding one.

**The bundle is measured before it is run.** It is a resource file this app
evaluates as code, and code signing checks it at install and then never again.
`scripts/build-bundle.mjs` writes its SHA-256 into a Swift constant, and
Engine.swift compares before `evaluateScript`. The constant is in the signed
text segment; the bundle is not.

Four rules, each with a test:

**Strings across, always.** `bigint` does not survive a bridge and
`Uint8Array` arrives as something unpredictable. A boundary that silently
coerces will one day coerce an amount.

**Nothing throws.** Every entry point in `host.ts` catches its own errors and
returns `{ok: false, problem}`. A signer that crashes on a bad frame is one
somebody can deny service to with a sticker. `test/bundle.test.ts` throws junk
at every entry point and asserts JSON comes back from all of them.

**Secrets stay in the engine.** Keys are made, used and wiped on the
JavaScript side. There is no function that returns a private key, and
`test/app-wiring.test.ts` fails if one appears. The single exception is
`revealBackup`, which exists for the screen that asks somebody to write their
words down, and is named so that it cannot be called by accident.

**The session is explicit.** `unlock` opens, `lock` wipes. There is no
lazily-reopening accessor: if the app has locked and asks to sign, it is
refused, because that is what locking means.

## The bundle is an artefact under test

`npm test` rebuilds it first, then:

- compares it against its recorded `sha256`, so a stale committed bundle fails
  rather than ships;
- builds it a second time and requires the bytes to be identical, so the build
  is reproducible and the artefact can be checked by anybody;
- scans the bundle itself for network calls, because the guard that walks
  `src/` cannot see what a dependency dragged in;
- loads it in a bare context with no Node globals — if it needs `process` or
  `Buffer`, it fails here rather than on a phone that has neither;
- drives the entire flow through it: create a vault, unlock, export the
  watch-only key, read a transaction, sign it, lock.

It is deliberately **not minified**. It is the thing an auditor reads to find
out what actually runs on the device, and a few hundred kilobytes on a phone
with no network is worth less than being able to read it.

## What is not verified here

There is no Swift toolchain in the environment this was written in, so the
iOS sources are **not compiled**. The engine contract is checked from the
TypeScript side — every function Swift names is asserted to exist, the version
is pinned on both sides, and the model structs are compared field for field
against the wire — but "it compiles" is not among the things the suite proves.
Build it in Xcode before trusting it.
