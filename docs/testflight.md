# Testing the vault yourself, on the phone

Everything below is a thing to do on the device, in order, with what you
should see and what it would mean if you saw something else. It is written to
be worked through top to bottom in one sitting of about an hour.

Three of these tests can only be done on real hardware. They are the reason
this document exists rather than a simulator script, and they are marked
**DEVICE ONLY**. If you do nothing else, do those three.

## Before you start

- **Set a device passcode.** The vault refuses to create keys without one.
- **Have a stopwatch.** Test 4 is a measurement, not an observation.
- **Do not put real money anywhere near this build.** Nothing here is a
  release candidate; it is the first build that has ever run outside a
  simulator.
- Airplane mode is optional for testing and mandatory in real use. Leave the
  radios on for now so TestFlight can hand you the next build.

Write the results down as you go. A test you remember passing is not a result.

---

## 1. Launch and the self-test

Open the app.

**Expect:** a launch screen that names cryptographic checks and passes them,
then the setup walk (first run) or the passphrase screen (afterward).

**Watch for:** any check listed as FAILED. The self-test runs published test
vectors through the shipped engine, and a failure means the JavaScript core on
your phone is computing something different from the machine that built it.
That is the class of bug that produced the `TextEncoder` failure you already
hit. If it fails, photograph the screen: every check is named, and the names
are the diagnosis.

## 2. The setup walk

Six steps: the declaration, the radios, the airgap verification, the security
boundary, the passphrase, the entropy and key generation.

**Expect:** the radio step tells you the app cannot see your radio switches and
that turning them off is your job. That is deliberate and it should read that
way rather than as an app that failed to check something.

At the passphrase step, try these in order:

- A short passphrase. It should be refused with a reason, not accepted.
- A passphrase with an accent or an emoji in it. Accepted is correct.
  Remember exactly what you typed; test 4 depends on retyping it.
- The reveal control on the field. Tap SHOW, confirm the characters appear,
  tap HIDE, confirm they go. This control is new and has never run on a phone.

**Expect at the end:** KEY MATERIAL CREATED, and two levers. Take
**WRITE DOWN RECOVERY PHRASE**, not OPEN VAULT.

## 3. The recovery phrases

**Expect:** 12 Bitcoin words and 25 Monero words, blurred, revealed only while
you hold the HOLD TO REVEAL row and concealed again the moment you let go.

**Do this now, on paper, by hand.** There is no restore path inside the vault
app: erasing or losing this phone means recovering these phrases into Sparrow
or Feather, not back into this app. The words are standard BIP39 and standard
Monero, so those wallets will take them.

**Watch for:** the word count. 12 and 25. A grid that renders 11 or 24 is a
real defect and not a display quirk.

Confirm you can get back here from the vault: **SECURITY tab > KEY
MANAGEMENT**. That route is the fix in this build. In the build you have on
your phone right now it does not exist, and the phrases are viewable exactly
once, from the screen you are on. If you are still on the old build, do not
leave this screen until the words are on paper.

## 4. DEVICE ONLY: time an unlock

This is the most important test in the document and it takes ten seconds.

Background the app, reopen it, and when the passphrase screen appears type
your passphrase and start the stopwatch as you tap **UNLOCK**. Stop it when
the vault screen appears. The lever reads DERIVING KEY / ARGON2ID while it
works.

**Record the number.** Then tell me what it is.

**Why it matters:** the Argon2id parameters were chosen against a build
machine, not against an A-series phone, and they have never been measured on
one. Roughly one to three seconds is the target.

- Much under one second means the parameters are too weak and every vault
  sealed under them is cheaper to attack than intended.
- Much over five seconds means people will pick shorter passphrases to avoid
  the wait, which costs more security than the parameters buy.

Either way the fix is a parameter change, and a parameter change has to happen
**before anybody seals a vault with real keys in it**, because it does not
apply retroactively to a vault that already exists.

Do it three times and take the middle number. The first unlock after an
install is not representative.

## 5. DEVICE ONLY: the no-passcode refusal

The vault stores its sealed keys under the keychain class that requires a
device passcode. The claim is that it refuses to create a vault without one.
Nothing has ever tested that claim on hardware.

1. Erase the vault if one exists (SECURITY > KEY MANAGEMENT > ERASE VAULT,
   which takes two taps), or delete and reinstall the app.
2. Turn the device passcode **off** in iOS Settings. iOS will warn you that
   this removes Face ID and clears the keychain. On a test phone that is fine.
3. Launch the vault and try to create one.

**Expect:** a refusal that says a passcode is required, in the app's own
voice, before any key material is generated.

**Watch for:** a vault that gets created anyway, or a crash, or a generic
keychain error code. Any of those is a finding.

Turn the passcode back on afterward.

## 6. DEVICE ONLY: Face ID, and what invalidates it

On the passphrase screen there is an unticked box, **REMEMBER WITH FACE ID**.

1. Tick it, type the passphrase, unlock. The passphrase is stored only after
   the seal actually opens under it.
