//  ApprovalDestinationTests.swift
//  The one line the approval screen puts next to TO.
//
//  It lived in `ApproveView` as four branches, on the last screen before a
//  signature, deciding what a person reads at the moment they attest "THE
//  DESTINATION". That file imports SwiftUI, so it is parsed for syntax and
//  type-checked by nobody; `TxSummary` compiles here and these run on every
//  push. Moving it turned up a branch nobody had thought about, which is the
//  argument for moving the rest.
//
//  Built by decoding JSON rather than by constructing the struct, because
//  `TxSummary` is `Decodable` and has no memberwise initializer. That is not a
//  workaround: it is the same door the engine's replies come through, so a
//  field that stopped decoding fails here too.

import XCTest
#if canImport(LabyrinthVaultCore)
@testable import LabyrinthVaultCore
#else
@testable import LabyrinthVault
#endif

final class ApprovalDestinationTests: XCTestCase {

    /// A summary carrying exactly these outputs and nothing else worth reading.
    private func summary(outputs: [(address: String?, amount: String, mine: Bool)]) throws -> TxSummary {
        let encoded = outputs.enumerated().map { index, output -> String in
            let address = output.address.map { "\"\($0)\"" } ?? "null"
            return """
            {"position": \(index), "address": \(address), "scriptHex": "00", \
            "amount": "\(output.amount)", "mine": \(output.mine), "path": null}
            """
        }.joined(separator: ",")

        let json = """
        {
          "ok": true, "problem": null, "digest": "abcd", "walletId": "w",
          "inputs": [], "outputs": [\(encoded)],
          "spending": "1", "leaving": "1", "returning": "0", "yourNet": "1",
          "fee": "0.0001", "feeRate": "1", "vsize": "~110", "feeShare": "0.01%",
          "warnings": [], "signable": true, "refusal": null
        }
        """
        return try JSONDecoder().decode(TxSummary.self, from: Data(json.utf8))
    }

    func testOnePayeeShowsTheTailTheEarlierScreensShowedInFull() throws {
        let tx = try summary(outputs: [
            (address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", amount: "0.01", mine: false),
            (address: "bc1qchange00000000000000000000000000000000", amount: "0.5", mine: true),
        ])
        XCTAssertEqual(tx.approvalDestination, "…gtzzwf5mdq")
    }

    func testNoPayeesIsASelfSend() throws {
        /* Every output coming back is a consolidation. "SELF" is the true
         * answer and the count would be "0 RECIPIENTS". */
        let tx = try summary(outputs: [
            (address: "bc1qchange00000000000000000000000000000000", amount: "0.5", mine: true),
        ])
        XCTAssertEqual(tx.approvalDestination, "SELF")
    }

    func testSeveralPayeesAreCountedRatherThanSummarized() throws {
        /* No single tail can stand for two destinations, and showing one of
         * them is how money leaves to an address nobody approving it saw. */
        let tx = try summary(outputs: [
            (address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", amount: "0.01", mine: false),
            (address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", amount: "0.02", mine: false),
        ])
        XCTAssertEqual(tx.approvalDestination, "2 RECIPIENTS")
    }

    func testASoleDataOutputSaysItPaysNobody() throws {
        /* The branch that was wrong. A single payee with no readable address
         * fell through to the count and printed "1 RECIPIENTS", which is
         * ungrammatical and, worse, reads like an ordinary payment to one
         * person.
         *
         * Reachable exactly once: `psbt.ts` makes an unreadable output fatal
         * when it carries money, so approval cannot be reached for those, and
         * merely notes it when it carries none. So this is a transaction whose
         * only non-change output is a data carrier. */
        let tx = try summary(outputs: [
            (address: nil, amount: "0", mine: false),
            (address: "bc1qchange00000000000000000000000000000000", amount: "0.5", mine: true),
        ])
        XCTAssertEqual(tx.approvalDestination, "NOBODY · DATA OUTPUT")
    }

    func testItNeverSaysOneRecipients() throws {
        /* The grammar is the tell. Any shape that produces "1 RECIPIENTS" is a
         * shape where the single-payee branch was skipped without anybody
         * deciding what should be said instead. */
        for output in [(address: String?.none, amount: "0", mine: false),
                       (address: String?.some("bc1qexample000000000000000000000000000000"), amount: "1", mine: false)] {
            let tx = try summary(outputs: [output])
            XCTAssertNotEqual(tx.approvalDestination, "1 RECIPIENTS")
            XCTAssertFalse(tx.approvalDestination.hasPrefix("1 "),
                           "a single payee is being counted rather than named: \(tx.approvalDestination)")
        }
    }

    func testChangeIsNeverMistakenForADestination() throws {
        /* `payees` is `!mine`, and the whole reason this screen can show a
         * tail at all is that change has been excluded from it. A regression
         * that counted change would show a person their own address as the
         * place their money is going, which reads as safe. */
        let tx = try summary(outputs: [
            (address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", amount: "0.01", mine: false),
            (address: "bc1qchange10000000000000000000000000000000", amount: "0.2", mine: true),
            (address: "bc1qchange20000000000000000000000000000000", amount: "0.3", mine: true),
        ])
        XCTAssertEqual(tx.approvalDestination, "…gtzzwf5mdq")
        XCTAssertEqual(tx.change.count, 2)
    }
}
