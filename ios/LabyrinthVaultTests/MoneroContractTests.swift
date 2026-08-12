//  MoneroContractTests.swift
//  Swift decoding what TypeScript actually produced, Monero edition.
//
//  Same posture as WireContractTests: the fixture comes from the real
//  `moneroToWire` via scripts/emit-swift-fixtures.mjs, and `Decodable` does
//  the comparing. A renamed field, an Int that became a String, a dropped
//  `dummy` flag — each fails here the way it would fail on a phone.

import XCTest
// Two module names for one set of sources. Under `swift test` these files are
// the `LabyrinthVaultCore` SwiftPM target; under Xcode the same sources are
// compiled straight into the app, where the module is `LabyrinthVault`. Both
// runs matter and ios/README.md says why.
#if canImport(LabyrinthVaultCore)
@testable import LabyrinthVaultCore
#else
@testable import LabyrinthVault
#endif

final class MoneroContractTests: XCTestCase {

    private struct Fixture: Decodable {
        let note: String
        let summary: MoneroSummary
    }

    private func load() throws -> MoneroSummary {
        guard let url = FixtureBundle.url("monero-summary") else {
            XCTFail("monero-summary.json is not in this target's resources")
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url)).summary
    }

    func testDecodesWhatTheEngineProduces() throws {
        let summary = try load()
        XCTAssertEqual(summary.network, "mainnet")
        XCTAssertEqual(summary.ringSize, 16)
        XCTAssertEqual(summary.inputCount, 1)
        XCTAssertEqual(summary.outputs.count, 3)
        XCTAssertFalse(summary.digest.isEmpty)
        XCTAssertGreaterThan(summary.randomBytes, 0)
    }

    /// The classification the screen builds its zones from: the payee list
    /// excludes both the change and the consensus-padding dummy, so the one
    /// address a person must read is the one address shown as a recipient.
    func testPayeeClassificationExcludesChangeAndPadding() throws {
        let summary = try load()
        XCTAssertEqual(summary.paid.count, 1)
        XCTAssertFalse(summary.paid[0].change)
        XCTAssertFalse(summary.paid[0].dummy)
        XCTAssertEqual(summary.paid[0].amountFormatted, "0.6")
        XCTAssertEqual(summary.returning.count, 1)
        XCTAssertTrue(summary.returning[0].change)
    }

    /// Amounts arrive formatted; nothing in Swift divides by a trillion, and
    /// this is the assertion that keeps it that way.
    func testAmountsArriveFormatted() throws {
        let summary = try load()
        XCTAssertEqual(summary.payingFormatted, "0.6")
        XCTAssertEqual(summary.feeFormatted, "0.00072")
        XCTAssertEqual(summary.paying, "600000000000")
        XCTAssertEqual(summary.fee, "720000000")
    }
}
