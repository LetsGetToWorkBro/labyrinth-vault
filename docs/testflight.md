# Testing the vault yourself, on the phone

Everything below is a thing to do on the device, in order, with what you
should see and what it would mean if you saw something else. It is written to
be worked through top to bottom, part one in one sitting of about an hour.

Three of these tests can only be done on real hardware. They are the reason
this document exists rather than a simulator script, and they are marked
**DEVICE ONLY**. If you do nothing else, do those three.

It is in two parts. **Part one** is the vault on its own, signing Bitcoin, and
is the hour. **Part two** is Monero and the companion wallet, which need a
second device and a stagenet faucet, and which no phone has ever run. Part two
contains the two tests where a failure would cost somebody money rather than
time: test 12, whether the seed phrase restores in another wallet, and test 15,
whether a real wallet imports a key-image export.

## Before you start

- **Start the stagenet faucet request before anything else.** It is the only
  input with a queue in front of it, and part two cannot begin without it. You
  do not need the app built to ask. See below.
- **Set a device passcode.** The vault refuses to create keys without one.
- **Have a stopwatch.** Test 4 is a measurement, not an observation.
- **Do not put real money anywhere near this build.** Nothing here is a
  release candidate; it is the first build that has ever run outside a
  simulator.
- Airplane mode is optional for testing and mandatory in real use. Leave the
  radios on for now so TestFlight can hand you the next build.

Write the results down as you go. A test you remember passing is not a result.

### The stagenet faucet request

A faucet wants an address, an address wants a wallet, and the vault that makes
wallets is the thing you have not built yet. That ordering is the reason the
faucet step used to sit behind an Xcode build for no good reason, so there is
now a script for it:

    cd wallet
    LABYRINTH_XMR_NODE=<a stagenet node> npx tsx scripts/stagenet-wallet.ts

It makes a stagenet wallet from the same `walletFromSeed` the app uses, prints
the address on stdout and the seed, view key, twenty-five words and birth
height on stderr. The node is optional and worth passing: it records the chain
height at the moment of creation, which is where a later scan should start, and
without it every scan starts from block zero.

Paste the address into a stagenet faucet and keep the output. Then build while
you wait.

Two things about that wallet. It is a throwaway that exists to hold test coins,
which is why a script is allowed to print its keys to a terminal and why it
refuses to run on mainnet at all. And the coins land in *it*, not in the vault
you have not made yet, so once the vault exists there are two ways to get them
where test 16 needs them: ask the faucet again with the vault's own stagenet
address, or forward them with `scripts/stagenet-send.ts`. The forward is worth
preferring. It is the same `executeMoneroSend` loop test 16 exercises, with the
signer in process instead of across the airgap, so if it succeeds you already
have the transaction id that lifts `MONERO_SEND_BROADCAST_VERIFIED` and you
have it before touching a phone.

Faucet and node addresses are not listed here on purpose. Both are volunteer
infrastructure that moves, and a stale URL in a document reads as a broken
build rather than a dead host. Search for a current one, and check that a node
answers `/get_info` before relying on it.

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

**Record the number.** Then tell me what it is. It is the single most useful
thing you can send back from this whole session.

**Do not assume it has hung.** Give it three minutes before you decide
anything is wrong. The expectation is genuinely bad: the parameters are
`t=3, m=64 MiB`, fixed, chosen on a build machine, and on the phone they run in
an interpreter, because JavaScriptCore inside a third-party app gets no JIT.
Measured against that same code with the compiler switched off, one derivation
costs 57 seconds on a *server* CPU. See `docs/native-primitives.md`. A phone
being slower, an unlock of a minute or more would not be a surprise.

**What the number decides:**

- **Tens of seconds**: expected, and it means the key derivation has to move
  from JavaScript into native code. That work is already specified step by
  step in `docs/native-primitives.md`, and this measurement is the gate it
  waits on.
