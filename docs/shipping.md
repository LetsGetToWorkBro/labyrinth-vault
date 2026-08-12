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
| Compiles | **yes, Xcode, first try** | prebuild proven; never compiled |
| Launches | **yes, Simulator, self-test green** | never launched |
| Runs on real hardware | **not yet; the next gate** | no |

### What the first run on a Simulator cost, and why the next one is on metal

Two bugs, both found by launching the thing, neither findable on Linux.

The first was `ReferenceError: Can't find variable: TextEncoder`. Ten modules
called it, 650-odd tests passed, and `src/platform.d.ts` had documented it as
safe by listing the runtimes it had checked, none of which was JavaScriptCore
embedded in an app. The bundle now carries its own UTF-8 and
`test/bare-runtime.test.ts` runs the engine with every host global deleted.

The second was a confirmation screen that looked like it had no button.
`Lever` faded to 30% opacity when disabled, and the disabled lever's hint is
the word `SCROLL`, so the instruction for proceeding was the thing being
faded out.

Both are the same lesson: the gap between a green suite and a working app is
whatever the suite could not run. A Simulator closed most of it. What it
still cannot answer is the two questions below, and both of them are answers
a person deserves before money is involved.

**Argon2id timing on real hardware.** The KDF is calibrated to cost time on
purpose. `scripts/bench-kdf.mjs` measures it, but a Simulator runs on a
desktop CPU and tells you nothing about an iPhone's. If unlocking takes eight
seconds on the oldest supported device, the parameters need revisiting or the
derivation needs to be native, and that is a decision to make before people
have vaults sealed under the current numbers.

**The passcode-bound keychain class.** `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`
and the Secure Enclave access control behind Face ID are not meaningfully
exercised by a Simulator. The refusal-to-create-without-a-passcode path and
the enrollment-change invalidation both need a real device with a real
passcode.

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
   twelve-column `.csv` in a format Supplement No. 8 to Part 742 fixes
   exactly, due by 1 February for anything exported in the previous calendar
   year, and not required at all for a year with no exports. It is written
   and checked in [`store/bis/`](../store/bis); four fields need your
   details.
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

**Before that, an App ID for each,** under Certificates, Identifiers &
Profiles > Identifiers > Register an App ID. The form is short and one field
on it is a decision rather than a fact:

| Field | Vault | Wallet |
| --- | --- | --- |
| Platform | iOS, iPadOS, macOS, tvOS, watchOS, visionOS | the same |
| Description | `Labyrinth Vault` | `Labyrinth Wallet` |
| Bundle ID | **Explicit**, `vision.labyrinth.vault` | **Explicit**, `vision.labyrinth.wallet` |
| Capabilities | **none** | **none** |

**Leave every capability unchecked, and that is the decision.** Each one you
enable writes an entitlement into the signed binary. The vault's central claim
is that it has no way to reach a network, and entitlements are the one place a
reviewer or a suspicious user can check that claim without reading any source.
Enabling Push Notifications, iCloud, App Groups, Associated Domains or Network
Extensions "in case we need it later" puts a network-capable entitlement in a
binary that contains no network code, and contradicts
`test/ios-no-network.test.ts` in the artifact rather than in the repository.

Four that look like they belong here and do not:

- **The camera** is not on that list. It is `NSCameraUsageDescription` in the
  Info.plist, which `ios/project.yml` already sets. There is nothing to enable.
- **Data Protection** is a different mechanism from the one the vault uses. The
  seed is protected by its own Argon2id and XChaCha20-Poly1305 sealing and by
  the keychain class `SealedStore.swift` asks for. Neither needs this
  entitlement.
- **Keychain Sharing** shares items between your own apps. The vault and the
  wallet deliberately share nothing; that is the product.
- **App Groups** is the same instinct and the same answer.

Wildcard rather than explicit is also wrong here. A wildcard App ID cannot
carry an app to the Store, and the bundle identifier is already fixed in
`project.yml` and `app.json`.

