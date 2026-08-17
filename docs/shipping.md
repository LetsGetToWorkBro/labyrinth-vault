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

App Store Connect asks whether the app uses non-exempt encryption. The wallet
answers in its Info.plist; the vault answers in App Store Connect, per build,
for the reason set out below. They answer differently, and that is correct
rather than an inconsistency.

**The wallet used to answer no, and now answers yes.** The old answer was
correct for the app it described: watch only, holding an extended public key, a
Monero view key, addresses and balances, with no secret in it to protect and
nothing in it encrypting data for confidentiality.

That app no longer exists. The wallet generates seeds, stores one under the
device keychain, and signs with it, which is the same category of product the
vault is even though the mechanism differs: the vault protects its seed with
its own Argon2id and XChaCha20-Poly1305, the wallet leans on the platform. The
distinction that matters to BIS is what the item does rather than whose code
does it, and an application whose function includes holding a user's key
material at rest is a controlled encryption item.

So the wallet joins the vault under **5D992.c** and is listed on the same
self-classification report. The two apps now answer the same way for related
but not identical reasons, and the sentence above about the difference being
the point no longer applies.

*Both halves of that change have to move together.* The manifest key and this
paragraph were flipped in the same commit as the first build that stores a
seed, deliberately and not in a later cleanup, because the window between "the
app holds keys" and "the form says it does not" is exactly the window in which
a false statement gets filed.

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
   there. Apple asks about it directly, as the last of three questions in the
   App Encryption Documentation wizard below.

### The answer moved to App Store Connect, and the answer there is YES

**Answer YES to "Does your app use encryption?" on every upload.** That is the
whole instruction, and it is here rather than in `ios/project.yml` because
that is where it had to go.

The manifest used to carry `ITSAppUsesNonExemptEncryption: true`, which is the
truthful answer and which stopped Apple asking on each upload. It also made
every upload fail with the error below, four times. Answering yes puts the app
in the category that owes Apple documentation, and validation then compares
the plist against whatever the app record holds; completing the App Encryption
Documentation wizard, which concluded that no upload was required, did not
settle it.

So the key is gone and Apple asks per build instead, with no plist value left
to mismatch. This is a retreat rather than a fix. An answer in a manifest is
version controlled and one in a form is not, and `test/shipping.test.ts` can
now only check that the key stayed out and that this paragraph still says YES.
Put it back the moment Apple's side is understood.

**This now applies to the wallet too, and the mistake to avoid is obvious in
advance.** The wallet's honest answer became yes the day it started storing a
seed. The tempting edit is to set `ITSAppUsesNonExemptEncryption: true` in
`wallet/app.json`, which is truthful and which would walk straight into the
same four failed uploads described above. So the key was **removed** from the
wallet's manifest rather than flipped, and the wallet answers YES in App Store
Connect per build, exactly as the vault does. Removing a key that said `false`
and adding one that says `true` are very different edits with the same
intention, and only one of them uploads.

### Why the manifest-first approach could not have worked, and how to undo the retreat

App Store Connect's own per-build dialog says it, in a yellow box under the
question:

> To bypass setting up export compliance in App Store Connect, you can specify
> your use of encryption directly in the information property list (Info.plist)
> in your Xcode project. If you need to provide documentation, **Apple will
> provide you with a key value to add to the Info.plist.**

That key value is `ITSEncryptionExportComplianceCode`, and Apple issues it
only after the compliance flow is completed on their side. So the order runs
the other way from what putting the answer in the manifest assumed: the form
comes first, the code comes back, and *then* the manifest can carry both keys
and stop being asked.

Which makes the original error literal and correct rather than mysterious. The
app record expected a code, the plist had none, and no edit to this repository
could have supplied one, because the value did not exist yet.

**To undo the retreat once Apple issues a code**: put both keys back in
`ios/project.yml`, `ITSAppUsesNonExemptEncryption: true` and
`ITSEncryptionExportComplianceCode` set to the issued value, and restore the
guard in `test/shipping.test.ts` that checks the answer is `true`. That is
strictly better than where this started: a real code in a version-controlled
manifest, rather than an empty string that answered the question wrongly.

**The per-build question, until then.** Answer with the second option,
"standard encryption algorithms instead of, or in addition to, using or
accessing the encryption within Apple's operating system". Everything the
vault implements is a published standard and all of it is in the app's own
bundle rather than the operating system's. Not "both", because nothing here is
proprietary; not "none", because the app plainly implements encryption.

### Apple wants its own documentation, and it wants it before the Store

This is separate from the BIS report and lands earlier, which the runbook did
not say and should have. Validation refuses the upload until it is done:

    Invalid Export Compliance Code. The export compliance key value []
    in the app's Info.plist doesn't match the key value of the app's
    export compliance documentation.

That is not a misconfiguration to argue away. `ITSAppUsesNonExemptEncryption:
true` puts the app in the category that owes Apple documentation, and the
trigger is stated on the App Store Connect page itself: documentation is
required for "standard encryption algorithms instead of, or in addition to,
using or accessing the encryption within Apple's operating system". The vault
ships Argon2id and XChaCha20-Poly1305 in its JavaScript bundle rather than
calling CryptoKit, so it is squarely that case.

The wizard is at App Store Connect > the app > App Information > App
Encryption Documentation, and it is three questions:

**1. App purpose**, 300 characters. Worded to match
`store/vault/review-notes.md`, so a reviewer reading both meets one story:

> An airgapped signing device for Bitcoin and Monero, meant to run on a second
> phone with its radios off. It generates keys on device and encrypts them at
> rest with Argon2id and XChaCha20-Poly1305. Transactions arrive and leave as
> QR codes. There is no networking code in the app.

**2. Which algorithms.** Two checkboxes; tick the second only.

