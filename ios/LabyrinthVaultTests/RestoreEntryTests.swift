//  RestoreEntryTests.swift
//  What the restore stage may say about two phrases being typed.
//
//  The stage itself is SwiftUI and is type-checked by nobody until Xcode
//  opens. Everything it decides lives in `RestoreEntry`, which compiles here,
//  so these run on every push. See that file's header for what it decides and
//  what it deliberately leaves to the engine.

import XCTest
#if canImport(LabyrinthVaultCore)
@testable import LabyrinthVaultCore
#else
@testable import LabyrinthVault
#endif

final class RestoreEntryTests: XCTestCase {

    /// A real vault's Bitcoin phrase: twelve words, the published BIP39 vector.
    private let bitcoin = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

    /// Twenty-five Monero words. The content is irrelevant to every test here,
    /// which is the point being made: this file counts and the engine judges.
    private let monero = (1...25).map { "word\($0)" }.joined(separator: " ")

    // MARK: - Counting

    func testCountsWordsHoweverSomebodyTypedThem() {
        /* Retyping twelve words from paper on a phone produces double spaces,
         * a newline where the paper wrapped, and a capital on the first word
         * because that is what the keyboard does. All of it is one phrase. */
        let messy = "  Abandon  abandon\tabandon\nabandon abandon abandon "
            + "abandon abandon abandon abandon abandon ABOUT  \n"
        XCTAssertEqual(RestoreEntry.count(messy), 12)
        XCTAssertEqual(RestoreEntry.normalize(messy), bitcoin)
    }

    func testAnEmptyFieldIsZeroAndNotOne() {
        /* Splitting "" on whitespace yields one empty piece in most languages,
         * and a field that counted itself as holding one word would tell
         * somebody they had started typing. */
        for blank in ["", " ", "\n", "\t\t", "   \n  "] {
            XCTAssertEqual(RestoreEntry.count(blank), 0, "\(blank.debugDescription) counted as typed")
            XCTAssertEqual(RestoreEntry.read(bitcoin: blank, monero: blank).bitcoin, .empty)
        }
    }

    func testNormalizingCannotChangeWhichWordsThoseAre() {
        /* The bound this file's header claims: lowercasing and collapsing
         * whitespace cannot turn one valid phrase into a different valid one,
         * because both wordlists are lowercase ASCII. Held by checking the
         * words survive as words. */
        let normalized = RestoreEntry.normalize("  ONE   two\tThree  ")
        XCTAssertEqual(normalized.components(separatedBy: " "), ["one", "two", "three"])
    }

    // MARK: - What the lever may do

    func testTheLeverNeedsBothPhrasesAtTheirOwnLength() {
        XCTAssertTrue(RestoreEntry.read(bitcoin: bitcoin, monero: monero).mayRestore)

        /* One field right and the other not is the state this exists for. A
         * restore missing a phrase cannot rebuild the secret, and the engine
         * refuses it, but a lever that offered the trip is a lever that has
         * already wasted somebody's passphrase entry. */
        XCTAssertFalse(RestoreEntry.read(bitcoin: bitcoin, monero: "").mayRestore)
        XCTAssertFalse(RestoreEntry.read(bitcoin: "", monero: monero).mayRestore)
        XCTAssertFalse(RestoreEntry.read(bitcoin: "", monero: "").mayRestore)
    }

    func testAPhraseOneWordShortIsNotOffered() {
        let short = bitcoin.components(separatedBy: " ").dropLast().joined(separator: " ")
        let reading = RestoreEntry.read(bitcoin: short, monero: monero)
        XCTAssertEqual(reading.bitcoin, .short(have: 11, want: 12))
        XCTAssertFalse(reading.mayRestore)
    }

    func testTheTwoPhrasesInTheWrongFieldsAreBothWrongLengths() {
        /* The likeliest paste mistake, and the one where saying "check that
         * each phrase is in its own field" saves somebody a real minute. */
        let reading = RestoreEntry.read(bitcoin: monero, monero: bitcoin)
        XCTAssertEqual(reading.bitcoin, .over(have: 25, want: 12))
        XCTAssertEqual(reading.monero, .short(have: 12, want: 25))
        XCTAssertFalse(reading.mayRestore)
    }

    func testTwentyFourBitcoinWordsAreOverLengthRatherThanReady() {
        /* Twenty-four words are a valid BIP39 seed and are not a vault's:
         * `SECRET_BYTES` fixes the Bitcoin half at sixteen bytes. The engine
         * refuses them by name; this is the screen not offering the trip. */
        let long = Array(repeating: "abandon", count: 24).joined(separator: " ")
        XCTAssertEqual(RestoreEntry.read(bitcoin: long, monero: monero).bitcoin, .over(have: 24, want: 12))
    }

    // MARK: - What it carries

    func testWhatWasCountedIsWhatWouldBeSent() {
        /* A person cannot be shown a count for one string and have a different
         * one restored, which is the whole reason the reading carries text at
         * all rather than the view sending its own raw fields. */
        let messy = "  Abandon  abandon abandon abandon abandon abandon "
            + "abandon abandon abandon abandon abandon ABOUT "
        let reading = RestoreEntry.read(bitcoin: messy, monero: monero)
        XCTAssertEqual(reading.bitcoinWords, bitcoin)
        XCTAssertEqual(RestoreEntry.count(reading.bitcoinWords), 12)
        XCTAssertEqual(reading.moneroWords, monero)
    }

    // MARK: - What it says

    func testItSaysNothingAtAllUntilSomebodyHasTyped() {
        /* "0 of 12" on an untouched field is a screen complaining about a
         * person for opening it. */
        XCTAssertNil(RestoreEntry.hint(for: .empty, chain: "Bitcoin"))
        XCTAssertNil(RestoreEntry.hint(for: .ready, chain: "Bitcoin"))
    }

    func testItCountsUpRatherThanRefusing() {
        XCTAssertEqual(RestoreEntry.hint(for: .short(have: 7, want: 12), chain: "Bitcoin"),
                       "7 of 12 Bitcoin words.")
    }

    func testTooManyWordsSaysWhatToCheck() {
        let hint = RestoreEntry.hint(for: .over(have: 25, want: 12), chain: "Bitcoin")
        XCTAssertNotNil(hint)
        XCTAssertTrue(hint!.contains("its own field"), "the over-length hint does not name the likely cause")
    }

    func testEveryHintIsASentenceRatherThanACode() {
        /* House rule, and the reason a person can act on a refusal here. */
        let fields: [RestoreEntry.Field] = [
            .short(have: 1, want: 12), .over(have: 26, want: 25),
        ]
        for field in fields {
            let hint = RestoreEntry.hint(for: field, chain: "Monero")
            XCTAssertNotNil(hint)
            XCTAssertTrue(hint!.hasSuffix("."), "\(field) reads as a fragment: \(hint!)")
            XCTAssertFalse(hint!.contains("—"), "em dash in copy a person reads: \(hint!)")
        }
    }
}