**The Team ID is on that page**, as the App ID Prefix. It is the value
[step 2](#2-vault-generate-and-build-needs-a-mac) needs in the environment.
Export it in a shell profile rather than committing it: it is not a secret,
but it is an account identifier and it has no reason to be in a public
repository.

### 2. Vault: generate and build (needs a Mac)

```sh
npm install
npm test                 # rebuilds the engine, its digest, the icons, the fixtures
brew install xcodegen
export LABYRINTH_TEAM_ID=ABCDE12345      # once, in your shell profile
cd ios && xcodegen generate && open LabyrinthVault.xcodeproj
```

`npm test` first is not housekeeping. It writes the engine's SHA-256 into
`BundleDigest.swift`, and the app refuses to launch if the digest and the
bundle disagree. It also regenerates the icons from the app's own geometry and
the fixtures the test target reads.

**The team id belongs in the environment, not in Xcode.** The `.xcodeproj` is
generated and never committed, so a team chosen in the Signing & Capabilities
editor is gone at the next `xcodegen generate`, and the build after that fails
with *"Signing for LabyrinthVault requires a development team"* as though it
were a new problem. `ios/project.yml` reads `LABYRINTH_TEAM_ID` instead, so the
setting survives every regeneration. The ten-character id is in App Store
Connect under Membership Details.

**To type-check the code, turn signing off rather than switching platform:**

```sh
cd ios && xcodegen generate
xcodebuild -project LabyrinthVault.xcodeproj -scheme LabyrinthVault \
  -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build 2>&1 \
  | grep -E "error:" | sort -u
```

This is the command to live in while the first errors come out. It compiles
against the device SDK, which Xcode already has, and skips the step that would
otherwise stop it. A device build resolves code signing *before the compiler
runs*, so without those two flags a missing team hides every compile error
behind one line about a development team, and it is easy to read that as "the
code is fine, only signing is wrong" when nothing has been checked at all.
`sort -u` collapses the same error repeated once per file that includes the
header, which otherwise makes ten problems look like ninety.

A simulator destination also needs no team and is the obvious-looking answer.
Since Xcode 26 the iOS runtime is not bundled, so on a fresh install
`-destination 'generic/platform=iOS Simulator'` spends a multi-gigabyte
download verifying a runtime before it compiles a line. Worth it when you want
to *run* the app, and needed for screenshots. Not worth it to read a list of
errors.

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

- [x] **Organization enrollment. Done.** Guideline 3.1.5(b): cryptocurrency
      wallet apps must come from a developer enrolled as an *organization*,
      not an individual. This was the long pole, since it involves a D-U-N-S
      number and takes days rather than minutes, and it covers both apps
      because they share one account.
- [ ] **BIS self-classification report** for the encryption (5D992.c mass
      market). **Written and ready in [`store/bis/`](../store/bis), four
      fields short of sendable, and it does not block this submission.**

      This entry used to say "needed before the Store", which was wrong. The
      obligation attaches to exports made *during a calendar year* and the
      report is due by 1 February of the *following* year; BIS says outright
      that no report is required for a year with no exports. So the sequence
      is ship, then file by the next 1 February, then every year after.

      [`store/bis/README.md`](../store/bis/README.md) has every field with the
      reasoning for its value, the four that need your details, and the comma
      rule that breaks most first attempts. `test/store.test.ts` holds the
      file to the twelve columns, five permitted ECCNs, two authorization
      types and forty-nine item descriptors the regulation fixes, and fails if
      any document claims the report is filed while it still has blanks in it.
- [x] **The contact address receives mail. Done.**
      `info@labyrinthwallet.com` is printed in both privacy policies and in
      SECURITY.md, which means a reviewer and a security researcher both have
      it, and mail sent to it now arrives.
- [x] **Host the privacy policy. Done, and rendered rather than copied.**
      `site/scripts/render-policies.mjs` runs as part of `npm run build` in
      `site/` and writes both documents into the built site from the markdown
      in `store/`, so the hosted page cannot drift from the versioned one:
      `store/vault/privacy-policy.md` to
      `https://labyrinthwallet.com/vault/privacy`, and the wallet's to
      `https://labyrinthwallet.com/privacy`.

      **What made this worth doing carefully.** Those URLs did not 404 before.
      `site/wrangler.jsonc` sets `not_found_handling` to
      `single-page-application`, so *every* unmatched path answers 200 with
      the marketing page. A reviewer following the privacy-policy link would
      have landed on the landing page and concluded there was no policy, and
      nothing anywhere would have reported an error. A dead link at least
      looks dead.

      `test/store.test.ts` now holds three things together: the route the
      build writes, the URL this document tells you to paste, and the file it
      is rendered from. The renderer also refuses any markdown construct it
      does not handle rather than rendering around it, because a policy that
      quietly loses a sentence is worse than a build that stopped.

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

### 7. Submission day, wallet

The same shape as the vault's list, and the differences are the point: the
wallet answers export compliance the other way, hosts its policy on its own
domain, and carries one review risk the vault does not.

**Prerequisites, once ever:**

- [x] **Organization enrollment. Done.** The same 3.1.5(b) gate as the vault
      and the same account, so doing it once did it for both.
- [x] **No BIS report for this app.** The wallet is watch-only and answers the
      encryption question `no` (see the export-compliance section above), so the
      5D992.c self-classification the vault needs does not apply here. Nothing
      to file.
- [x] **Host the privacy policy. Done.** `store/wallet/privacy-policy.md` is
      rendered into the built site at `https://labyrinthwallet.com/privacy` by
      `site/scripts/render-policies.mjs`, from the markdown rather than a copy
      of it. See the vault's entry above for why that mattered more than it
      looks: the URL used to answer 200 with the marketing page rather than
      404, so a reviewer would have seen a landing page and no error.
- [x] **The contact address receives mail. Done.**
      `info@labyrinthwallet.com` is in the policy and mail sent to it arrives.

**In App Store Connect, per the wallet app record:**

- [ ] Category: **Finance** primary, **Utilities** secondary.
- [ ] Name, subtitle, description, keywords, promotional text: paste from
      [`store/wallet/`](../store/wallet). Lengths are tested against Apple's
      limits, so the form accepts them as-is.
- [ ] **App Privacy questionnaire: "Data Not Collected."** The app has no
      analytics, no crash reporting and no account, which its four empty
      privacy-manifest lists assert and `wallet/test/` guards. The nuance to
      understand before you tick it: the wallet *connects* to a chain node and,
      for a swap, to an exchange, and those third parties see an IP address and
      addresses. That is the *user* reaching a third party they chose, not the
      developer collecting data, and the swap proxy Labyrinth runs is built to
      forward and keep nothing (no logs, and HMAC-keyed rate counters that a
      test over the Worker source enforces). So "Data Not Collected" is the
      honest and defensible answer, and the third-party exposure is disclosed in
      full in the privacy policy rather than hidden behind the checkbox.
- [ ] **Age rating:** every content question None; result 4+. No web view, no
      gambling, no user-generated content.
- [ ] **Privacy policy URL:** from the hosting step above.
- [ ] **App Review notes:** paste [`store/wallet/review-notes.md`](../store/wallet/review-notes.md)
      whole, and **attach the round-trip demo video** (see risk 1 below). The
      notes lead with the two facts that decide the review: the numbers are
      fixtures until a node is set, and the app is the online half of a
      two-device pair.
- [ ] **Export compliance** is answered in the Info.plist
      (`ITSAppUsesNonExemptEncryption: false`), so Connect does not re-ask per
      build.
- [ ] **Screenshots**, one required size class (6.9-inch iPhone). From the shot
      list: the home screen with its `DEMO DATA` chip, receive showing an
      address and its derivation path, the send review screen, the **QR
      transmit frames** (the airgap handoff, the screenshot that explains the
      product), and a swap quote with its derived payout address. Dark,
      portrait.

**The review risks that remain, named:**

1. **The signed round-trip cannot be completed on the release build.** The
   stand-in signer is compiled out of release on purpose, because it holds a
   published seed and a demo signer left in a shipping wallet is how a product
   like this fails. So a reviewer with no second device can walk everything up
   to and including the QR handoff but cannot reach the signature-verify and
   mismatch screens. This is the wallet's one material review risk and it has no
   in-app fix that is not a security regression. The mitigation is the review
   notes plus a **short screen recording of the full round-trip** (a real
   vault, and the mismatch case) attached to the submission, and an offer of a
   development build on request. Apple reviews hardware-companion apps this way
   routinely; the video is the standard answer and it should be attached, not
   held in reserve.
2. **Fixture data reads as a broken wallet.** Every number is `DEMO DATA` until
   a node is set, and an external tester who skipped the notes will believe the
   balances. Ship internal TestFlight first (it skips Beta App Review), and gate
   external testing on a node client landing.
3. **2.1 completeness.** With the stand-in controls now gated on `__DEV__`, a
   release build has no button that does nothing; the receive screen simply
   waits for a vault. If a reviewer still finds a dead end, it is a bug.

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
