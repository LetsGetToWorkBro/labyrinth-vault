# Shipping: TestFlight, and the questions that have real answers

Two apps, one App Store Connect account, and a handful of questions where the
convenient answer and the true answer are not the same. This document is the
ordered runbook plus the reasoning behind the answers, so that the person
filling in the forms is answering rather than clicking.

Everything mechanical in here is already done in the repository. What is left
needs a Mac, and it is marked.

## The state of things

| | Vault | Wallet |
| --- | --- | --- |
| Bundle id | `vision.labyrinth.vault` | `vision.labyrinth.wallet` |
| Version / build | 0.1.0 (1) | 0.1.0 (1) |
| Icon | generated, committed | generated, committed |
| Privacy manifest | four empty lists, tested | four empty lists, tested |
| Export compliance | **yes**, mass market | **no**, and here is why |
| Compiles | model only, the rest parsed | prebuild proven; never compiled |

## Export compliance: the two apps have different true answers

App Store Connect asks whether the app uses non-exempt encryption. Both apps
now answer in their Info.plist so the question stops appearing on every upload.
They answer differently, and that is correct rather than an inconsistency.

**The wallet answers no.** It is watch only. It holds an extended public key, a
Monero view key, addresses and balances, and there is no secret in it to
protect. Its only cryptography is signature-shaped, and the stand-in signer is
compiled out of a release build. Nothing in it encrypts data for
confidentiality, so no non-exempt encryption is present.

**The vault answers yes.** It encrypts a seed at rest with Argon2id and
XChaCha20-Poly1305. That is data confidentiality. It is not authentication, not
a digital signature, and not copy protection, which are the exempt uses people
reach for. Answering no here would be a misstatement on a US export form, and
it would be one made in writing.

Answering yes does not mean paperwork forever. The vault qualifies as a mass
market product under ECCN **5D992.c**, the ordinary category for publicly
available encryption software. What that requires:

1. **A self-classification report to BIS**, emailed to
   `crypt-supp8@bis.doc.gov` and `enc@nsa.gov`, listing the product. It is a
   spreadsheet in a documented format, submitted once and then annually by
   1 February for anything shipped in the previous year.
2. **No CCATS, no license.** 5D992.c mass market does not need either. The
   self-classification report is the whole obligation.
3. **France** has a separate declaration for encryption products distributed
   there. Apple's export compliance questionnaire asks about it directly.

Leave `ITSEncryptionExportComplianceCode` empty unless Apple issues one. It
applies to apps that went through CCATS, and this one does not.

None of this blocks a TestFlight build. It has to be true by the time the app
is on the Store, and it is much cheaper to do once at the start than to unpick
after a rejection.

## Ordered runbook

### 1. Register the two apps

App Store Connect, two records, using the identifiers above. The organization
enrollment is the prerequisite here: Apple requires wallet apps to come from a
developer enrolled as an organization rather than an individual.

Names, subtitles, descriptions and the rest of the metadata are written out in
[`store/`](../store), one directory per app, so the words in the listing are
version controlled next to the code they describe.

### 2. Vault: generate and build (needs a Mac)

```sh
npm install
npm test                 # rebuilds the engine, its digest, the icons, the fixtures
brew install xcodegen
cd ios && xcodegen generate && open LabyrinthVault.xcodeproj
```

`npm test` first is not housekeeping. It writes the engine's SHA-256 into
`BundleDigest.swift`, and the app refuses to launch if the digest and the
bundle disagree. It also regenerates the icons from the app's own geometry and
the fixtures the test target reads.

Expect the first build to surface real errors. Everything that imports SwiftUI,
JavaScriptCore, CryptoKit or CoreImage has only ever been *parsed*, because
those frameworks exist nowhere but Apple's platforms. The model layer is a
different story: it really compiles and its tests really run, on Linux as
easily as on a Mac, via `./scripts/install-swift.sh` and then
`npm run swift:check`. Anything you can move out of the first group and into
the second is a file a compiler starts checking. See
[`../ios/README.md`](../ios/README.md) for what to expect and the two things
worth running the moment it builds.

### 3. Wallet: prebuild and build (needs a Mac)

```sh
cd wallet
npm ci
npm test
npx expo prebuild --platform ios --clean
npx expo run:ios --configuration Release
```

Prebuild itself has already been proven on Linux with `--no-install`, so the
generated project is a known quantity: the camera usage string, the export
compliance answer and the empty privacy manifest all land in the generated
`Info.plist` and `PrivacyInfo.xcprivacy`, and the bundle identifier comes out
as `vision.labyrinth.wallet`. What the dry run cannot do is run CocoaPods or
the compiler, which is what the Mac step above is for. The generated `ios/`
directory is deliberately not committed; it regenerates from `app.json`, and
`test/shipping.test.ts` is what holds `app.json`.

`--configuration Release` for the first run, not Debug. That is the
configuration where `__DEV__` is false, which is the configuration where the
stand-in vault disappears, and the difference is worth seeing before an upload
rather than after one.

### 4. Archive and upload

Xcode: Product, Archive, Distribute App, App Store Connect, Upload. Both apps.
Signing is automatic once the team is set on each target.

### 5. Internal testing first

Internal TestFlight takes up to 100 testers who are members of your team and
**skips Beta App Review entirely**. External testing takes up to 10,000 and
requires review.

