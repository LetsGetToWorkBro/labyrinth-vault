//  MoneroApprovalDestinationTests.swift
//  The Monero twin of the line the approval screen puts next to TO.
//
//  Same argument as `ApprovalDestinationTests`: it was four branches inside
//  `XmrApproveView`, on the last screen before a signature, in a file that
//  imports SwiftUI and is therefore type-checked by nobody. `MoneroSummary`
//  compiles here, so these run on every push.
//
//  One difference from the Bitcoin side is the whole story of why that one had
//  a bug and this one did not: `MoneroOutput.address` is not optional, so
//  there is no shape where the single-payee branch is skipped and the count
//  answers in its place. The test that says so is here anyway, because what
//  makes it unreachable is a type, and a type can change.

import XCTest
#if canImport(LabyrinthVaultCore)
@testable import LabyrinthVaultCore
#else
@testable import LabyrinthVault
#endif

final class MoneroApprovalDestinationTests: XCTestCase {

    /// Addresses with varied tails on purpose. A fixture ending in ten zeroes
    /// would make `suffix(10)` agree with almost any other slice of itself,
    /// which is the degenerate shape this repository keeps finding.
    private let payee = "48real5Kq9xTvWbNc7pZmH3jRfLdYsEuAoCiGtXz"
    private let second = "48pay2mWnBc7pZmH3jRfLdYsEuAoCiGtXzQ7vLpR"
    private let change = "44chg9dWnBc7pZmH3jRfLdYsEuAoCiGtXzQ7vBnM"

    private func summary(outputs: [(address: String, change: Bool, dummy: Bool)]) throws -> MoneroSummary {
        let encoded = outputs.enumerated().map { index, output in
            "{\"position\": \(index), \"address\": \"\(output.address)\", \"amount\": \"1\", "
                + "\"amountFormatted\": \"0.000001\", \"change\": \(output.change), "
                + "\"dummy\": \(output.dummy)}"
        }.joined(separator: ",")

        let json = "{\"ok\": true, \"problem\": null, \"digest\": \"abcd\", \"network\": \"mainnet\", "
            + "\"inputCount\": 1, \"ringSize\": 16, \"outputs\": [\(encoded)], "
            + "\"paying\": \"1\", \"payingFormatted\": \"0.000001\", "
            + "\"fee\": \"1\", \"feeFormatted\": \"0.000001\", \"randomBytes\": 32}"

        return try JSONDecoder().decode(MoneroSummary.self, from: Data(json.utf8))
    }

    func testOnePayeeShowsItsTail() throws {
        let tx = try summary(outputs: [
            (address: payee, change: false, dummy: false),
            (address: change, change: true, dummy: false),
        ])
        XCTAssertEqual(tx.approvalDestination, "…EuAoCiGtXz")
    }

    func testNoPayeesIsASelfSend() throws {
        let tx = try summary(outputs: [(address: change, change: true, dummy: false)])
        XCTAssertEqual(tx.approvalDestination, "SELF")
    }

    func testSeveralPayeesAreCounted() throws {
        let tx = try summary(outputs: [
            (address: payee, change: false, dummy: false),
            (address: second, change: false, dummy: false),
        ])
        XCTAssertEqual(tx.approvalDestination, "2 RECIPIENTS")
    }

    func testADummyOutputIsNotSomebodyBeingPaid() throws {
        /* Monero adds a zero-value output back to yourself when a transaction
         * would otherwise have one, so there is something for the ring to hide
         * among. Counting it would put "2 RECIPIENTS" in front of a person
         * paying one person, on the screen where they attest the destination.
         *
         * Held here rather than trusted to `paid`, because `paid` filtering on
         * both `change` and `dummy` is the reason this works and a filter is
         * one edit from being about one field. */
        let tx = try summary(outputs: [
            (address: payee, change: false, dummy: false),
            (address: second, change: false, dummy: true),
            (address: change, change: true, dummy: false),
        ])
        XCTAssertEqual(tx.paid.count, 1)
        XCTAssertEqual(tx.approvalDestination, "…EuAoCiGtXz")
    }

    func testItNeverSaysOneRecipients() throws {
        let tx = try summary(outputs: [(address: payee, change: false, dummy: false)])
        XCTAssertNotEqual(tx.approvalDestination, "1 RECIPIENTS")
        XCTAssertFalse(tx.approvalDestination.hasPrefix("1 "),
                       "a single payee is being counted rather than named: \(tx.approvalDestination)")
    }

    func testChangeIsNeverMistakenForADestination() throws {
        /* A regression that counted change would show a person their own
         * address as the place their money is going, which reads as safe. */
        let tx = try summary(outputs: [
            (address: payee, change: false, dummy: false),
            (address: change, change: true, dummy: false),
            (address: second, change: true, dummy: false),
        ])
        XCTAssertEqual(tx.approvalDestination, "…EuAoCiGtXz")
        XCTAssertEqual(tx.returning.count, 2)
    }
}
