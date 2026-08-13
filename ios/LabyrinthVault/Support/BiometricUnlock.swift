//  BiometricUnlock.swift
//  Face ID or Touch ID instead of typing the passphrase, if the person asks
//  for it, and an honest account of what that costs.
//
//  ## This is not the biometry gate SealedStore refuses
//
//  `SealedStore.swift` argues against putting a biometry gate on the sealed
//  blob, and that argument still stands: the blob is ciphertext, the lock on
//  it is the Argon2id-stretched passphrase, and a Face ID prompt in front of
//  ciphertext adds a prompt without adding protection. That is theater.
//
//  This is the other thing, and it is not theater: the passphrase itself is
//  kept in a keychain item that the Secure Enclave will only release against a
//  live biometric match on this device. Nothing else can read it. It is a real
//  convenience and it buys that convenience with a real change to the threat
//  model, which is why it is off unless somebody turns it on, and why the
//  screen that offers it says what it does in the same sentence.
//
//  ## What changes when it is on
//
//  Without it, opening the vault needs something you *know*. A phone taken
//  from your hand, unlocked, is not enough: the passphrase is not on it in any
//  form.
//
//  With it, opening the vault needs the phone and your face. That is strictly
//  weaker against three people in particular: somebody who can compel you
//  physically, somebody holding the phone while you are asleep or otherwise
//  not deciding anything, and a border officer. It is *not* weaker against
//  theft of the device alone, which is the threat most people actually meet.
//
//  Nothing here weakens the vault at rest. The sealed blob is sealed exactly
//  as before, under exactly the same passphrase, and a person who turns this
//  off is back to the original arrangement with nothing left behind.
//
//  ## The flags, and why each one
//
//  `.biometryCurrentSet` rather than `.biometryAny`: enrolling a new face or
//  fingerprint invalidates the item, so an attacker who knows the device
//  passcode cannot add their own face and walk in. This is the flag that makes
//  the feature worth having.
//
//  No `.devicePasscode` fallback, deliberately. Offering the passcode as a
//  fallback would make a four-to-six digit number sufficient to open a vault
//  whose whole design is a long passphrase, and it would do it behind a button
//  that looks like a convenience. The fallback here is the passphrase, which
//  is always on the screen underneath.
//
//  `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` for the same reasons the
//  sealed blob uses it: never synced, never off this device, and gone if the
//  device passcode is turned off.

import Foundation
import LocalAuthentication
import Security

enum BiometricUnlock {
    private static let service = "vision.labyrinth.vault"
    private static let account = "unlock-passphrase"

    /// What this device can offer, in the words the screens use.
    enum Kind {
        case faceID
        case touchID
        case none

        var name: String {
            switch self {
            case .faceID: return "FACE ID"
            case .touchID: return "TOUCH ID"
            case .none: return ""
            }
        }

        var isAvailable: Bool { self != .none }
    }

    /// What the hardware has, and whether it is usable right now.
    ///
    /// Deliberately reports `.none` when biometry exists but is unenrolled or
    /// locked out. A screen offering Face ID that cannot use Face ID is worse
    /// than a screen that does not offer it.
    static func kind() -> Kind {
        let context = LAContext()
        var problem: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &problem) else {
            return .none
        }
        switch context.biometryType {
        case .faceID: return .faceID
        case .touchID: return .touchID
        default: return .none
        }
    }

    /// Whether a passphrase has been stored, asked without prompting for a
    /// face.
    ///
    /// The naive check is a fetch, and a fetch is exactly what puts a Face ID
    /// sheet on the screen. `kSecUseAuthenticationUIFail` says "tell me, but do
    /// not ask anybody anything", and the refusal it returns —
    /// `errSecInteractionNotAllowed` — *is* the affirmative answer: the item is
    /// there and it would have needed authentication.
    static func isEnrolled() -> Bool {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
        ]
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecInteractionNotAllowed || status == errSecSuccess
    }

    /// Keep this passphrase for biometric unlock. Returns a sentence on
    /// failure, nil on success.
    ///
    /// Called only with a passphrase that has just successfully opened the
    /// vault, so what gets stored is known to be the right one. Storing a
    /// string the person merely typed would produce a vault that answers to a
    /// face with a passphrase that does not open it.
    static func enroll(passphrase: String) -> String? {
        guard kind().isAvailable else {
            return "This device has no biometric sensor available."
        }
        guard let data = passphrase.data(using: .utf8), !data.isEmpty else {
            return "There is nothing to store."
        }

        var control: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
            .biometryCurrentSet,
            &control
        ) else {
            control?.release()
            return "This device would not create the biometric lock."
        }

        forget()

        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessControl as String: access,
        ]

        let status = SecItemAdd(item as CFDictionary, nil)
        switch status {
        case errSecSuccess:
            return nil
        case errSecNotAvailable, errSecAuthFailed:
            return "This device has no passcode. Set one first: nothing is stored on a device that does not lock."
        default:
            return "The keychain refused to store it (code \(status))."
        }
    }

    /// What asking for the stored passphrase can come back as.
    ///
    /// Three cases rather than two, and the third is the reason this is not a
    /// `Result`. Swift's `Result` requires its failure type to conform to
    /// `Error`, which a sentence does not, and the first version of this used
    /// `Result<String, String>` and did not compile. Working around that by
    /// wrapping the sentence in an error type would have kept a worse shape:
    /// a cancelled prompt is not a failure, it is a person changing their
    /// mind, and it had been encoded as a failure carrying an empty string
    /// that every caller had to remember to check for. Naming the three
    /// outcomes makes the empty string impossible and the switch exhaustive.
    enum Recalled {
        /// The Secure Enclave released it.
        case passphrase(String)
        /// Cancelled, or the face was not recognized. Say nothing; the
        /// passphrase field is already on the screen underneath.
        case declined
        /// Something worth putting in front of the person.
        case failed(String)
    }

    /// The stored passphrase, after a biometric match. Prompts.
    ///
    /// Off the main actor because the keychain call blocks for as long as the
    /// person takes to present a face, and the caller is a screen.
    static func recall(reason: String) async -> Recalled {
        await Task.detached(priority: .userInitiated) {
            let context = LAContext()
            context.localizedReason = reason
            /* No "Enter Password" button on the system sheet. The fallback is
             * the passphrase field on the screen underneath, which is this
             * app's own and not a device passcode prompt. */
            context.localizedFallbackTitle = ""

            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
                kSecUseAuthenticationContext as String: context,
            ]

            var result: AnyObject?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            switch status {
            case errSecSuccess:
                guard let data = result as? Data,
                      let passphrase = String(data: data, encoding: .utf8),
                      !passphrase.isEmpty
                else {
                    return .failed("The stored passphrase came back in a form this build cannot read.")
                }
                return .passphrase(passphrase)
            case errSecUserCanceled, errSecAuthFailed:
                /* Not an error to put on the screen in red. The person either
                 * changed their mind or was not recognized, and the passphrase
                 * field is right there. */
                return .declined
            case errSecItemNotFound:
                /* Enrollment changed, so the Secure Enclave threw the item
                 * away. That is `.biometryCurrentSet` doing its job, and it
                 * needs saying, because the offer will now be gone. */
                return .failed("The biometric record on this device changed, so the stored passphrase was discarded. Enter it to unlock.")
            default:
                return .failed("The keychain would not release it (code \(status)).")
            }
        }.value
    }

    /// Drop the stored passphrase. Never prompts, and safe to call when
    /// nothing is stored: turning a convenience off must not be gated on the
    /// convenience working.
    static func forget() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