Everything the vault implements is a published standard: XChaCha20-Poly1305
(RFC 8439 plus the CFRG nonce extension), Argon2id (RFC 9106), SHA-2 and
Keccak (FIPS 180-4, FIPS 202), Ed25519 (RFC 8032), secp256k1, PBKDF2 (RFC
8018). None is proprietary, and all of it is in the app's own bundle rather
than the operating system's, which is the second box word for word.

**Do not tick the first box defensively.** "Proprietary or not accepted as
standard" is the answer that leads toward CCATS, and it is not true here.
Monero's CLSAG and Bulletproofs+ are in the app and are not IETF standards,
but neither is an encryption algorithm: one is a ring signature and the other
a range proof. The only thing providing confidentiality is
XChaCha20-Poly1305.

**3. Distribution in France.** A decision rather than a lookup. France
requires a declaration to ANSSI for supplying cryptographic means that provide
confidentiality, which this does. Answering yes states that you have complied.
Answering no requires actually excluding France in Pricing and Availability,
because saying no and shipping there is a misstatement on the same form.

Until the ANSSI declaration is filed, no is the truthful answer and it is
reversible. One country is a cheap price for not making a declaration you
cannot back.

**Omit `ITSEncryptionExportComplianceCode` entirely** unless Apple issues one.
It applies to apps that went through CCATS, and this one does not.

This used to say "leave it empty", and the key was in `project.yml` set to
`""`, which is a different thing and a worse one. An empty string is an
answer rather than an absence: App Store Connect validates the value it
finds, so a key present with nothing in it turns "we have nothing to declare"
into a rejected upload. The key is gone from the manifest now, with the
reasoning next to where it was.

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

**Then the app record in App Store Connect**, which asks for one more
identifier the App ID page did not: a **SKU**. Use the bundle identifier
again, `vision.labyrinth.vault` and `vision.labyrinth.wallet`.

It is private and never shown to anybody using the app. It has to be unique
within the account, **it cannot be changed once the record exists**, and it is
the column the sales and financial reports are keyed by, so it wants to be
something still recognizable in a spreadsheet in two years. The bundle
identifier is already unique, already fixed in `ios/project.yml` and
`wallet/app.json`, and reusing it means there is no second name to keep track
of. Letters, numbers, hyphens, periods and underscores; no spaces.

**Which answers on that form you are stuck with**, because the page does not
say and the difference is the only reason to slow down on any of it:

| Field | Changeable afterwards |
| --- | --- |
| User access | any time, and it only governs which other team members see the app |
| App name | between versions |
| Primary language | between versions |
| SKU | **never** |
| Bundle ID | **never**, once a version has been submitted |

So the two worth reading twice are the SKU and the bundle identifier, and both
of those are already decided by the repository. Everything else on the page is
recoverable.

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
wallet reads real chains only after a tester sets a node, and until then every
number is a labeled fixture. An external tester who skips the notes will
believe the fixture or stall at the empty Nodes screen; internal testers can
be walked through choosing a node and pairing a vault, which is the setup the
product actually assumes.

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
- [ ] **The wallet is on the BIS report now.** It used to be exempt here, on
      the grounds that it was watch-only with no secret to protect. It stores a
      seed as of the backup and restore screens, so it is a 5D992.c mass market
      item on the same footing as the vault and is listed as a second row in
      [`store/bis/`](../store/bis). No separate filing and no second email: one
      report lists both products. The same four fields still need your details,
      and the same timing applies, which is that nothing is due until 1 February
      after a calendar year in which something was actually exported.
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
- [ ] **Export compliance: answer YES**, per build, in Connect. Same as the
      vault and for a related reason: this app stores a seed now. There is no
      plist key any more, so Connect will ask on every upload. Do not add
      `ITSAppUsesNonExemptEncryption: true` to make it stop asking; that is the
      edit that failed four uploads in a row on the vault, and the
      export-compliance section above is the account of it.
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
   balances. Ship internal TestFlight first (it skips Beta App Review), and
   open external testing with instructions that lead with the Nodes screen,
   since setting one is the moment the product becomes real.
3. **2.1 completeness.** With the stand-in controls now gated on `__DEV__`, a
   release build has no button that does nothing; the receive screen simply
   waits for a vault. If a reviewer still finds a dead end, it is a bug.

## What is not ready, honestly

**The wallet has a chain behind it now, and three named gates in front of
real money.** With a node set, Bitcoin discovery, coins, history, fees and
broadcast are live, and the Monero view-key scan proves every found amount
against the chain and subtracts spends after a key image round trip. What
still stands between a tester and their own funds: the fixture until a node
is chosen (`DEMO DATA`, by design, since there is no default node); the
Monero mainnet broadcast gate, which refuses until a live stagenet acceptance
is recorded in `wallet/src/core/moneroreadiness.ts`; and the swap, which
serves labeled fixture quotes until the proxy Worker is deployed and its
address set in `wallet/src/net/swapproxy.ts`. That one string also turns on
prices: the Worker serves every client the same cached answer from
`worker/src/prices.ts`, so no price service ever sees a phone, and until it
is deployed live balances are shown in coin rather than at a made-up rate.
The external-testing gate is no longer a missing node client; it is
recording the stagenet acceptance and deploying the Worker.

**The vault compiles and launches; real hardware is the open gate.** The
state table at the top is the record: built in Xcode, launched in a
Simulator, self-test green, and two launch-only bugs found and fixed by
doing it. What a Simulator cannot answer is Argon2id timing on a phone's CPU
and the passcode-bound keychain class, which is exactly the section above
titled "why the next run is on metal". On Linux the model layer still
compiles and passes its tests through `./scripts/install-swift.sh`; the
SwiftUI layer still needs a Mac, as it always will.

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
