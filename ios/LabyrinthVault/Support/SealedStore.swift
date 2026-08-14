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
//  - A biometry gate on *this* item. The lock on the secret is the passphrase
//    the person types: that is what stretches into the decryption key, and a
//    face cannot replace it here, only precede it with a second prompt in
//    front of ciphertext. A gate that adds a prompt without adding protection
//    is theater, and theater is what this product refuses.
//
//    `Support/BiometricUnlock.swift` is a different thing and worth not
//    confusing with this one. It stores the *passphrase*, in its own item,
//    behind `.biometryCurrentSet`, so that a face can stand in for typing.
//    That is a real convenience bought with a real change to the threat model,
//    it is off until somebody turns it on, and that file argues it out. This
//    item is untouched by it either way.
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
    /// A second item holding no secret at all — its existence is the fact "a
    /// vault was created on this device". It lives under a class that
    /// survives the one event that deletes the blob (see `witnessExists`),
    /// which is what lets boot tell a fresh device from a bereaved one.
    private static let witnessAccount = "vault-witness"
    /// A third item, and the least interesting one: how many seconds a single
    /// Argon2id pass took when the vault was made on this hardware.
    ///
    /// It is here rather than in `UserDefaults` for one reason, and it is not
    /// secrecy — a duration describes the phone, which the phone already
    /// knows. `UserDefaults` is on Apple's required-reason API list, and
    /// `test/shipping.test.ts` holds this app to an empty privacy manifest.
    /// One cached number is not worth the first entry in a file whose being
    /// empty is a claim the project makes out loud. The keychain is already
    /// declared, already used, and does not care.
    private static let timingAccount = "pass-seconds"
    /// The device half of the passphrase: 32 random bytes as hex, generated
    /// once, never shown, never leaving this keychain or this phone.
    ///
    /// Its presence is also the scheme marker. A vault made before this
    /// existed was sealed under the typed passphrase alone, and the way to
    /// tell is that there is no device secret beside it.
    private static let deviceAccount = "device-passphrase.v1"

    private static func base(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// The three answers the keychain can give at boot, kept distinct because
    /// they route to three different screens. Collapsing `unreadable` into
    /// `none` would walk a person whose vault still exists into making a
    /// second one over it; that is the confusion this type exists to refuse.
    enum Loaded {
        case none
        case found(String)
        case unreadable(String)
    }

    /// What is at rest. Read once at boot, in the foreground, where a
    /// passcode-set device is always readable — so anything other than a
    /// clean hit or a clean miss is a real problem, and is reported as one
    /// rather than rounded down to "no vault".
    static func load() -> Loaded {
        var query = base(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data,
                  let hex = String(data: data, encoding: .utf8),
                  !hex.isEmpty
            else {
                return .unreadable("The keychain returned the vault in a form this build cannot read.")
            }
            return .found(hex)
        case errSecItemNotFound:
            return .none
        default:
            return .unreadable("The keychain would not return the vault (code \(status)). Nothing was changed.")
        }
    }

    /// True if a vault was created on this device at some point, whether or
    /// not its blob still exists. The witness is stored under
    /// `AfterFirstUnlockThisDeviceOnly` — still never synced, still bound to
    /// this device, but *not* passcode-bound, because its whole job is to
    /// survive the passcode being turned off. That event deletes every
    /// `WhenPasscodeSetThisDeviceOnly` item, the sealed blob included: the
    /// protection working as designed, and something the person deserves a
    /// sentence about rather than a silent walk back into setup.
    static func witnessExists() -> Bool {
        var query = base(witnessAccount)
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }

    /// Clear the witness alone: the acknowledgment tap on the screen that
    /// explains a vanished vault, after which the device really is fresh.
    static func forgetWitness() {
        SecItemDelete(base(witnessAccount) as CFDictionary)
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
        SecItemDelete(base(account) as CFDictionary)

        var item = base(account)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly

        let status = SecItemAdd(item as CFDictionary, nil)
        switch status {
        case errSecSuccess:
            /* The witness rides along with every successful save. Its value
             * is a single meaningless byte: the fact is its existence. A
             * failure to write it is not a failure to make the vault, so the
             * status is deliberately not consulted. */
            SecItemDelete(base(witnessAccount) as CFDictionary)
            var witness = base(witnessAccount)
            witness[kSecValueData as String] = Data([1])
            witness[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(witness as CFDictionary, nil)
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

    /// The device half of the passphrase, made if this phone has none.
    ///
    /// Returns nil only when the keychain refuses to keep it, which on a
    /// passcode-set device it does not. A nil is a refusal to seal rather than
    /// a licence to seal without the layer: the caller must treat it as a
    /// failure, because quietly falling back to a one-layer vault would be the
    /// weaker vault nobody chose.
    static func deviceSecretHex(orMakeWith random: (Int) -> [UInt8]?) -> String? {
        if let existing = existingDeviceSecret() { return existing }

        guard let bytes = random(deviceSecretBytes), bytes.count == deviceSecretBytes else {
            return nil
        }
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        guard let data = hex.data(using: .utf8) else { return nil }

        SecItemDelete(base(deviceAccount) as CFDictionary)
        var item = base(deviceAccount)
        item[kSecValueData as String] = data
        /* The same class as the blob it protects. Anything weaker would put
         * the two halves under different locks, and the vault is then only as
         * protected as the weaker one. */
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { return nil }
        return hex
    }

    static let deviceSecretBytes = 32

    /// The device secret if this phone has one, without making one.
    ///
    /// Absence is meaningful: it says the vault beside it predates the layer.
    static func existingDeviceSecret() -> String? {
        var query = base(deviceAccount)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let hex = String(data: data, encoding: .utf8),
              hex.count == deviceSecretBytes * 2 else { return nil }
        return hex
    }

    /// Remember what one key derivation costs on this device.
    ///
    /// Written once, at creation, where a pass has just been timed for real.
    /// Read by the unlock screen, which runs the same pass over the same
    /// parameters and can therefore show a true countdown instead of a
    /// spinner. Failure is ignored on purpose: the worst case is an unlock
    /// screen that loops rather than counts, which is what it did before.
    static func rememberPassSeconds(_ seconds: Double) {
        guard seconds.isFinite, seconds > 0,
              let data = String(seconds).data(using: .utf8) else { return }
        SecItemDelete(base(timingAccount) as CFDictionary)
        var item = base(timingAccount)
        item[kSecValueData as String] = data
        /* Deliberately the weaker class of the two used here. It has to be
         * readable on the unlock screen, which is by definition before the
         * vault is open, and it protects nothing that would matter if read. */
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    /// What a pass cost last time, or nil on a device that never made one.
    static func passSeconds() -> Double? {
        var query = base(timingAccount)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let text = String(data: data, encoding: .utf8),
              let seconds = Double(text),
              seconds.isFinite, seconds > 0 else { return nil }
        return seconds
    }

    /// Remove the sealed blob and the witness both. The keys are
    /// unrecoverable after this except from the recovery phrases; the caller
    /// is the screen that says so.
    static func erase() {
        SecItemDelete(base(account) as CFDictionary)
        SecItemDelete(base(witnessAccount) as CFDictionary)
        SecItemDelete(base(timingAccount) as CFDictionary)
        /* The device secret goes with the blob it sealed. Leaving it would
         * mean the next vault made on this phone inherits the last one's
         * device half, which is not a secret anybody chose to reuse. */
        SecItemDelete(base(deviceAccount) as CFDictionary)
    }
}
