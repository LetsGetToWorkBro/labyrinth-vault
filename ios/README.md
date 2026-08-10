# Labyrinth Vault — iOS shell

The native iPhone front end. The README at the repository root promises two
things next: the iOS shell, and the confirmation screen itself. This directory
is both.

It is SwiftUI, iOS 17, and it follows the same rules as the libraries it will
sit on top of:

- **No network code.** There is no `URLSession`, no `Network` framework, no
  socket anywhere in this target, and `test/ios-no-network.test.ts` walks the
  Swift source on every test run to keep it that way — the same treatment the
  TypeScript gets.
- **Fail closed.** The three refusal screens have exactly one action each,
  `SCAN AGAIN`. There is no "continue anyway" in the view code and no state in
  the model that could represent one.
- **What is displayed is what is signed.** The review screen hands the digest
  of the summary it displayed to the approval screen, mirroring the contract
  of `signPsbt` in `src/keys/psbt.ts`.

## Building

The project file is generated, not committed, so diffs stay readable:

```sh
brew install xcodegen
cd ios
xcodegen generate
open LabyrinthVault.xcodeproj
```

Signing: set your team in the generated project; there are no entitlements
beyond camera access. The app requests exactly one permission — the camera —
because the camera is the only wire it has.

## What is real and what is staged

Real, in this code:

- The complete design system: colour, type, spacing, the labyrinth geometry,
  the grain, the motion and haptic language.
- Every screen and every interaction: the scroll gate, hold-to-sign with
  progressive haptics, out-of-order frame acquisition, the refusal states,
  QR generation (CoreImage, offline) for the export and signed-transaction
  screens, and the AVFoundation scanner.
- The state machine: the signing route cannot be entered without a reviewed
  summary, and a refusal cannot be left except through the scanner.

Staged, and marked at the definition site:

- The transaction itself. `Fixtures.swift` supplies the decoded summary the
  screens render. The shipped app gets this from the transaction reader that
  already exists and is tested in `src/keys/psbt.ts`; the view code does not
  change when that is wired in, which is the point of building the shell
  against the same shapes.
- The scanner falls back to a simulated frame stream in the Simulator, where
  there is no camera.

## Where the security actually is

Not here. The shell renders what the reader decodes and refuses when the
reader refuses. The one thing the interface itself is responsible for is the
thing no library can do: putting the destination, amount, fee and change in
front of a person, unabridged, and making the signature impossible until they
have moved all of it past their eyes. Every design decision in this directory
serves that screen.
