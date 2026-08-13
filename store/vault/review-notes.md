# Review notes: Labyrinth Vault

**This app has no network access and does nothing on its own. That is the
product, not a bug, and it is the thing most likely to look like one.**

## What it does

It is an airgapped signing device for Bitcoin and Monero, meant to run on a
second phone with its radios off. It generates keys on device, stores them
encrypted, and signs transactions that arrive as QR codes from a separate
companion app. There is no networking layer in the target at all.

## Before you start

The review device needs a **device passcode set**. The vault stores its sealed
keys under the keychain's passcode-bound class and will refuse to create a
vault on a device without one, with a message saying exactly that. This is
deliberate, not a bug.

## Full walkthrough, without a second device

1. **Launch.** The app runs a self-test against published cryptographic
   vectors before anything else. Nothing runs until it passes; if it ever
   fails you will see every check by name and a single retry action.
2. **Setup.** The app walks you through the airgap steps (on a review device
   you can tap through the radio checklist; the app is explicit that the
   radios are yours to switch, not something it can see). Choose a
   passphrase. Key generation is real: fresh CSPRNG entropy, sealed with
   Argon2id + XChaCha20-Poly1305, stored in the keychain.
3. **Recovery.** The SECURITY tab > KEY MANAGEMENT shows the two recovery
   phrases (12 Bitcoin words, 25 Monero words) behind a hold-to-reveal.
4. **Export.** The Export tab animates a QR carrying a watch-only public key.
   Nothing that can spend is in it.
5. **Sign, with no companion:** open the SIGN tab and tap
   **WALK A DEMO TRANSACTION**. This feeds a built-in, deterministic,
   unbroadcastable transaction through the exact read > review > approve >
   hold-to-sign path a real one takes. Every screen it crosses shows a DEMO
   badge, and the walk ends by wiping the demo session and asking for your
   passphrase again - by design, so demo keys and real keys can never mingle.
6. **Refusals:** point the scanner at any random QR code. Unrecognized codes
   are named or ignored; recognized-but-unsafe payloads get a refusal screen
   with exactly one way out. The refusal is the security model working.
7. **Lock:** background the app. The session is wiped and the passphrase
   screen gates the return.

To exercise signing against real third-party software: any desktop wallet
that exports a PSBT as an animated QR will do; Sparrow Wallet is the one we
test against. Scan the exported watch-only key into it, build a payment, and
show the QR to this app.

## Why the camera permission

The camera is the only input. It reads QR codes from the companion device.
Nothing is captured, stored or transmitted, because there is nothing to
transmit with.

## Unlocking, and the Face ID box

The vault is opened with a passphrase, which is stretched into the decryption
key. There is a deliberate pause while that runs. It is Argon2id, and the
screen names it rather than showing a spinner.

Face ID is a shortcut past the typing and is off unless the person ticks the
box. Ticking it stores the passphrase in a keychain item the Secure Enclave
releases only against a live match, bound to the current biometric enrollment
and to that device. Nothing is stored anywhere else, and the vault is sealed
under the same passphrase either way. On a review device you can ignore the
box and type the passphrase.

## Encryption

Yes, and answered as such in App Store Connect rather than in the Info.plist.
The app encrypts the user's seed at rest with Argon2id and XChaCha20-Poly1305.
It qualifies as mass market under ECCN 5D992.c.

## Source

The application is open source and every security claim in the description is
a test in the repository.
