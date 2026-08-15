//  MoneroFileContractTests.swift
//  Swift decoding what TypeScript actually produced, for the read-only screen.
//
//  Same posture as MoneroContractTests, one step further back: the fixture in
//  `monero-file.json` was not composed here. It comes from
//  `test/fixtures/monero-unsigned-tx-set.json`, whose bytes were written by
//  Monero's own `binary_archive` in the harness under `oracle/`, and it
//  reached this file through the real envelope, the real archive reader and
//  the real `moneroFileToWire`. What is being checked is that the type in
//  MoneroFile.swift decodes it, field for field, the way the app will.
//
//  Both shapes are pinned, and the second is the one that catches the subtle
//  break. A container this build has no reader for arrives through the same
//  type with an empty transaction list and a reason: a `problem` that had
//  quietly stopped being optional, or a `transactions` that had become
//  non-optional in the other direction, decodes one of these and not the
//  other.

import XCTest
#if canImport(LabyrinthVaultCore)
@testable import LabyrinthVaultCore
#else
@testable import LabyrinthVault
#endif

final class MoneroFileContractTests: XCTestCase {

    private struct Fixture: Decodable {
        let note: String
        let opened: MoneroFile
        let closed: MoneroFile
    }

    private func load() throws -> Fixture {
        guard let url = FixtureBundle.url("monero-file") else {
            XCTFail("monero-file.json is not in this target's resources")
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testDecodesTheFileTheOracleProduced() throws {
        let file = try load().opened
        XCTAssertTrue(file.readable)
        XCTAssertNil(file.problem)
        XCTAssertEqual(file.what, "a Monero unsigned transaction set")
        XCTAssertEqual(file.transactions.count, 1)

        let tx = try XCTUnwrap(file.transactions.first)
        /* The same numbers test/monerounsigned.test.ts pins in piconero,
         * formatted once by the one formatter that knows what a piconero is
         * worth. If these ever disagree with that test, one of the two layers
         * is doing arithmetic the other is not. */
        XCTAssertEqual(tx.spendingFormatted, "3")
        XCTAssertEqual(tx.payingFormatted, "2.4")
        XCTAssertEqual(tx.changeFormatted, "0.5")
        XCTAssertEqual(tx.feeFormatted, "0.1")
        XCTAssertEqual(tx.ringSize, 2)
        XCTAssertEqual(tx.inputCount, 1)
        XCTAssertEqual(tx.outputCount, 2)
        XCTAssertEqual(tx.spendableNote, "Immediately")
    }

    func testCarriesEveryPayeeWithWhatTheFileCallsIt() throws {
        let tx = try XCTUnwrap(try load().opened.transactions.first)
        XCTAssertEqual(tx.payments.count, 1)
        let payment = try XCTUnwrap(tx.payments.first)
        XCTAssertEqual(payment.kind, "SUBADDRESS")
        XCTAssertEqual(payment.amountFormatted, "2.4")
        XCTAssertTrue(try XCTUnwrap(payment.address).hasPrefix("4AdUnd"))
    }

    func testTheUnreadableContainerDecodesThroughTheSameType() throws {
        let file = try load().closed
        XCTAssertFalse(file.readable)
        XCTAssertEqual(file.what, "a Monero signed transaction set")
        XCTAssertTrue(file.transactions.isEmpty)
        /* Named, and with a reason. The whole argument for this branch is that
         * saying which file it is beats a blank refusal. */
        XCTAssertTrue(try XCTUnwrap(file.problem).contains("no reader"))
    }

    /// Amounts arrive formatted, and there is nothing on this type to compute
    /// one from. A raw piconero field would be an invitation to divide.
    func testCarriesNoRawAmountToDoArithmeticOn() throws {
        let tx = try XCTUnwrap(try load().opened.transactions.first)
        XCTAssertFalse(tx.payingFormatted.contains("000000000000"))
        XCTAssertEqual(Mirror(reflecting: tx).children.compactMap { $0.label }.filter {
            $0 == "paying" || $0 == "fee" || $0 == "spending"
        }, [])
    }

    /// The property the screen rests on, asserted where a compiler can see it.
    ///
    /// `MoneroSummary` carries a `digest` and a `randomBytes`, because
    /// something downstream signs it. This type carries neither, because
    /// nothing downstream does, and a reflection over its fields is the way to
    /// say so in a test rather than in a comment.
    func testHasNothingASignatureCouldBeBuiltFrom() throws {
        let labels = Mirror(reflecting: try load().opened).children.compactMap(\.label)
        XCTAssertFalse(labels.contains("digest"))
        XCTAssertFalse(labels.contains("randomBytes"))
        XCTAssertFalse(labels.contains("signable"))
    }
}
