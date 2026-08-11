# Review notes: Labyrinth Vault

**This app has no network access and does nothing on its own. That is the
product, not a bug, and it is the thing most likely to look like one.**

## What it does

It is an airgapped signing device for Bitcoin and Monero, meant to run on a
second phone with its radios off. It generates keys, stores them encrypted, and
signs transactions that arrive as QR codes from a separate companion app. There
is no networking layer in the target at all.

## How to exercise it without a second device

1. Launch. It runs a self-test against published cryptographic vectors and
   shows the result. Nothing else runs until it passes.
2. Create a vault. Choose a passphrase; it will show you two recovery phrases,
   one for each chain.
3. Open the export screen. It animates a QR code carrying a watch-only key.
   Nothing that can spend is in it.
4. Open the scanner and point it at anything. Unrecognized codes are refused
   with a reason rather than ignored.

To exercise signing you need a transaction. Any desktop wallet that exports a
PSBT as an animated QR code will do; Sparrow Wallet is the one we test against.
Scan the exported watch-only key into it, build a payment, and show the QR to
this app.

## Why the camera permission

The camera is the only input. It reads QR codes from the companion device.
Nothing is captured, stored or transmitted, because there is nothing to
transmit with.

## Encryption

Yes, and declared as such. The app encrypts the user's seed at rest with
Argon2id and XChaCha20-Poly1305. It qualifies as mass market under ECCN
5D992.c; the self-classification report is filed.

## Source

The application is open source and every security claim in the description is a
test in the repository.
