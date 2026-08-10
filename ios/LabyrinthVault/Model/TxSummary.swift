//  TxSummary.swift
//  What the confirmation screen is allowed to know.
//
//  Deliberately free of SwiftUI, UIKit and JavaScriptCore, so it compiles and
//  is tested by a plain Swift toolchain on any platform — see swift/ and
//  `npm run swift:check`. Everything in this file is data that crossed the
//  bridge, and none of it is anything a screen decides.
//
//  Split out of Vault.swift for that reason. While it lived alongside
//  `@MainActor final class Vault: ObservableObject`, the only thing checking
//  it was a regex in test/app-wiring.test.ts, because nothing here had a
//  compiler. Now a compiler runs over it on every `npm test`.

import Foundation


/// One output being paid. Mirrors `WireOutput` in src/bridge/summary.ts.
struct TxOutput: Equatable, Decodable {
    let position: Int
    /// Nil when the script decodes to no address. The screen must say so
    /// rather than draw a blank where a destination goes; the reader has
    /// already made it fatal when it carries money.
    let address: String?
    let scriptHex: String
    /// Formatted upstream. Nothing here divides by a hundred million.
    let amount: String
    let mine: Bool
    let path: String?
}

/// One previous output being spent. Mirrors `WireInput`.
struct TxInput: Equatable, Decodable {
    let position: Int
    let txid: String
    let vout: Int
    /// Nil when the PSBT did not say what it was worth, which is fatal.
    let amount: String?
    let address: String?
    let mine: Bool
    let path: String?
}

struct TxWarning: Equatable, Decodable {
    let code: String
    let fatal: Bool
    let message: String
}

/// What the confirmation screen is allowed to know.
///
/// Field for field, this is `WireSummary` in src/bridge/summary.ts, and
/// `test/app-wiring.test.ts` fails if the two drift apart. Every amount
/// arrives already formatted, because a second implementation of what a
/// satoshi is worth is how two screens come to disagree about a number.
///
/// It carries *every* output, not one destination. The version before this
/// had a single `destination`, which meant a transaction paying two people
/// would have shown one of them, and money would have left to an address
/// nobody approving it ever saw.
struct TxSummary: Equatable, Decodable {
    let ok: Bool
    let problem: String?
    /// Digest of the described bytes. Carried from review to approval to
    /// signing so that describing one transaction and signing another fails.
    let digest: String
    /// Which keyring it was described against.
    let walletId: String
    let inputs: [TxInput]
    let outputs: [TxOutput]
    let spending: String
    let leaving: String
    let returning: String
    /// The number to put next to the word "paying". Not `leaving`.
    let yourNet: String
    let fee: String?
    let feeRate: String?
    /// "~208 vB". An estimate, worded as one upstream.
    let vsize: String
    /// "0.03%". Nil when nothing is being paid, so there is no share to take.
    let feeShare: String?
    let warnings: [TxWarning]
    let signable: Bool
    /// The first fatal warning's code, if any.
    let refusal: String?

    // MARK: Derived, and derived means arranged — never recomputed.

    /// The outputs that are not yours: what this transaction actually pays.
    var payees: [TxOutput] { outputs.filter { !$0.mine } }
    /// The outputs coming back to you.
    var change: [TxOutput] { outputs.filter { $0.mine } }
    /// True when there is more than one payee, which the screen must list
    /// rather than summarise.
    var paysSeveral: Bool { payees.count > 1 }
    /// True when any output has no address a person could read.
    var hasUnreadableOutput: Bool { outputs.contains { $0.address == nil } }
}
