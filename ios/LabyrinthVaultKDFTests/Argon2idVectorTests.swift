//  Argon2idVectorTests.swift
//  Neither implementation is allowed to be the oracle for the other.
//
//  This runs the native derivation against test/fixtures/primitives.json — the
//  same file test/primitives.test.ts runs the TypeScript against — and those
//  vectors come from argon2-cffi, which wraps the Argon2 reference C. So both
//  sides are pinned to a third thing that has never seen this repository.
//
//  Step 2 of the port in docs/native-primitives.md, and it comes before any
//  key material moves, because a KDF that agrees with our own JavaScript and
//  with nothing else has proved only that we are consistently wrong.

import XCTest
@testable import LabyrinthVaultKDF

final class Argon2idVectorTests: XCTestCase {
    private struct Vector: Decodable {
        let password: String
        let salt: String
        let t: Int
        let m: Int
        let p: Int
        let dkLen: Int
        let key: String
    }

    private struct Fixture: Decodable { let argon2id: [Vector] }

    private func vectors() throws -> [Vector] {
        guard let url = FixtureBundle.url("primitives") else {
            XCTFail("primitives.json is not in this target's resources")
            return []
        }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url)).argon2id
    }

    private func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// Every vector, with nothing skipped and nothing refused.
    ///
    /// The libsodium version of this could not express two of them and had to
    /// assert refusals instead. The reference C has neither limitation, which
    /// is the whole reason it is the one vendored: a native path that refused
    /// work the format permits would have needed a fallback nobody could see
    /// being taken.
    func testAgreesWithTheReferenceImplementation() throws {
        let all = try vectors()
        XCTAssertGreaterThanOrEqual(all.count, 3, "the fixture lost vectors")

        for (i, v) in all.enumerated() {
            let derived = try Argon2id.deriveKey(passphrase: Array(v.password.utf8),
                                                 salt: Array(v.salt.utf8),
                                                 t: v.t, m: v.m, p: v.p, dkLen: v.dkLen)
            XCTAssertEqual(hex(derived), v.key,
                           "vector \(i) (t=\(v.t) m=\(v.m) p=\(v.p) salt=\(v.salt.utf8.count)B) does not match the reference")
        }
    }

    /// The two shapes libsodium could not compute, checked directly rather
    /// than only through whichever vectors happen to be in the fixture.
    func testComputesWhatTheFormatPermitsAndLibsodiumCouldNot() throws {
        // A salt that is not 16 bytes. crypto_pwhash could not take one.
        let odd = try Argon2id.deriveKey(passphrase: Array("correct horse battery staple".utf8),
                                         salt: Array("sixteen byte salt".utf8),
                                         t: 3, m: 8192, p: 1, dkLen: 32)
        XCTAssertEqual(hex(odd), "2bfe6ca0ec5cbc6ce9006453956327aee67eea39a4c021bb0454d614bf25ca5b")

        /* Parallelism above one, which KDF_LIMITS permits up to 4 and
         * crypto_pwhash fixed at 1. Checked as self-consistency rather than
         * against a published vector: what matters here is that p changes the
         * answer and is therefore actually reaching the algorithm. A wrapper
         * that silently ignored p would return the p=1 key, which is exactly
         * the failure that would have made a vault unopenable. */
        let salt = Array("labyrinth vault!".utf8)
        let pass = Array("correct horse battery staple".utf8)
        let one = try Argon2id.deriveKey(passphrase: pass, salt: salt, t: 3, m: 65536, p: 1, dkLen: 32)
        let four = try Argon2id.deriveKey(passphrase: pass, salt: salt, t: 3, m: 65536, p: 4, dkLen: 32)
        XCTAssertNotEqual(hex(one), hex(four), "p is not reaching the algorithm")
        XCTAssertEqual(hex(one), "a7c80b67d54485f58415a60b7c6d52faf6eddccc56dee04e0d8a1f7c0fe1babe")
    }

    /// The parameters the app actually seals with, called out by name.
    ///
    /// The two older vectors in the fixture use neither `DEFAULT_KDF` nor a
    /// salt of `SALT_BYTES`, so before this one was added the shipping
    /// configuration was pinned by nothing outside this repository.
    func testShippingParametersMatchTheReference() throws {
        let key = try Argon2id.deriveKey(
            passphrase: Array("correct horse battery staple".utf8),
            salt: Array("labyrinth vault!".utf8),
            t: 3, m: 65536, p: 1, dkLen: 32)
        XCTAssertEqual(hex(key),
                       "a7c80b67d54485f58415a60b7c6d52faf6eddccc56dee04e0d8a1f7c0fe1babe")
    }

    func testRefusesNonsenseRatherThanGuessing() {
        let salt = [UInt8](repeating: 7, count: 16)
        let pass = Array("passphrase".utf8)

        for (label, call) in [
            ("t", { try Argon2id.deriveKey(passphrase: pass, salt: salt, t: 0, m: 8192, p: 1, dkLen: 32) }),
            ("m", { try Argon2id.deriveKey(passphrase: pass, salt: salt, t: 3, m: 0, p: 1, dkLen: 32) }),
            ("p", { try Argon2id.deriveKey(passphrase: pass, salt: salt, t: 3, m: 8192, p: 0, dkLen: 32) }),
            ("salt", { try Argon2id.deriveKey(passphrase: pass, salt: [], t: 3, m: 8192, p: 1, dkLen: 32) }),
            ("passphrase", { try Argon2id.deriveKey(passphrase: [], salt: salt, t: 3, m: 8192, p: 1, dkLen: 32) }),
        ] as [(String, () throws -> [UInt8])] {
            XCTAssertThrowsError(try call(), "\(label) was accepted") {
                XCTAssertEqual($0 as? Argon2id.Failure, .parameterOutOfRange(label))
            }
        }
    }

    /// The C is asked for a memory size it cannot have, and the sentence it
    /// gives back is passed along rather than replaced with a guess.
    func testCarriesTheLibrarysOwnReasonOutwards() {
        XCTAssertThrowsError(try Argon2id.deriveKey(passphrase: Array("passphrase".utf8),
                                                    salt: [UInt8](repeating: 7, count: 16),
                                                    t: 3, m: 8, p: 64, dkLen: 32)) { error in
            guard case .refused(_, let reason)? = error as? Argon2id.Failure else {
                return XCTFail("expected a refusal carrying the library's reason, got \(error)")
            }
            XCTAssertFalse(reason.isEmpty)
        }
    }
}

/// The KDF test target carries its own copy of the fixture lookup: it is a
/// package-only target and cannot see the app test target's helper.
enum FixtureBundle {
    static func url(_ name: String) -> URL? {
        Bundle.module.url(forResource: name, withExtension: "json")
    }
}