- **A few seconds**: JavaScriptCore's interpreter is far better than V8's, the
  port drops down the list, and we tune parameters instead.
- **Under a second**: something is wrong. Nothing should be that fast, and the
  first thing to check is whether the derivation ran at all.

Whatever it says, the fix has to land **before anybody seals a vault with real
keys in it**. Parameters live in the sealed blob's header, so changing them
later does not touch a vault that already exists: that vault keeps its slow
unlock forever, and the only way out of it is to erase and re-create from the
recovery phrases.

Do it three times and take the middle number. The first unlock after an
install is not representative. Time the setup step too, if you are creating a
fresh vault: sealing runs the same derivation once.

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

# Part two: Monero, and the companion

Everything above was written when the vault signed Bitcoin and nothing else,
and it ends by saying the Monero path and the companion wallet are untested.
Both have been built since. This half is the plan for them, and it is longer
than part one for a reason worth stating plainly: **none of it has ever run on
a phone.** Every screen below is a screen whose first contact with real
hardware is you.

Part one can be done with the vault alone. Part two needs the companion wallet
too, which means either two phones or a phone and a simulator. One of each is
fine and is arguably better, because a simulator can be pointed at a stagenet
node while the vault stays in airplane mode, which is the arrangement real use
has.

## 12. The Monero half of the setup walk

Set up a Monero wallet on the vault, or find it if setup already made one.

**Expect:** twenty-five words, and an address beginning `4` for mainnet or `5`
for stagenet.

**Check the words rather than admiring them.** Type them into Feather or Cake
as a restore, on the same network, and confirm the address that comes out is
character-for-character the one the vault showed. This is the single most
important check in this document. The words are the backup; a backup that
restores to a different wallet is not a backup, and there is no way to discover
that later except by needing it.

That check is anchored in the suite already: `test/fixtures/monero-address.json`
holds what Monero's own `ElectrumWords::bytes_to_words` and
`get_account_address_as_str` produce for the same secrets, across all three
networks. What it cannot do is prove the phone runs the same code as the test
machine, which is what you are doing here.

## 13. The launch self-test, again, for the native seam

Back to test 1's launch screen, and read the check names this time.

**Expect:** the Keccak, ed25519 base point and address round-trip checks, all
passing.

**Watch for:** anything about CryptoNight. That is thirty-four files of
Monero's C compiled into the app rather than JavaScript, and it is the only
part of the engine that is not the bundle. It is what encrypts a key-image
export so other wallets can read it. If the app reports it absent, test 15's
MONERO FILE option will be missing and that is the explanation, not a bug in
the screen.

## 14. A Monero file the vault can read

The vault reads one of Monero's own file formats: `unsigned_monero_tx`, the
file `monero-wallet-cli` writes with `--do-not-relay`. It reads it and **will
not sign it**, deliberately, and this test is about whether the screen says
that in a way somebody believes.

Make one in `monero-wallet-cli` on stagenet, or take one from anywhere, and get
it to the vault. Two routes, both worth trying:

- **From the companion:** its MONERO FILE screen, which opens the Files app,
  reads the file, and animates it over the airgap.
- **From a browser:** the tools site has a page that does the same thing, if
  you have it running.

**Expect:** a screen headed WHAT THIS FILE / SAYS IT WILL DO, with every payee,
the amounts, the fee, and a caveat panel **above** the figures rather than
under them. One lever, reading DONE.

**Watch for:** any green. `Ink.verified` is deliberately absent from this
screen: the numbers are the sending wallet's account of its own transaction,
not something this vault has verified, and a green tick would say otherwise.
Also watch for a signing lever. There is not supposed to be one anywhere on
this screen, and finding one is a serious finding rather than a missing
feature.

**Then show it a file the vault cannot open**: a `signed_monero_tx`, or a
key-image export. **Expect:** THE VAULT / COULD NOT / OPEN THIS, and a sentence
naming which of Monero's six formats it is. Being told "that is a signed
transaction set, which this vault does not read" is the point; "not a
transaction" would send somebody off to debug a file that was never wrong.

