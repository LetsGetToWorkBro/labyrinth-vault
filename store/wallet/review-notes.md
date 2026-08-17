# Review notes: Labyrinth Wallet

Two facts decide this review, so they lead.

**1. Out of the box this app watches nothing, and it says so rather than
showing you a number.** There is no fixture account and no sample balance: a
fresh install opens on a screen headed NOTHING WATCHED with two ways out, pair
a vault or make a wallet on this phone. There is also deliberately no default
node, and the Nodes screen explains why (a public node learns every address in
the account) and presents running your own as the ordinary choice. Dollar
figures appear only when a price is actually known, which means Labyrinth's
own relay, which serves every client one cached answer so that no price
service ever sees a user. When no price is known, balances are shown in coin,
which is the truth rather than an absence. The one fixture left in a release
build is the swap quote, which carries a `DEMO DATA` notice above it because
no exchange relay is configured in this build.

**2. This is one half of a two-device wallet, and it holds keys for one kind
of account and not the other.** An account paired from a vault is watch-only
here forever: this app cannot sign for it, and the whole flow up to the airgap
handoff, where the payment becomes animated QR codes held up to the vault's
camera, is fully reviewable on this phone alone. An account made on this phone
keeps its recovery phrase in the keychain and signs here, behind Face ID. Both
kinds are labeled on screen. See "exercising the round-trip" below for how to
review the screens after the vault handoff without a second device.

## What it does

It watches Bitcoin and Monero, builds unsigned transactions, displays them as
QR codes for an airgapped signing device on a second phone, reads the signed
result back through the camera, verifies it against what was approved, and
broadcasts. For an account created or restored on this phone it also holds the
seed and signs locally, with a Face ID check per signature. For an account
paired from a vault it cannot sign at all, by construction rather than by
setting.

## Exercising it without a second device

Everything up to the handoff needs nothing but this app:

1. **Home** opens on NOTHING WATCHED. Make a wallet on this phone, or pair a
   vault, and it becomes a balance.
2. **Receive** derives and displays a real address with its derivation path.
3. **Send** walks compose to review to **transmit**. For a vault account that
   ends on the animated QR frames a vault would scan, which is the airgap
   handoff and the screen worth seeing; for an account made on this phone it
   ends in a Face ID prompt and a signature made here.
4. **Swap** quotes from a fixture (marked `DEMO DATA`, no relay configured in
   this build) and shows the payout address it derived for a coin you own.

**The screens after the vault handoff need a signer.** Those are the screen
where a signature arrives, the check of it against what was approved, and the
deliberate *mismatch* state. In a development build a clearly labeled
`STAND-IN VAULT` control appears on the receive-signature screen. It signs
with the seed phrase published in the BIP84 specification, which is public,
empty, controls nothing, and is the key every wallet's test suite uses, purely
so those screens can be walked rather than imagined.

In the release build you are testing, that stand-in is **compiled out**: the
flag guarding it is `__DEV__`, which is false in a release bundle, so the
signer is not present and its controls do not render. A vault account's send
flow correctly stops at the QR handoff, which is the honest thing to show when
no vault is present. To review the post-handoff screens, a short
screen-recording of the full round-trip (real vault, and the mismatch case) is
attached to this submission; we are glad to provide a development build on
request.

## Monero

Monero scans on the device: the node serves blocks, the view key does the
arithmetic on the phone, and every amount found is proved against the
commitment on the chain before it is counted. A first scan from the wallet's
birth height takes time and the screen shows the percentage climbing; that is
the scan working, not the app hanging. A view key alone cannot see spending,
so for an account paired from a vault the number is labeled as what arrived
until that vault answers a key image round trip, after which spends are
subtracted and the sentence under the balance says where the answer came from.
An account whose seed is on this phone computes its own key images and needs
no round trip. Monero mainnet broadcast is gated behind a recorded live
acceptance and refuses until then, with the reason on screen; stagenet and
testnet are open.

## Why the camera permission

The camera reads the signed transaction back from the vault. It is the only
channel between the two devices. Frames are processed on device and discarded.

## Why the Face ID permission

Face ID authorizes each signature the app makes with a seed it holds itself,
and it also guards the screen that displays the recovery words. It is never a
session unlock: the prompt is per signature, because a session-long unlock is
a phone that signs anything for as long as somebody keeps it awake.

## Encryption

**Answer YES to the export-compliance question for this build.** The app
stores a recovery phrase for accounts created or restored on this phone. It
does so through the iOS keychain, at
`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, rather than by encrypting a
file itself, and it qualifies as mass market under ECCN 5D992.c. It is listed
on the same BIS self-classification report as Labyrinth Vault, which is
versioned in the repository at `store/bis/`.

There is deliberately no `ITSAppUsesNonExemptEncryption` key in this app's
Info.plist, so App Store Connect asks per build. It was removed rather than
set to `true` because `true` in a manifest, with no export-compliance code
issued yet, is what caused four consecutive upload rejections of the vault.
The account of that is in `docs/shipping.md`. Full detail on what is stored
and where is in the privacy policy, hosted at `labyrinthwallet.com/privacy`
and versioned in the repository beside this file.
