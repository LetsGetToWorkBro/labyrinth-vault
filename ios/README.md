# Labyrinth Vault: the iOS shell

The native iPhone front end. The README at the repository root promises two
things next: the iOS shell, and the confirmation screen itself. This directory
is both.

It is SwiftUI, iOS 17, and it follows the same rules as the libraries it will
sit on top of:

- **No network code.** There is no `URLSession`, no `Network` framework, no
  socket anywhere in this target, and `test/ios-no-network.test.ts` walks the
  Swift source on every test run to keep it that way, the same treatment the
  TypeScript gets.
- **Fail closed.** The three refusal screens have exactly one action each,
  `SCAN AGAIN`. There is no "continue anyway" in the view code and no state in
  the model that could represent one.
- **What is displayed is what is signed.** The review screen hands the digest
  of the summary it displayed to the approval screen, mirroring the contract
  of `signPsbt` in `src/keys/psbt.ts`.

## Building

The project file is generated, not committed, so diffs stay readable. From the
repository root:

```sh
npm install
npm test                 # builds the engine bundle and the Swift fixtures
brew install xcodegen
cd ios && xcodegen generate && open LabyrinthVault.xcodeproj
```

`npm test` before `xcodegen` is not optional housekeeping. It regenerates
`Resources/vault.bundle.js`, writes its SHA-256 into `Support/BundleDigest.swift`,
and regenerates the fixtures the test target reads. Open the project without
it and the app will correctly refuse to launch, because the digest baked
into the binary will not match the bundle beside it.

Signing: `export LABYRINTH_TEAM_ID=ABCDE12345` and `project.yml` puts it into
every generated project. Do not set it in the Signing & Capabilities editor
instead. The `.xcodeproj` is regenerated and not committed, so that choice
disappears at the next `xcodegen generate`, and the build after it fails as
though signing had never been configured at all.

**To type-check, turn signing off rather than switching platform:**

```sh
xcodebuild -project LabyrinthVault.xcodeproj -scheme LabyrinthVault \
  -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build 2>&1 \
  | grep -E "error:" | sort -u
```

This compiles against the device SDK, which Xcode already has, and skips the
signing step that would otherwise stop the build. A device build resolves
signing **before the compiler runs**, so without those two flags a missing team
hides every compile error behind one line about a development team, which is
worth knowing precisely because it looks like good news: nothing was checked.

A simulator destination also needs no team and is the obvious-looking answer,
but since Xcode 26 the iOS runtime is not bundled, so `-destination
'generic/platform=iOS Simulator'` on a fresh install triggers a multi-gigabyte
runtime download before it compiles a line. Worth it when you want to *run* the
app. Not worth it to read a list of errors.

There are no entitlements beyond camera access; the app asks for exactly one
permission, because the camera is the only wire it has.

### What to expect on the first build

**It builds.** The first Xcode build of this target succeeded, which closes the
largest open question in the whole project: twenty-three files that had only
ever been parsed met a type-checker and survived it. What follows is kept as
written, because it explains what that does and does not prove.

**It had never been compiled by Xcode.** It was written on Linux, where
there is no Apple toolchain, so the first build was a code review the
compiler performed on our behalf rather than something that should
already have worked.

A compiler proves the app is *well formed*. It says nothing about whether it
*runs*: the launch gate evaluates the engine bundle in JavaScriptCore, checks
its SHA-256 against `Support/BundleDigest.swift`, and runs the self-test
vectors, and none of that happens until the app is on a device or a simulator.
A stale digest gives a build that compiles and then correctly refuses to launch,
which is why `npm test` comes before `xcodegen`.

What *has* been compiled, and is green, is the platform-free half: the
transaction shapes, the refusal model and the passphrase encoding, which
builds as a SwiftPM target and runs 12 tests on any machine with a Swift
toolchain (`npm run swift:check`, or `swift test` directly). That split is
deliberate: those files import Foundation and nothing else so that a compiler
can reach them. It is also how a genuine bug was found. `Refusal.detail` was
a non-exhaustive switch missing five of its nine cases, which no amount of
grepping would have shown.

Everything that imports SwiftUI, JavaScriptCore, CryptoKit or CoreImage had
only been *parsed*. Syntax, balanced braces, well-formed declarations. Not
types, not exhaustiveness, not whether a call exists. Real errors in
`Engine.swift`, `Vault.swift`, the screens and the design system were the
expected outcome, and none of them appeared. Two things bought that, and both
are worth keeping: the app's own contracts are checked by `test/app-wiring.test.ts`
walking the Swift source on every change, and the half that could be compiled
was compiled, which is where the one genuine bug turned up.

Note that `project.yml` pins `SWIFT_VERSION: "5.9"`. Under Swift 6's language
mode the three detached tasks in `Vault.swift` that carry an `Engine` and its
replies across actor boundaries would be errors rather than warnings. That
migration is real work and is not done; it is a deliberate not-yet, not an
oversight.

Two things worth running now that it builds:

1. **⌘U.** The test target runs `PassphraseContractTests`, which checks NFKD
   against `test/fixtures/primitives.json`, the same file the TypeScript is
   checked against. It passes on Linux, where NFKD comes from
   swift-corelibs-foundation. On a phone it comes from Apple's Foundation.
   Two implementations of one Unicode annex, and only one of them is the one
   a real passphrase will go through. This is the check that catches a vault
   that opens on the device that sealed it and nowhere else.

2. **Time one unseal on the oldest device you would ship to.** That single
   number decides whether the key derivation needs to be native, and nothing
   else can produce it. See [../docs/native-primitives.md](../docs/native-primitives.md).
   For reference, `npm run bench:kdf` reports about 1554 ms for the default
   parameters on a server CPU *with* a JIT, and JavaScriptCore inside a
   third-party app does not get one.

## What is real and what is staged

Real, in this code:

- The complete design system: color, type, spacing, the labyrinth geometry,
  the grain, the motion and haptic language.
- Every screen and every interaction: the scroll gate, hold-to-sign with
  progressive haptics, out-of-order frame acquisition, the refusal states,
  QR generation (CoreImage, offline) for the export and signed-transaction
  screens, and the AVFoundation scanner.
- The state machine: the signing route cannot be entered without a reviewed
  summary, and a refusal cannot be left except through the scanner.

Also real: the engine. `Engine.swift` loads the compiled TypeScript into
JavaScriptCore, verifies its SHA-256 against a constant written into the
binary at build time before evaluating a line of it, and every decision the
app makes, meaning what a transaction says and whether it can be signed, comes from
there rather than being reimplemented here.

Staged, and marked at the definition site:

- The demo fixtures in `Fixtures`, which feed the screens when there is no
  scanned transaction. The real path is wired: `Vault.offer(frame:)` goes to
  the engine and renders what it returns.
- The scanner falls back to a simulated frame stream in the Simulator, where
  there is no camera.

## Where the security actually is

Not here. The shell renders what the reader decodes and refuses when the
reader refuses. The one thing the interface itself is responsible for is the
thing no library can do: putting the destination, amount, fee and change in
front of a person, unabridged, and making the signature impossible until they
have moved all of it past their eyes. Every design decision in this directory
serves that screen.
