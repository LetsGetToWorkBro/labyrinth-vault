//  MoneroSummary.swift
//  What the Monero confirmation screen is allowed to know.
//
//  Field for field, this is `WireMoneroSummary` in src/bridge/summary.ts,
//  guarded the same two ways as its Bitcoin sibling: the regex comparison in
//  test/app-wiring.test.ts, and MoneroContractTests.swift decoding JSON the
//  TypeScript actually produced. Free of SwiftUI on purpose, so a plain
//  toolchain compiles it on any platform.
//
//  The shape is what a Monero set actually supports, which is not what a PSBT
//  supports. The fee is stated in the set rather than left over, so there is
//  no `feeRate` estimated here; there are no per-input addresses, because a
//  ring deliberately obscures which member is real; and an output marked as
//  change has already been checked by the engine against this vault's own
//  address — `moneroDescribe` refuses the set outright when the claim and the
//  address disagree, so a summary that reaches a screen has survived the
//  same change-swap defense the PSBT reader applies.

import Foundation

/// One output being paid. Mirrors `WireMoneroOutput`.
struct MoneroOutput: Equatable, Decodable {
    let position: Int
    let address: String
    /// Raw piconero, for comparisons. Never rendered.
    let amount: String
    /// The number a screen shows. Formatted upstream, like every amount on
    /// every screen; nothing in Swift divides by a trillion.
    let amountFormatted: String
    let change: Bool
    /// A zero-amount self-output added only to satisfy the two-output
    /// consensus rule. Listed in the structure, never as a payee.
    let dummy: Bool
}

/// What the Monero confirmation screen is allowed to know.
struct MoneroSummary: Equatable, Decodable {
    /// keccak of the payload bytes. Carried from review to approval to
    /// signing so that describing one set and signing another fails.
    let digest: String
    let network: String
    let inputCount: Int
    let ringSize: Int
    let outputs: [MoneroOutput]
    let paying: String
    let payingFormatted: String
    let fee: String
    let feeFormatted: String
    /// How many bytes of fresh platform randomness the signing step needs,
    /// stated by the engine, which owns the formula. Swift draws exactly this
    /// many and never re-derives the count.
    let randomBytes: Int
}

extension MoneroSummary {
    /// The outputs leaving this wallet, in position order. What the person is
    /// paying, and the part of the screen nothing may compete with.
    var paid: [MoneroOutput] { outputs.filter { !$0.change && !$0.dummy } }
    /// The outputs returning. Already checked against the vault's own address
    /// by the engine; the screen says so rather than re-checking what the
    /// summary cannot carry.
    var returning: [MoneroOutput] { outputs.filter(\.change) }
}
