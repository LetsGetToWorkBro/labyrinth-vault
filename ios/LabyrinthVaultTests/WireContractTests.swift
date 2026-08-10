//  WireContractTests.swift
//  Swift decoding what TypeScript actually produced.
//
//  `TxSummary` is a hand-written Swift mirror of `WireSummary` in
//  src/bridge/summary.ts. Nothing but a test connects the two, and until this
//  file that test was a pair of regular expressions comparing field names and
//  mapped types across two languages — crude, and crude because nothing in the
//  repository could compile Swift.
//
//  This is the stronger version of the same check. The fixtures are generated
//  by scripts/emit-swift-fixtures.mjs from real PSBTs, through the real
//  reader, through the real `toWire`. `Decodable` then does the comparing:
//  a renamed field, a nullable that stopped being nullable, a number that
//  became a string — each of those fails here in exactly the way it would fail
//  on a phone, and none of them needs the shape described a second time.
//
//  Two fixtures, and the second is the important one. A model that decodes the
//  happy case and falls over on a refusal puts an error screen in front of
//  somebody at the precise moment the app has something important to say.

import XCTest
@testable import LabyrinthVaultCore

final class WireContractTests: XCTestCase {

    private struct Fixtures: Decodable {
        let note: String
        let ok: TxSummary
        let refused: TxSummary
    }

    private func load() throws -> Fixtures {
        guard let url = Bundle.module.url(forResource: "summary", withExtension: "json") else {
            XCTFail("summary.json is not in this target's resources")
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(Fixtures.self, from: Data(contentsOf: url))
    }

    /// The whole point: this decoding either works or the app is broken.
    func testBothSummariesDecode() throws {
        let fixtures = try load()
        XCTAssertTrue(fixtures.note.contains("real reader"))
        XCTAssertEqual(fixtures.ok.outputs.count, 2)
        XCTAssertEqual(fixtures.refused.outputs.count, 2)
    }

    /// An ordinary payment, read the way the screen will read it.
    func testTheOrdinaryPaymentSaysWhatItPays() throws {
        let tx = try load().ok

        XCTAssertTrue(tx.ok)
        XCTAssertNil(tx.problem)
        XCTAssertNil(tx.refusal)
        XCTAssertTrue(tx.signable)
        XCTAssertTrue(tx.warnings.filter(\.fatal).isEmpty)

        // One payee, one change output, and the screen can tell them apart
        // because the reader re-derived the change rather than believing it.
        XCTAssertEqual(tx.payees.count, 1)
        XCTAssertEqual(tx.change.count, 1)
        XCTAssertFalse(tx.paysSeveral)
        XCTAssertFalse(tx.hasUnreadableOutput)

        // Amounts arrive formatted. Nothing on this side divides by 10^8.
        XCTAssertEqual(tx.leaving, "0.00482731")
        XCTAssertEqual(tx.returning, "0.00317891")
        XCTAssertEqual(tx.spending, "0.00800764")
        XCTAssertNotNil(tx.fee)
        XCTAssertNotNil(tx.feeRate)
        XCTAssertFalse(tx.vsize.isEmpty)
        XCTAssertFalse(tx.digest.isEmpty)
        XCTAssertFalse(tx.walletId.isEmpty)
    }

    /// The change-swap attack, decoded.
    func testTheRefusalDecodesAndTheScreenHasWordsForIt() throws {
        let tx = try load().refused

        XCTAssertFalse(tx.signable)
        XCTAssertEqual(tx.refusal, "output-path-mismatch")

        /* The money the attack tries to disguise as change is counted as
         * leaving, because it is leaving. If this ever read 0.00045 as
         * "returning", the screen would be lying in the attacker's favour. */
        XCTAssertEqual(tx.change.count, 0)
        XCTAssertEqual(tx.payees.count, 2)
        XCTAssertTrue(tx.paysSeveral)

        // And the code maps onto a screen that says what happened.
        let refusal = Refusal(code: tx.refusal!)
        XCTAssertEqual(refusal, .changeMismatch)
        if case .unrecognised = refusal {
            XCTFail("the reader's own fatal code has no case in Refusal")
        }
    }

    /// Every fatal code the reader can raise has words on this side.
    ///
    /// The list is duplicated from src/keys/psbt.ts on purpose: this test
    /// exists to fail when the two drift, and `test/app-wiring.test.ts` fails
    /// if the list here stops covering what psbt.ts actually raises. Two
    /// guards, from opposite directions, because a single one can be satisfied
    /// by editing it.
    func testEveryFatalCodeHasWords() {
        let codes = [
            "output-path-mismatch",
            "unknown-input-value",
            "unusual-sighash",
            "duplicate-input",
            "opaque-output",
            "watch-only",
            "unreadable",
            "monero-file-unsupported",
        ]
        for code in codes {
            let refusal = Refusal(code: code)
            if case .unrecognised = refusal {
                XCTFail("\(code) falls through to unrecognised")
            }
            XCTAssertFalse(refusal.headline.isEmpty, code)
            XCTAssertFalse(refusal.why.isEmpty, code)
            XCTAssertFalse(refusal.detail.isEmpty, code)
            XCTAssertFalse(refusal.findings.isEmpty, code)
        }
    }

    /// An unknown code is still a refusal. This is the case that must never
    /// quietly become "carry on".
    func testAnUnknownCodeStillRefuses() {
        let refusal = Refusal(code: "something-invented-in-2031")
        guard case .unrecognised(let carried) = refusal else {
            return XCTFail("an unknown code did not land in the catch-all")
        }
        XCTAssertEqual(carried, "something-invented-in-2031")
        XCTAssertFalse(refusal.detail.isEmpty)
        // Every refusal ends by saying nothing was signed.
        XCTAssertTrue(refusal.findings.contains { $0.0 == "NO SIGNATURE PRODUCED" })
    }

    /// No refusal screen may be blank, and every one must end the same way.
    ///
    /// `detail` was a non-exhaustive switch missing five of its nine cases
    /// before this package existed to compile it. The compiler catches that
    /// now; this catches the version where somebody adds a case and returns
    /// an empty string to make it build.
    func testNoRefusalScreenIsEmpty() {
        let all: [Refusal] = [
            .changeMismatch, .unknowableFee, .sighashFlags, .duplicateInput,
            .opaqueOutput, .noKeys, .unreadable, .moneroFile, .digestMismatch,
            .unrecognised("x"),
        ]
        for refusal in all {
            XCTAssertFalse(refusal.headline.contains(where: \.isEmpty))
            XCTAssertFalse(refusal.why.contains(where: \.isEmpty))
            XCTAssertGreaterThan(refusal.detail.count, 40, "\(refusal) has a stub for a detail")
            XCTAssertTrue(
                refusal.findings.contains { $0.0 == "NO SIGNATURE PRODUCED" },
                "\(refusal) does not end by saying nothing was signed"
            )
        }
    }
}
