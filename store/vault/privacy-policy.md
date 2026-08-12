# Labyrinth Vault privacy policy

Labyrinth Vault collects nothing, transmits nothing, and has no way to do
either.

## What the app has

The app contains no networking code of any kind. It requests no network
entitlement, opens no sockets, and embeds no analytics, crash reporting,
advertising, or telemetry framework. This is not a configuration that could
drift: the absence of network code is enforced by an automated test that
walks the source on every change, and the app's privacy manifest declares no
tracking, no collected data types, and no required-reason API use.

## What the app stores, and where

Your keys are generated on your device and never leave it. They are encrypted
with a passphrase you choose (Argon2id key stretching, XChaCha20-Poly1305
encryption) before they touch storage, and the encrypted result is kept in
the device keychain under its strictest class: readable only on this device,
only while it has a passcode, and never synced to iCloud or anywhere else.

There is no account, no cloud backup, no server, and no copy of anything
anywhere but the phone in your hand.

## The camera

The camera is used for one thing: reading QR codes from your companion
wallet, on screen, when you choose to scan. Images are not captured, stored,
or transmitted. The camera feed is processed on device and discarded.

## What we receive

Nothing. We have no servers for this app to talk to and no way to identify,
contact, or measure its users. If you email us, we see your email; that is
the only data path that exists, and you control it.

## Changes

If any of the above ever changes, this policy will change first, and the
app's privacy manifest and source tests will have to change with it - in
public, since the application is open source.

Contact: info@labyrinthwallet.com