Ship internal first, for both apps, for a reason that is not only speed: the
wallet has no node client yet, so every balance and fee it shows is a fixture.
An external tester who has not read this document will reasonably believe the
numbers. Internal testers can be told.

### 6. Submission day, vault

Everything in this list is either already answered in the repository or is a
form field with the answer written next to it. Do them in order; none of them
takes long, and the ones that involve other institutions (the org enrollment,
the BIS report) are the ones to start first.

**Prerequisites, once ever:**

- [ ] **Organization enrollment.** Guideline 3.1.5(b): cryptocurrency wallet
      apps must come from a developer enrolled as an *organization*, not an
      individual. If the account is individual today, start the conversion
      first: it involves a D-U-N-S number and takes days, not minutes.
- [ ] **BIS self-classification report** for the encryption (5D992.c mass
      market), emailed per the section above. Once, then annually.
- [ ] **Host the privacy policy.** `store/vault/privacy-policy.md`, at
      `https://labyrinthwallet.com/vault/privacy`. App Store Connect requires
      the URL for every app; the document is written and versioned here so the
      form is a paste. The site is a single page today, so this needs either a
      route added to it or a static file served beside it before the URL is
      entered. **Check it resolves before submitting**: a reviewer following a
      dead privacy-policy link is a rejection with a slow turnaround.

**In App Store Connect, per the vault app record:**

- [ ] Category: **Finance** primary, **Utilities** secondary.
- [ ] Name, subtitle, description, keywords, promotional text: paste from
      [`store/vault/`](../store/vault). Their lengths are tested against
      Apple's limits, so the form will accept them as-is.
- [ ] **App Privacy questionnaire: "Data Not Collected."** Every answer is
      no. This matches the four empty lists in `PrivacyInfo.xcprivacy`, which
      `test/shipping.test.ts` checks against the code, so the questionnaire,
      the manifest and the source all say the same thing.
- [ ] **Age rating:** every content question is None; the result is 4+.
      There is no unrestricted web access (no web view exists, and a test
      says so), no
      gambling, no user-generated content.
- [ ] **Privacy policy URL:** from the hosting step above.
- [ ] **App Review notes:** paste [`store/vault/review-notes.md`](../store/vault/review-notes.md)
      whole. It tells the reviewer the two things that decide this review:
      the device needs a passcode set, and WALK A DEMO TRANSACTION on the
      SIGN tab exercises the entire signing flow with no second device. No
      demo account is needed; there are no accounts.
- [ ] **Screenshots**, one required size class (6.9-inch iPhone; Apple scales
      the rest). Take them on a device or Simulator after `npm test` and a
      fresh build, from the shot list: launch self-test, the home screen, the
      demo walk's review screen (with its DEMO badge, which cannot be
      hidden), the approve screen, the signed QR, the airgap
      diagnostic. Dark, portrait, no frames or captions needed.
- [ ] **Export compliance** is answered in the Info.plist
      (`ITSAppUsesNonExemptEncryption: true`), so Connect will not re-ask per
      build. If the form asks about France, the France declaration section
      above is the answer.

**The two review risks that remain, named:**

1. A reviewer on a networked phone sees an app that claims to be offline. The
   app never claims the *device* is offline: every screen states the build's
   half (no network code, no permission), hands the radios to the person,
   and the review notes lead with this. If a rejection still comes citing
   2.1/2.3, the answer is the binary: no network entitlement, empty privacy
   manifest, open source.
2. Guideline 2.1 completeness: every screen must do something. As of this
   branch every lever in the app acts or was removed; the demo walk gives the
   reviewer the core flow in under a minute. If a reviewer reports a dead
   end, it is a bug. Treat it as one rather than arguing.

## What is not ready, honestly

**The wallet has no chain behind it.** `src/core/demo.ts` supplies every
balance, price, fee estimate and confirmation count, and the app says
`DEMO DATA` on screen for exactly as long as that is true. A tester can walk
the whole send flow, watch the airgap work, and see a mismatch refused, but
they cannot watch their own money. This is the gate for external testing, and
it is a node client rather than a polish pass.

**The vault's screens have never been compiled.** Its model layer has, and
passes twelve tests on any machine with a Swift toolchain, including a Linux
container: `./scripts/install-swift.sh` fetches one, checks it against the
Swift project's signature and a pinned digest, and `npm test` picks it up from
there without any exporting. What no compiler off a Mac can reach is every
file importing SwiftUI, JavaScriptCore, CryptoKit or CoreImage, which is the
whole interface and the engine that runs the bundle. Those are parsed and
nothing more, and Xcode is still the only thing that can say the app builds.

**The vault alone can now walk its whole flow.** A solo tester makes a vault,
exports a watch-only key, runs the launch self-test, watches it refuse things,
and walks the built-in demo transaction through read, review, approve and
sign, labeled DEMO on every screen and ended with a deliberate relock. What a
solo tester still cannot do is sign something that matters: pair the rollout
with an instruction to point Sparrow at it, or all the feedback will be about
the setup flow.

## Build numbers

`CFBundleVersion` and `ios.buildNumber` must rise on every upload. TestFlight
orders builds by them and rejects a repeat. They are both at 1; bump both
before the second upload of the same version.

## The two things that stay true

The vault has no network layer, and a test walks the source on every run to
keep it that way. Both privacy manifests declare four empty lists, and
`test/shipping.test.ts` checks each emptiness against the code rather than
trusting the plist. If either of those becomes untrue, the suite says so before
an upload does.
