# Review notes: Labyrinth Wallet

Two facts decide this review, so they lead.

**1. With no node configured this build shows fixture data, and every screen
that shows a number labels it.** A reviewer who assumes the balances are real
will reasonably conclude the app is not doing what it says. They are marked
`DEMO DATA` on screen. Set a Bitcoin node on the Nodes screen and it reads a
real chain; there is deliberately no default node, and the Nodes screen
explains why (a public node learns every address in the account) and presents
running your own as the ordinary choice.

**2. This is the online half of a two-device wallet, and the second device
signs.** The whole flow up to the airgap handoff runs on this phone alone. You
compose a payment, review it, and watch it become the animated QR codes you
hold up to your vault's camera. That handoff is the app's defining feature and
it is fully reviewable here. What this phone cannot do by itself is produce the
*signed* result, because signing happens on the separate airgapped vault. See
"exercising the round-trip" below for how to review the screens after the
handoff without a second device.

## What it does

It watches Bitcoin and Monero using public keys only, builds unsigned
transactions, displays them as QR codes for an airgapped signing device on a
second phone, reads the signed result back through the camera, verifies it
against what was approved, and broadcasts. It has never seen a private key and
has no screen that would accept one.

## Exercising it without a second device

Everything up to the handoff needs nothing but this app:

1. **Home** shows balances, marked `DEMO DATA` until you set a node.
2. **Receive** derives and displays a real address with its derivation path.
3. **Send** walks compose → review → **transmit**, ending on the animated QR
   frames a vault would scan. This is the airgap handoff, and it is the screen
   worth seeing.
4. **Swap** quotes from a fixture (marked `DEMO DATA`, no relay configured in
   this build) and shows the payout address it derived for a coin you own.

**The screens after the handoff need a signer.** Those are the screen where a
signature arrives, the check of it against what was approved, and the deliberate
*mismatch* state. In a development build a clearly labeled `STAND-IN VAULT`
control appears on the receive-signature screen. It signs with the seed phrase
published in the BIP84 specification, which is public, empty, controls nothing,
and is the key every wallet's test suite uses, purely so those screens can be
walked rather than imagined.

In the release build you are testing, that stand-in is **compiled out**: the
flag guarding it is `__DEV__`, which is false in a release bundle, so the signer
is not present and its controls do not render. The send flow correctly stops at
the QR handoff, which is the honest thing to show when no vault is paired. To
review the post-handoff screens, a short screen-recording of the full
round-trip (real vault, and the mismatch case) is attached to this submission;
we are glad to provide a development build on request.

## Monero

Monero can reach a node and broadcast through it. Scanning for received outputs
is not finished, so a Monero balance is labeled *not scanned* rather than shown
as a misleading zero. Monero mainnet broadcast is gated behind a recorded live
acceptance and refuses until then; stagenet and testnet are open.

## Why the camera permission

The camera reads the signed transaction back from the vault. It is the only
channel between the two devices. Frames are processed on device and discarded.

## Encryption

The app is watch-only. It stores no secret and encrypts nothing at rest; its
only cryptography is address derivation and signature verification. Its
Info.plist answers the export-compliance question `no` for that reason. Full
detail is in the privacy policy, hosted at `labyrinthwallet.com/privacy` and
versioned in the repository beside this file.
