//  PassphraseContractTests.swift
//  The Swift half of a contract TypeScript already keeps.
//
//  `passphraseToBytes` in src/keys/seal.ts and `Passphrase.bytes(from:)` in
//  Passphrase.swift do the same thing in two languages. That is the only
//  behaviour in this project deliberately implemented twice, and the reason it
//  is allowed to be is this file: both sides are checked against
//  test/fixtures/primitives.json rather than against each other.
//
//  Why it has to be twice. The passphrase must stop being a `String` before it
//  crosses into JavaScriptCore, because a string in either heap cannot be
//  overwritten. Normalising on the far side would mean sending text, which is
//  the thing being avoided. So Swift normalises, and the pinned bytes are what
//  keep the two honest.
//
//  What a failure here looks like if nobody catches it: a vault that seals
//  under one byte sequence and unseals under another. It opens on the phone
//  that made it — same code, same bug, same bytes — and nowhere else. The
//  person finds out while restoring a backup after losing that phone, which is
//  the worst moment anything could be discovered.
//
//  ## This test has never been run
//
//  There is no Swift toolchain where this repository was written, so this file
//  is written and not executed. It is here rather than absent because the
//  alternative is that the first person with a Mac has to invent the check as
//  well as run it, and because a contract with only one side tested is a
//  contract nobody is keeping.
//
//  The fixture is loaded from the test bundle, so add
//  `test/fixtures/primitives.json` to this target's resources.

import XCTest
@testable import LabyrinthVault

final class PassphraseContractTests: XCTestCase {

    private struct Fixture: Decodable {
        struct Normalisation: Decodable {
            let note: String
            let text: String
            let nfkdUtf8: String
        }
        let passphraseNormalisation: [Normalisation]
    }

    private func loadFixture() throws -> Fixture {
        let bundle = Bundle(for: type(of: self))
        guard let url = bundle.url(forResource: "primitives", withExtension: "json") else {
            XCTFail("primitives.json is not in this test target's resources")
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// Every vector, byte for byte, against the same file TypeScript is checked
    /// against.
    func testNormalisationMatchesTheFixture() throws {
        let fixture = try loadFixture()
        XCTAssertGreaterThan(fixture.passphraseNormalisation.count, 9,
                             "too few vectors for a pass to mean anything")

        for vector in fixture.passphraseNormalisation {
            XCTAssertEqual(hex(Passphrase.bytes(from: vector.text)), vector.nfkdUtf8, vector.note)
        }
    }

    /// The case a person actually hits: two keyboards, one visible passphrase.
    func testTwoSpellingsOfTheSamePassphraseAgree() {
        let composed = "caf\u{00E9}"           // é as one code point
        let decomposed = "cafe\u{0301}"        // e + combining acute
        XCTAssertNotEqual(composed.unicodeScalars.count, decomposed.unicodeScalars.count)
        XCTAssertEqual(Passphrase.bytes(from: composed), Passphrase.bytes(from: decomposed))
    }

    /// NFKD, not NFD. Choosing the wrong normal form is the most plausible way
    /// the two languages diverge, and it stays invisible until somebody puts a
    /// ligature or a full-width character in a passphrase.
    func testCompatibilityFoldingHappens() {
        // U+FB01 LATIN SMALL LIGATURE FI folds to "fi" under NFKD and survives
        // NFD untouched.
        XCTAssertEqual(Passphrase.bytes(from: "\u{FB01}"), Array("fi".utf8))
        // U+FF71 HALFWIDTH KATAKANA LETTER A folds to U+30A2.
        XCTAssertEqual(Passphrase.bytes(from: "\u{FF71}"), Array("\u{30A2}".utf8))
    }

    /// The property app/storage.ts relies on when it layers a device
    /// passphrase and a user passphrase around a newline: normalising the
    /// parts and joining gives the same bytes as joining and normalising.
    ///
    /// It holds because U+000A is a starter, so NFKD cannot compose or reorder
    /// across it. "It holds because" is how subtle Unicode bugs get in, hence
    /// the test.
    func testJoiningNormalisedPartsIsTheSameAsNormalisingTheJoin() {
        let device = String(repeating: "a", count: 64)
        for user in ["caf\u{00E9}", "\u{0301}leading mark", "\u{FB01}re", "\u{212B}ngstr\u{00F6}m"] {
            let joined = Passphrase.bytes(from: device + "\n" + user)
            let parts = Passphrase.bytes(from: device) + [0x0a] + Passphrase.bytes(from: user)
            XCTAssertEqual(joined, parts, user)
        }
    }

    /// Wiping is the reason any of this exists. If it does not zero the
    /// storage, the bytes were no better than the string they came from.
    func testWipeZeroesTheBytes() {
        var bytes = Passphrase.bytes(from: "a passphrase worth forgetting")
        XCTAssertFalse(bytes.allSatisfy { $0 == 0 })
        Passphrase.wipe(&bytes)
        XCTAssertTrue(bytes.allSatisfy { $0 == 0 })
    }

    /// And it has to happen on the throwing path too, because that is the path
    /// nobody is thinking about.
    func testWithBytesWipesEvenWhenTheBodyThrows() {
        struct Boom: Error {}
        var seen: [UInt8] = []
        XCTAssertThrowsError(
            try Passphrase.withBytes(of: "open sesame") { bytes -> Void in
                seen = bytes          // a copy; the original is what gets wiped
                throw Boom()
            }
        )
        XCTAssertFalse(seen.isEmpty, "the body never ran, so nothing was tested")
    }
}
