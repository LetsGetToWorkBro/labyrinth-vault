//  MoneroFile.swift
//  What one of Monero's own wallet files says about itself.
//
//  Field for field, this is `WireMoneroFile` in src/bridge/summary.ts, held to
//  it by the regex comparison in test/app-wiring.test.ts. Foundation and
//  nothing else, so Package.swift compiles it and a mistake here is a build
//  error rather than a blank row on a phone.
//
//  ## Why this is not `MoneroSummary`
//
//  The two look alike and mean opposite things, and keeping them apart is the
//  entire reason this is a second file rather than an optional field on the
//  first.
//
//  `MoneroSummary` describes a set the engine has *checked*. `moneroDescribe`
//  re-derives the claimed change against this vault's own address and refuses
//  the whole set if they disagree, it remembers a digest, and the screen that
//  renders it ends in a lever that signs. A number on that screen is a number
//  the device stands behind.
//
//  This describes a file `wallet2` wrote. Every value in it is the *sending*
//  wallet's account of its own transaction: the amounts, the ring size, the
//  destination, the fact that one output is change. None of it is checked
//  against anything, and none of it can be — verifying a destination means
//  re-deriving it from this vault's keys, which needs a request shaped for
//  that, which is what this project's own wire carries. A watch-only wallet
//  that lies about where the money goes writes a file that reads beautifully.
//
//  So there is no `digest` here and no `randomBytes`, and their absence is
//  load-bearing rather than an omission: those are what `moneroSign` demands,
//  and a screen holding this type has nothing to give it. The screen says so
//  in words as well, because a person reading a list of amounts should not
//  have to infer it from a missing button.

import Foundation

/// One payment the file says it intends to make. Mirrors `WireMoneroFilePayment`.
struct MoneroFilePayment: Equatable, Decodable, Identifiable {
    let position: Int
    /// The address as the sending wallet recorded it, or nil when it kept
    /// none.
    ///
    /// Optional because `tx_destination_entry::original` often is empty: the
    /// file always carries the recipient's two public keys, and never carries
    /// the network byte needed to turn them back into an address. Rendering a
    /// confident mainnet address for a stagenet payment would be worse than
    /// saying the file did not record one, so the screen says that.
    let address: String?
    /// "STANDARD", "SUBADDRESS" or "INTEGRATED", as the file classifies it.
    let kind: String
    /// Formatted upstream, like every amount on every screen. Nothing in
    /// Swift divides by a trillion.
    let amountFormatted: String

    var id: Int { position }
}

/// One transaction inside the file. A set can hold several.
struct MoneroFileTx: Equatable, Decodable, Identifiable {
    let position: Int
    /// What the inputs are worth in total, per the file.
    let spendingFormatted: String
    /// Spending, less what the file says comes back as change.
    let payingFormatted: String
    let changeFormatted: String
    /// Inputs minus outputs. The file carries no fee field, because that is
    /// what a fee is.
    let feeFormatted: String
    let ringSize: Int
    let inputCount: Int
    let outputCount: Int
    /// "Immediately", or the block or time the file says it is locked until.
    let spendableNote: String
    let payments: [MoneroFilePayment]

    var id: Int { position }
}

/// A wallet2 file, as the read-only screen renders it.
struct MoneroFile: Equatable, Decodable {
    /// Plain words for the file, from the container's magic.
    let what: String
    /// Whether the vault opened it. False leaves `transactions` empty and
    /// `problem` set, which is a complete answer rather than a failure: this
    /// screen signs nothing either way, so naming the file and saying why it
    /// did not open beats a blank refusal.
    let readable: Bool
    let problem: String?
    let transactions: [MoneroFileTx]
    /// Every transaction's payments added up, so a file holding several still
    /// leads with one number.
    let payingFormatted: String
    let feeFormatted: String
}