## 15. Key images, both ways off the device

KEY IMAGES on the vault. This is the one computation a watching wallet cannot
do, and there are two wires out.

**Expect:** a picker with LABYRINTH and MONERO FILE.

- **LABYRINTH** is this project's own reply, for the companion.
- **MONERO FILE** is the file Cake, Feather and `monero-wallet-cli` import.
  **It only appears if CryptoNight is installed** (test 13). If the picker
  shows one option, that is why.

Do both.

For MONERO FILE, the file has to leave the phone and land in another wallet.
Animate it to the companion, save it, and import it into a real Feather or Cake
watching the same account. **Expect:** the import succeeds and the wallet's
balance changes from "everything ever received" to "what is actually left".

That import is the most externally-checkable thing in the whole Monero path,
and it is worth doing carefully. Monero's own `wallet2::import_key_images` has
already accepted a file this code wrote, which is what
`test/fixtures/monero-import-key-images.json` records. But `wallet2` is the
library, not the application. **No real Cake or Feather has ever imported one of these.**
You would be the first.

**If it fails:** the error will be short and unhelpful, probably "signature
check failed". That message means the records were paired with the wrong
outputs, which is a positional problem rather than a cryptographic one.
Photograph it and say which wallet and which version.

## 16. A Monero spend, across the airgap

The companion builds it, the vault signs it, the companion broadcasts it.
**Stagenet.** The wallet will refuse mainnet by itself and you should not talk
it out of that.

1. Pair the companion with the vault: its VAULT screen, two steps done by hand,
   and the vault's export QR.
2. Fund the stagenet address from a faucet, and let the companion scan until it
   sees it.
3. Import key images (test 15, the LABYRINTH wire), so the companion knows what
   is still unspent rather than only what arrived.
4. Build a payment on the companion. Show the unsigned set to the vault.
5. **On the vault, read the review screen properly.** Every payee, the fee, the
   change checked against your own address, and the ring under a PRIVACY
   heading. The ring is there because decoy choice cannot move money and
   should not be presented as though it could.
6. Hold to sign. **Expect:** frames headed NOT BROADCAST.
7. Scan them back. The companion checks the fee and the key images against what
   you approved before it will send anything.

**Expect at the end:** a transaction id, and the payment visible on a stagenet
explorer.

**This is the test that lifts the gate.** `MONERO_SEND_BROADCAST_VERIFIED` in
`wallet/src/core/moneroreadiness.ts` is `false`, and until a real node accepts a
transaction this code built, the wallet refuses to broadcast a Monero spend
with real value on mainnet. Send back the transaction id and the node that took
it; those two facts, and nothing else, are what flip that constant.

If you would rather do it without the QR round trip,
`wallet/scripts/stagenet-send.ts` drives the identical loop with the signer in
process. It finds its own coins now; it wants a seed, a node, a destination, an
amount and roughly where to start scanning.

## 17. Try to make the wallet broadcast on mainnet

Switch the companion to mainnet and try to send Monero.

**Expect:** a refusal saying the build can construct and sign a Monero spend but
has never had one accepted by a live node, so it will not broadcast one with
real value.

**Watch for:** any way through it. This is a source constant rather than a
setting, precisely so that there is no screen anywhere that turns it off. If
you find one, that is the highest severity bug in the companion.

## 18. The Bitcoin wires the plan never covered

Three of these are newer than part one.

- **DESCRIPTOR** on the export screen. An output descriptor, which is a string
  rather than a QR format, so it can be pasted anywhere. Paste it into Electrum
  and expect a watch-only wallet with the right addresses. Electrum reads no
  BC-UR at all, so this and the zpub are its only routes in.