2. Background the app and return. **Expect:** an UNLOCK WITH FACE ID lever
   above the field, and the keyboard **not** raised. Use it. The vault should
   open without typing.
3. Cancel the Face ID prompt instead of matching. **Expect:** you are left on
   the passphrase screen, able to type. Not an error dialog, not a lockout.
4. **The invalidation test.** In iOS Settings, add a second appearance or
   reset Face ID entirely. Then return to the vault and tap UNLOCK WITH FACE
   ID.

   **Expect:** it fails, and the vault demands the typed passphrase again.

   This is the whole point of binding the keychain item to
   `.biometryCurrentSet` rather than to biometry in general. If a newly
   enrolled face opens the vault, then anyone who can compel or obtain your
   passcode can enroll their own face and walk in, and the box on that screen
   is promising something it does not deliver. **This is the single most
   important security behavior in the app that has never been verified.**
5. Turn it off: SECURITY > KEY MANAGEMENT > STOP USING FACE ID. **Expect:**
   the lever disappears from the passphrase screen and typing is required
   again. The vault itself is unchanged; it was always sealed under the same
   passphrase.

## 7. The export QR

EXPORT tab.

**Expect:** an animated QR carrying a watch-only key, and copy saying nothing
that can spend is in it.

To check that claim rather than read it: scan the QR with Sparrow Wallet on a
desktop. It should import as a watch-only wallet, show addresses, and refuse
to sign. If Sparrow offers to spend from it, stop and tell me.

## 8. The demo transaction

SIGN tab > **WALK A DEMO TRANSACTION**.

This is real cryptography against demo keys, on a transaction that cannot be
broadcast. It crosses the same read, review, approve and hold-to-sign screens
a real one does.

**Expect:**

- A DEMO badge in the status bar on **every** screen the walk crosses. If any
  screen loses the badge, that is a finding: a screen that looks like ordinary
  use during a demo is a screen that could look like a demo during real use.
- The review screen showing every output, the change explicitly checked
  against your own address, and the input values.
- The confirmation screen requiring you to scroll to the bottom before the
  lever enables. **Check the disabled lever is legible**: it should read as
  clearly disabled with the SCROLL hint visible. This is the screen you were
  stuck on, and the fix is in this build.
- Hold to sign, which takes a deliberate hold rather than a tap.
- The walk ending by wiping the demo session and asking for your passphrase
  again, with a line at the top saying why.

Run it twice: once tapping through, once reading every screen. The second time
is the one that finds copy that is wrong.

## 9. The refusals

SIGN tab, camera on, and point it at things that are not transactions.

- **A random QR code** (a website URL, a WiFi code). Expect it to be named and
  ignored, not refused dramatically.
- **A QR from the wallet app** that is not a transaction. Expect it to be
  recognized as the wrong kind and said so.
- **The vault's own export QR**, pointed back at itself. Expect a refusal or a
  clean rejection, never a signing screen.

**Expect on any refusal screen:** exactly one way out, and it does not lead
forward. There is no button that lets you sign anyway. A refusal you can click
through is not a refusal, and the transition rules in `Model/Flow.swift` are
written to make that structurally impossible. If you ever find yourself on a
signing screen after a refusal, that is the highest severity bug in the app.

## 10. The lock

- Background the app from the vault screen. Return. **Expect:** the passphrase
  screen.
- Background it from the recovery phrase screen, then open the app switcher.
  **Expect:** the switcher's snapshot is blank, not your seed words. The app
  paints over itself the moment it stops being active.
- Background it mid-scan, while the camera permission prompt is up. **Expect:**
  you are **not** kicked back to the passphrase screen. Permission prompts pass
  through the inactive state, and locking on those would wipe the session in
  the middle of a scan.

## 11. Signing something real

The end of the line, and the test that says the vault works: a PSBT from
software that has never heard of this app.

1. In Sparrow, use the watch-only key from test 7.
2. Build a payment on **testnet or signet**. Not mainnet.
3. Sparrow shows the unsigned PSBT as an animated QR. Show it to the vault.
4. The vault reads it, reviews it, signs it, and shows the signed result as its
   own animated QR.
5. Scan that back into Sparrow. **Expect:** Sparrow accepts the signature and
   the transaction is complete and broadcastable.

If that round trip works, the airgap is real and the vault does what it says.
Nothing before this point proves that, because everything before this point is
the app talking to itself.

---

## What to send back

For each numbered test: passed, failed, or not run. For test 4, the number in
seconds. For anything that failed, a photograph of the screen beats a
description of it, because every screen in this app names what it is doing.

## What this plan does not cover

- **Monero signing end to end.** The Bitcoin path can be closed against
  Sparrow; the Monero path needs the companion wallet, which has never been
  compiled, and a stagenet acceptance run. Both are open work.
- **The companion wallet at all.** Nothing in this document tests it.
- **Restoring a vault.** There is no import path. Test 5 destroys the vault to
  test the refusal, and test 3 is the only reason that is survivable.
