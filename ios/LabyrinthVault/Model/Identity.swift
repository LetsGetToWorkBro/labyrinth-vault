//  Identity.swift
//  How a vault introduces itself, computed rather than styled.
//
//  Two devices holding the same keys must render the same identity, because
//  the identity exists for one purpose: a person checking that the wallet on
//  the table is the wallet they think it is. That makes this formatting logic
//  rather than presentation, and logic gets compiled and tested. It sat
//  inline in Vault.swift before this file, where no compiler off a Mac could
//  reach it and an off-by-one in the grouping would have shown two different
//  ids for one key.
//
//  Foundation only, deliberately.

import Foundation

public enum Identity {
    /// A short display id from an account key: the last twelve characters,
    /// uppercased, in groups of four. `zpub…GutZYs` becomes `KF31 MGDT KSAY`
    /// style — enough to compare across a table, nowhere near enough to
    /// reconstruct anything.
    public static func vaultID(fromAccountKey zpub: String) -> String {
        let tail = String(zpub.suffix(12)).uppercased()
        guard !tail.isEmpty else { return "•••• •••• ••••" }
        var groups: [String] = []
        var index = tail.startIndex
        while index < tail.endIndex {
            let end = tail.index(index, offsetBy: 4, limitedBy: tail.endIndex) ?? tail.endIndex
            groups.append(String(tail[index..<end]))
            index = end
        }
        return groups.joined(separator: " ")
    }

    /// The last eight characters of the first receiving address, uppercased.
    /// Same idea, other chain of custody: the address came from the engine's
    /// derivation, so agreeing on this string means agreeing on the keys.
    public static func fingerprint(fromFirstAddress address: String) -> String {
        let tail = String(address.suffix(8)).uppercased()
        return tail.isEmpty ? "········" : tail
    }
}