- **`ur:psbt` against Cake.** Cake reads `ur:psbt` and not `ur:crypto-psbt`,
  which is the opposite of Sparrow. Both are offered; check the right one
  reaches the right wallet.
- **BBQr against a Coldcard Q**, if you have one. Coinkite's own joiner has
  reassembled our frames in the test suite; a real camera has not.

## 19. Two-layer storage, across an update

Only doable if you have an older build installed.

Install a build from before the two-layer storage change, make a wallet, then
update to this one. **Expect:** the wallet still opens with the same passphrase
and the same address. A migration that quietly makes a new wallet is
indistinguishable from a working one until somebody looks for money that is no
longer there.

## 20. The settings audit

SETTINGS on the vault.

**Expect:** a screen that says what this build is and what it is not, without
marketing. Read it as somebody who has not been in this repository. Anything on
it that overstates what has been tested is a bug in the copy, and copy that
overstates on a security screen is a real defect rather than a nitpick.

## 21. The companion's own screens

Nothing above exercises the companion except as the vault's other half. It is
an app in its own right and these are the parts of it a person actually lives
in.

- **Onboarding.** Run it on a phone that has never had it. Expect it to say
  what this wallet is and is not, and to reach a usable state without a vault.
- **Activity.** After test 16, expect the spend to appear, and expect the
  Monero balance to be the honest one: what arrived **minus** what the key
  images say is gone, rather than everything ever received. Before key images
  are imported it cannot know that, and it is supposed to say so rather than
  show a number that looks like a balance.
- **Asset.** Bitcoin and Monero side by side. Check the Monero figure carries
  the same caveat as above.
- **Nodes.** Point it at a node that is syncing, and at one that is not there
  at all. Expect two different sentences. "Could not connect" for a node that
  is down and a height for one that is behind are different facts and a wallet
  that renders both as an error is a wallet that sends somebody to the wrong
  problem.

- **The status bar, on every screen.** The clock, the signal bars and the
  battery, at the top of a near-black screen. They should be light. This key
  was wrong until now and React Native warned about it on every launch, so this
  is the first build where the setting has ever been right. If they are dark
  and hard to read, say so: it is one line and it goes back.
- **Coin picker.** From the swap screen, tap the coin on either side. The
  sending side should offer only what this wallet holds; the receiving side
  should offer everything, with a search field. Type "base" and expect only
  coins on Base. **Every row must name its chain.** A row reading just "USDC"
  is the defect: two chains would read alike, and picking the wrong one sends
  money somewhere nobody can retrieve it from.

- **Swap deposit.** Start a swap from a coin this wallet does *not* watch, say
  USDC on Base. Expect a deposit screen with the exact amount, a QR, and the
  address set in groups of four with alternating contrast. Check the chain is
  named in a warning above it. Then start one from Bitcoin or Monero and expect
  the same screen plus a PAY FROM THIS WALLET lever. **Do not send anything**;
  this is a reading test, and the order can be abandoned.

- **Accounts.** The list that replaced "is this app paired". On a phone with
  nothing set up, expect no balance anywhere: no zeroes, no fixture, a sentence
  saying no accounts yet and two ways out of it. **A large $0.00 would be the
  defect**, because it reads as money that has gone rather than as a wallet
  nobody has set up, and those two need to look completely different.

  Then pair a vault and make a wallet on the phone, so both kinds are on screen
  at once. Expect two rows: the vault first, saying SIGNS ON YOUR VAULT, and the
  phone saying SIGNS ON THIS PHONE. **That difference is the test.** A phone
  holding a seed for one wallet must never present the vault's account as
  something it can sign for, and these two lines are where a person sees that.

