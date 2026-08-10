//  VaultKeychain.swift
//  The platform keystore, with the two decisions that matter made in code
//  rather than left to a library's defaults:
//
//  1. kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly. The item is encrypted
//     under the passcode-entangled class key: it does not exist until the
//     phone has a passcode, and — the "ThisDeviceOnly" half — it is excluded
//     from every backup and never migrates to another device. Remove the
//     passcode and the class key is discarded; the sealed blob it guarded
//     stays, but the device passphrase is gone, which fails in the safe
//     direction.
//
//  2. No sync attribute is ever set, in either direction, so nothing stored
//     here is even eligible for iCloud Keychain. Absence is the correct form:
//     an attribute that is never mentioned cannot be flipped by a refactor.
//     (test/app-wiring.test.ts greps this file to keep it that way.)
//
//  Values in and out are strings — hex-encoded by app/storage.ts, which never
//  hands this module a bare secret; the seed only ever arrives here as
//  Argon2id+XChaCha20 ciphertext.

import Foundation
import Security

@objc(VaultKeychain)
final class VaultKeychain: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { false }

  private let service = "vision.labyrinth.vault"

  private func accessibility(_ name: String) -> CFString {
    switch name {
    case "whenUnlocked": return kSecAttrAccessibleWhenUnlocked
    default: return kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
    }
  }

  @objc(set:value:accessibility:resolver:rejecter:)
  func set(_ key: String, value: String, accessibility name: String,
           resolver resolve: @escaping RCTPromiseResolveBlock,
           rejecter reject: @escaping RCTPromiseRejectBlock) {
    let base: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
    // Replace-then-add: accessibility cannot be updated in place, and a
    // half-updated item is worse than a rewritten one.
    SecItemDelete(base as CFDictionary)

    var attributes = base
    attributes[kSecValueData as String] = Data(value.utf8)
    attributes[kSecAttrAccessible as String] = accessibility(name)

    let status = SecItemAdd(attributes as CFDictionary, nil)
    if status == errSecSuccess {
      resolve(nil)
    } else {
      reject("keychain_set", "SecItemAdd failed with status \(status)", nil)
    }
  }

  @objc(get:resolver:rejecter:)
  func get(_ key: String,
           resolver resolve: @escaping RCTPromiseResolveBlock,
           rejecter reject: @escaping RCTPromiseRejectBlock) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    switch status {
    case errSecSuccess:
      guard let data = item as? Data, let string = String(data: data, encoding: .utf8) else {
        reject("keychain_get", "Item was not a UTF-8 string", nil)
        return
      }
      resolve(string)
    case errSecItemNotFound:
      resolve(nil)
    default:
      reject("keychain_get", "SecItemCopyMatching failed with status \(status)", nil)
    }
  }

  @objc(remove:resolver:rejecter:)
  func remove(_ key: String,
              resolver resolve: @escaping RCTPromiseResolveBlock,
              rejecter reject: @escaping RCTPromiseRejectBlock) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
    let status = SecItemDelete(query as CFDictionary)
    if status == errSecSuccess || status == errSecItemNotFound {
      resolve(nil)
    } else {
      reject("keychain_remove", "SecItemDelete failed with status \(status)", nil)
    }
  }
}
