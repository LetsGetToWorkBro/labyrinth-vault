# The React Native shell

The runtime the vault actually ships in. The cryptography in `../src` is
TypeScript with every platform dependency passed as an argument, which means
it runs unmodified in Hermes: no port, no second implementation to drift out
of agreement with the tested one. This package is everything around that:
the runtime floor, the launch gate, sealed storage against the Keychain, the
session lifecycle, and the two privacy leaks only native code can close.

The SwiftUI in `../ios` remains the design reference the screens follow;
`../ui` remains the interaction spec. What is here is the wiring, and the
wiring is tested: `test/app-wiring.test.ts` runs `storage.ts` and
`session.ts` through the identical code paths the phone uses, with the
Keychain and the app switcher played by fakes.

## The five wirings

**1: Launch.** `SelfTestGate` wraps the whole app. It calls `selfTest()`
from `src/selftest.ts`: real SHA-256 against the NIST vector, BIP84 against
the specification's own numbers, a seal/unseal round trip, the Monero and
BC-UR checks: renders every check by name, and mounts nothing until
`allChecksPass`. A few hundred milliseconds at every launch. The failure
state has one action: run the checks again. There is no route past a machine
that cannot prove itself.

**2: Storage.** `storage.ts` + `ios/VaultKeychain.swift`. At setup, 32
random bytes become a device passphrase stored under
`kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`: passcode-entangled,
excluded from backups, never migrates; no sync attribute is ever set, so
nothing is eligible for iCloud Keychain. The person may layer their own
passphrase on top (newline-joined; the layers cannot collide), making unseal
require what the Keychain guards *and* what they know. `seal()` runs before
anything touches the store, so the store only ever holds ciphertext: the
seed is never stored in any encoding. Unsealing is transient:
`withUnsealedSeed` hands the seed to a callback and wipes it in a `finally`.

**3: Setup calibration.** `calibrateForThisDevice()` wraps
`calibrateKdf(1000, Date.now)`: run once, on the phone itself, walking
Argon2id's memory parameter until a guess costs about a second on this
hardware. The result seals the vault and rides in the blob's authenticated
header: nothing to store, nothing to desync.

**4: Lock on background.** `session.ts` subscribes to AppState. Leaving
`active`: backgrounding *or* the app switcher, calls `closeWallet()`:
private keys zeroed in place, the same wallet object demoted to watch-only.
Addresses still derive, the interface does not go blank, and signing requires
a fresh unseal. A phone lifted mid-session holds ciphertext and public keys.

**5: Runtime floor.** `boot.js`, imported first from `index.js` and
order-enforced by test: `react-native-get-random-values` provides the
`crypto.getRandomValues` that every entropy argument draws from, and a
guarded `TextEncoder`/`TextDecoder` polyfill covers older Hermes: the note
in `src/platform.d.ts`, honoured. Natively, `PrivacyGuard.install()` drops
an opaque cover on `willResignActive` so the app-switcher snapshot iOS
writes to disk shows a wordmark instead of a seed phrase; and nothing in
`app/` or `app/ios/` writes to the clipboard: the passphrase fields set
`contextMenuHidden`, and the test suite greps both trees to keep pasteboard
code from ever appearing. Addresses leave by QR; seeds leave by hand.

## Building

Standard React Native iOS setup applies (this repo intentionally carries no
lockfile or Pods for the app: the manifest pins exact versions):

```sh
cd app && npm install
cd ios && pod install    # after `npx react-native init`-style project generation
```

Add `PrivacyGuard.install()` to the AppDelegate's launch method, and set the
bridging header to `app/ios/LabyrinthVault-Bridging-Header.h`. The app
target requests exactly one permission: the camera, and must never gain a
network entitlement; `test/ios-no-network.test.ts` and the patterns in
`test/app-wiring.test.ts` hold that line on the source.