- **Signing on the phone.** Only possible once a wallet made here holds coins,
  so this comes after the restore test and after funding it. Compose a payment
  from the account that signs here and read the review screen: it must say the
  keys are on this phone and the button must say SIGN ON THIS PHONE, not SEND
  TO VAULT. Expect a Face ID prompt, then the ordinary READY screen with the
  transaction checked and not yet broadcast.

  **The test that matters is the negative one.** With a vault paired as well,
  compose a payment from the *vault's* account on the same phone. The review
  screen must say the transaction is not signed and offer SEND TO VAULT. A
  phone holding a seed for one wallet must never offer to sign for the other,
  and if SIGN ON THIS PHONE ever appears there, stop and report it: that is the
  airgap failing, and it is the most serious defect this app could have.

  **Watch for:** a second Face ID prompt for one payment, or none at all. Also
  cancel the prompt deliberately and expect a sentence saying nothing was
  signed and the payment is still there, rather than a dead screen.

- **Recovery words.** SECURITY, then MAKE A WALLET. This is the companion
  holding a spending seed of its own, so read the screen before touching
  anything: it should say the words are the only copy not on the phone, and it
  should warn against screenshotting them, which the vault's equivalent does
  not need to say. Expect 25 Monero words and 12 Bitcoin words, numbered,
  concealed as rows of dashes until you hold HOLD TO REVEAL, and concealed
  again the moment you lift your finger.

  **Try to finish without revealing them.** I HAVE WRITTEN THEM DOWN should be
  dead until the words have actually been on screen. That is the one rule this
  screen exists to enforce, and a build where the button works immediately is a
  build that can store a seed nobody has written down.

  **Watch for:** a word you can select, or a Copy item appearing on a long
  press. Neither should be possible. Also watch the count: 25 and 12. A grid
  rendering 24 is the same defect test 3 watches for on the vault, and it is
  silent until somebody needs the backup.

- **Restore from words.** This is the second test in this plan where a failure
  costs money rather than time, and it is the other direction of test 12.

  Write down the words from the step above, forget the wallet, and type them
  back in on SECURITY, then RESTORE FROM WORDS. One field, no picker asking
  which chain: it should work that out from the count. Expect the same Monero
  address you saw before.

  **Then do the part that actually proves something.** Type those same 25 words
  into Feather or Cake and check the address matches. Our own software agreeing
  with itself is not evidence; another implementation reaching the same address
  is. Do the same for the 12 Bitcoin words in any BIP84 wallet.

  **Watch for:** a phrase with one word deliberately mistyped being accepted, or
  quietly corrected. It must fail, and the refusal should name the count it
  found. Paste 24 words and expect a sentence saying it cannot tell whether that
  is a Bitcoin phrase or a Monero phrase missing one, because that is genuinely
  ambiguous and guessing sends somebody to check the wrong list.

  **Watch for, hardest:** restoring a Monero phrase onto a phone that already
  holds a Bitcoin one must leave the Bitcoin one alone. The screen says so
  before you tap. If the Bitcoin wallet is gone afterward, that is a wipe
  wearing the word restore, and it is the worst bug this screen could have.

**Swap and its status screen are deliberately out of scope here.** They talk to
third-party exchanges over the network, which is a different trust question
from anything else in this document, and mixing it into an airgap test plan
would blur the thing the plan exists to establish.

---

## What to send back

For each numbered test: passed, failed, or not run. For test 4, the number in
seconds. For test 16, the transaction id and the node. For anything that
failed, a photograph of the screen beats a description of it, because every
screen in this app names what it is doing.

Part one is about an hour. Part two is longer, needs a faucet and a second
device, and can be done across several sittings; tests 12 and 15 are the two
worth doing first if you only have a little time, because they are the two
where a failure would mean somebody loses money rather than being inconvenienced.

## What this plan still does not cover

- **Restoring a vault.** There is no import path. Test 5 destroys the vault to
  test the refusal, and test 3 is the only reason that is survivable.
- **A second person.** Every test here is done by somebody who knows what the
  screen is supposed to say. The first time somebody reads these screens
  without that, they will find copy this document cannot.
- **Anything on Android.** The companion is React Native and could run there;
  nobody has tried.
