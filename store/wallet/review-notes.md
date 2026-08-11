# Review notes: Labyrinth Wallet

**With no node configured this build shows fixture data, and the app labels
every screen that shows a number.**

Please read that first, because a reviewer who assumes the balances are real
will reasonably conclude the app is not doing what it says.

Bitcoin will read a real chain if you set a node on the Nodes screen. There is
deliberately no default node: the app explains on that screen that a public node
learns every address in the account, and running your own is presented as the
ordinary choice. Monero can reach a node and broadcast through it; scanning for
outputs is not finished and the balance is labeled as not scanned rather than
shown as zero.

## What it does

It is the online half of a two-device wallet. It watches Bitcoin and Monero
using public keys only, builds unsigned transactions, displays them as QR codes
for an airgapped signing device on a second phone, reads the signed result back
through the camera, verifies it against what was approved, and broadcasts.

It holds no private key and has no screen that would accept one.

## How to exercise it without a second device

The send flow includes a clearly labeled stand-in that plays the part of the
vault, so the screens after the handoff can be reviewed. It is marked
`STAND-IN VAULT` on screen. It signs with the seed phrase published in the
BIP84 specification, which is public, empty, and controls nothing.

In a release build the stand-in is compiled out and the flow stops at the
handoff, which is correct behavior when no vault is paired.

1. Home shows balances. These are fixtures and marked `DEMO DATA`.
2. Receive derives and displays an address with its derivation path.
3. Send walks the whole flow: compose, review, transmit as QR frames, wait,
   read back, verify, broadcast.
4. Choosing the tampering stand-in demonstrates the mismatch state, which is
   terminal by design and has no way forward.
5. Swap quotes from a fixture and shows the payout address it derived.

## Why the camera permission

The camera reads the signed transaction back from the vault. It is the only
channel between the two devices.

## Encryption

The app is watch only. It stores no secret and encrypts nothing at rest. Its
cryptography is limited to address derivation and signature verification.
