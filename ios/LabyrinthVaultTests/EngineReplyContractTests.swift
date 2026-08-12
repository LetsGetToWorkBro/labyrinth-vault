//  EngineReplyContractTests.swift
//  The boundary where untrusted output becomes typed values, under a test for
//  the first time.
//
//  This code shipped inside Engine.swift, which imports JavaScriptCore and so
//  could only ever be parsed off Xcode. Nothing here needed JavaScriptCore; it
//  was on the wrong side of a line drawn for an unrelated reason. The rule it
//  holds is worth stating plainly, because it is the kind of thing that looks
//  like ordering and is actually a security property:
//
//  **A refusal is read before a payload.** `src/bridge/host.ts` answers on one
//  channel with either `{ok:false, problem, code?}` or a result. Decode the
//  payload first and a refusal whose shape happens to satisfy the expected
//  type is read as a success, and a screen renders an answer to a question the
//  vault declined to answer.

import XCTest
@testable import LabyrinthVaultCore

final class EngineReplyContractTests: XCTestCase {

    // MARK: - The ordering rule

    func testRefusalIsReadBeforePayload() throws {
        /* The trap, made concrete. Every field of Sign is optional except
         * `signed`, so a refusal that happened to carry a number would decode
         * cleanly as a signature that does not exist. The envelope has to win. */
        let refusal = #"{"ok":false,"problem":"The vault is locked.","signed":1}"#
        XCTAssertThrowsError(try decodeReply(refusal) as EngineReply.Sign) { error in
            guard case EngineError.refused(let why) = error else {
                return XCTFail("expected .refused, got \(error)")
            }
            XCTAssertEqual(why, "The vault is locked.")
        }
    }

    func testCodedRefusalKeepsItsCode() throws {
        /* The words on a refusal may be rewritten; the code is what a screen
         * switches on, so losing it turns a handled case into a generic one. */
        let refusal = #"{"ok":false,"problem":"No passcode is set.","code":"no-passcode"}"#
        XCTAssertThrowsError(try decodeReply(refusal) as EngineReply.Create) { error in
            guard case EngineError.refusedAs(let code, let why) = error else {
                return XCTFail("expected .refusedAs, got \(error)")
            }
            XCTAssertEqual(code, "no-passcode")
            XCTAssertEqual(why, "No passcode is set.")
        }
    }

