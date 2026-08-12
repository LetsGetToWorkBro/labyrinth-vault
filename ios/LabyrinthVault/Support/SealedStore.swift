//  SealedStore.swift
//  Where the sealed vault lives between launches: one Keychain item, holding
//  ciphertext.
//
//  What is stored is the blob `create` returned — Argon2id-stretched,
//  XChaCha20-Poly1305-sealed, never the secret. The Keychain adds a second,
//  independent layer on top of that: the item is encrypted by the device's
//  secure hardware under a key that never leaves it, readable only while this
//  device is unlocked, and only on a device that has a passcode at all.
//  `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` is the strictest class
//  Apple offers a keychain item, and it is the same class the companion app's
//  store uses (app/ios/VaultKeychain.swift) — deliberately, so there is one
//  answer to "how is it stored" across the project.
//
//  What is deliberately absent:
//
//  - Any synchronizable attribute, in any form. This item must never reach
//    iCloud Keychain, and the way to be sure a sync flag is never flipped is
//    for the flag not to appear in the source at all. test/app-wiring.test.ts
//    holds the companion to that rule; this file holds itself to it.
//
//  - A biometry gate (`SecAccessControl` + Face ID). The lock on the *secret*
//    is the passphrase the person types — that is what stretches into the
//    decryption key, and a face cannot replace it, only precede it with a
//    second prompt in front of ciphertext. A gate that adds a prompt without
//    adding protection is theater, and theater is what this product refuses.
//
//  Errors come back as sentences, in the voice the rest of the app speaks,
//  because every caller puts them straight on a screen.

import Foundation
import Security

enum SealedStore {
    /// One service, one account: there is exactly one vault per device, and a
    /// second one appearing under a different account name would be a bug.
    private static let service = "vision.labyrinth.vault"
    private static let account = "sealed-vault"

    private static var base: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// The sealed blob from the last `save`, or nil if no vault exists yet.
    /// Nil and "device locked" are different answers, but not here: this is
    /// read once at boot, in the foreground, where a passcode-set device is
    /// always readable.
    static func load() -> String? {
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let hex = String(data: data, encoding: .utf8),
              !hex.isEmpty
        else { return nil }
        return hex
    }

    /// Store the sealed blob. Returns a sentence on failure, nil on success.
    ///
    /// Delete-then-add rather than update-in-place: the accessibility class of
    /// an existing item cannot be changed by `SecItemUpdate`, and an old item
    /// written under a weaker class surviving a rewrite would be exactly the
    /// kind of silent downgrade this store exists to rule out.
    static func save(_ sealedHex: String) -> String? {
        guard let data = sealedHex.data(using: .utf8), !data.isEmpty else {
            return "There is nothing to store."
        }
        SecItemDelete(base as CFDictionary)

        var item = base
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly

        let status = SecItemAdd(item as CFDictionary, nil)
        switch status {
        case errSecSuccess:
            return nil
        case errSecNotAvailable, errSecAuthFailed:
            /* The accessibility class requires a device passcode; without one
             * the add is refused by the OS. Refusing to store keys on a device
             * anybody can pick up and open is the correct behavior, so the
             * failure is passed to the person as the requirement it is. */
            return "This device has no passcode. Set one, then create the vault: keys are only stored on a device that locks."
        default:
            return "The keychain refused to store the vault (code \(status))."
        }
    }

    /// Remove the sealed blob. The keys it protected are unrecoverable after
    /// this except from the recovery phrases; the caller is the screen that
    /// says so.
    static func erase() {
        SecItemDelete(base as CFDictionary)
    }
}