    func testRefusalWithoutAProblemStillRefuses() throws {
        /* A malformed refusal is still a refusal. Falling through to the
         * payload here would be the same bug as not checking at all. */
        XCTAssertThrowsError(try decodeReply(#"{"ok":false}"#) as EngineReply.Unlocked) { error in
            guard case EngineError.refused = error else {
                return XCTFail("expected .refused, got \(error)")
            }
        }
    }

    func testSuccessfulEnvelopeDoesNotBlockAPayload() throws {
        /* The other direction: `ok:true` alongside the payload must not be
         * mistaken for a refusal, or nothing would ever decode. */
        let reply = #"{"ok":true,"unlocked":true}"#
        XCTAssertTrue(try (decodeReply(reply) as EngineReply.Unlocked).unlocked)
    }

    // MARK: - What a failure is called

    func testUndecodableNamesTheTypeAndNotTheJSON() throws {
        /* The JSON came out of the vault and may describe somebody's
         * transaction. An error string is a place text goes to be logged, so
         * the wanted type is named and the payload is not. */
        let wrong = #"{"ok":true,"somethingElse":42}"#
        XCTAssertThrowsError(try decodeReply(wrong) as EngineReply.Sign) { error in
            guard case EngineError.undecodable(let what) = error else {
                return XCTFail("expected .undecodable, got \(error)")
            }
            XCTAssertEqual(what, "Sign")
            XCTAssertFalse(what.contains("42"))
        }
    }

    func testGarbageIsUndecodableRatherThanACrash() throws {
        for junk in ["", "null", "[]", "{", "not json at all", #"{"ok":"maybe"}"#] {
            XCTAssertThrowsError(try decodeReply(junk) as EngineReply.Sign, junk)
        }
    }

    // MARK: - The shapes themselves

    func testSignReplyReadsWhatTheHostSends() throws {
        let json = #"{"signed":2,"txid":"abc123","frames":["ur:a","ur:b"]}"#
        let reply: EngineReply.Sign = try decodeReply(json)
        XCTAssertEqual(reply.signed, 2)
        XCTAssertEqual(reply.txid, "abc123")
        XCTAssertEqual(reply.frames, ["ur:a", "ur:b"])
    }

    func testSignReplyToleratesTheOptionalHalvesBeingAbsent() throws {
        /* A partially signed PSBT has no txid yet. Absent is not zero and not
         * an error; it is a transaction that is not finished. */
        let reply: EngineReply.Sign = try decodeReply(#"{"signed":1}"#)
        XCTAssertEqual(reply.signed, 1)
        XCTAssertNil(reply.txid)
        XCTAssertNil(reply.frames)
    }

    func testExportReplyAllowsAMoneroAccountWithNoZpub() throws {
        /* One reply shape serves both chains: Monero exports an address and
         * has no account key, so the optional is load-bearing rather than
         * defensive. */
        let reply: EngineReply.Export = try decodeReply(#"{"frames":["ur:a"],"account":{}}"#)
        XCTAssertNil(reply.account.zpub)
        XCTAssertEqual(reply.frames, ["ur:a"])
    }

    func testKeyImagesAndMoneroSignAreEquatable() throws {
        /* Both are carried by `Route`, which is Equatable because the screens
         * compare routes for their animation identity. A field added here that
         * is not Equatable makes the route enum uncompilable, so this is a
         * check that the reason is still satisfied. */
        let a: EngineReply.KeyImages = try decodeReply(#"{"answered":2,"refused":0,"frames":["x"]}"#)
        let b: EngineReply.KeyImages = try decodeReply(#"{"answered":2,"refused":0,"frames":["x"]}"#)
        XCTAssertEqual(a, b)

        let one: EngineReply.MoneroSign = try decodeReply(
            #"{"txid":"t","network":"mainnet","keyImages":["k"],"frames":["f"]}"#)
        let two: EngineReply.MoneroSign = try decodeReply(
            #"{"txid":"t","network":"mainnet","keyImages":["k"],"frames":["f"]}"#)
        XCTAssertEqual(one, two)
    }

    func testSelfTestReplyCarriesEveryCheckByName() throws {
        /* The launch gate renders these, and a check that decoded without its
         * name would be a failure nobody could act on. */
        let json = """
        {"passed":false,"checks":[
          {"name":"argon2id","proves":"key stretching","ok":true,"detail":"RFC 9106"},
          {"name":"bip84","proves":"address derivation","ok":false,"detail":"vector 2"}
        ]}
        """
        let reply: EngineReply.SelfTest = try decodeReply(json)
        XCTAssertFalse(reply.passed)
        XCTAssertEqual(reply.checks.map(\.name), ["argon2id", "bip84"])
        XCTAssertEqual(reply.checks.map(\.id), ["argon2id", "bip84"])
        XCTAssertEqual(reply.checks.filter { !$0.ok }.map(\.detail), ["vector 2"])
    }

    func testScanReplyReadsProgressAndProblemsAlike() throws {
        let partial: EngineReply.Scan = try decodeReply(#"{"have":3,"total":8,"format":"ur"}"#)
        XCTAssertEqual(partial.have, 3)
        XCTAssertEqual(partial.total, 8)
        XCTAssertNil(partial.problem)

        let bad: EngineReply.Scan = try decodeReply(
            #"{"have":0,"total":0,"problem":"that is not a transaction"}"#)
        XCTAssertEqual(bad.problem, "that is not a transaction")
    }

    // MARK: - The error vocabulary

    func testEveryErrorSaysSomethingAPersonCanActOn() {
        /* Not a style rule: these strings are the whole of what a person sees
         * when the vault refuses, and an empty one is a dead end on screen. */
        let errors: [EngineError] = [
            .bundleMissing,
            .bundleTampered("deadbeefdeadbeefdeadbeef"),
            .bundleFailed("no context"),
            .versionMismatch(2, 3),
            .refused("The vault is locked."),
            .refusedAs(code: "no-passcode", why: "No passcode is set."),
            .undecodable("Sign"),
        ]
        for error in errors {
            let text = error.errorDescription ?? ""
            XCTAssertFalse(text.isEmpty, "\(error) has no sentence")
        }
    }

    func testTamperedBundleDoesNotPrintTheWholeDigest() {
        /* A truncated digest is enough to compare against a known good one and
         * short enough to read off a screen. */
        let digest = String(repeating: "a", count: 64)
        let text = EngineError.bundleTampered(digest).errorDescription ?? ""
        XCTAssertTrue(text.contains(String(repeating: "a", count: 16)))
        XCTAssertFalse(text.contains(digest))
    }
}
