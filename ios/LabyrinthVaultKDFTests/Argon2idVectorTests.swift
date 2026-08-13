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

    /// Every vector the library can express, and an explicit account of the
    /// ones it cannot.
    func testAgreesWithTheReferenceImplementation() throws {
        var checked = 0
        var unexpressible: [String] = []

        for (i, v) in try vectors().enumerated() {
            let passphrase = Array(v.password.utf8)
            let salt = Array(v.salt.utf8)

            /* Two shapes of vector this library structurally cannot compute:
             * a salt of any length but its own, and any parallelism above one.
             * Rather than skipping those, assert that the refusal happens and
             * happens for the stated reason. A skip proves nothing; a checked
             * refusal proves the fallback in the caller will be reached. */
            guard salt.count == Argon2id.saltBytes else {
                XCTAssertThrowsError(
                    try Argon2id.deriveKey(passphrase: passphrase, salt: salt,
                                           t: v.t, m: v.m, p: v.p, dkLen: v.dkLen),
                    "vector \(i) has a \(salt.count) byte salt and should have been refused"
                ) { error in
                    XCTAssertEqual(error as? Argon2id.Failure,
                                   .saltLength(expected: Argon2id.saltBytes, got: salt.count))
                }
                unexpressible.append("vector \(i): \(salt.count) byte salt")
                continue
            }
            guard v.p == 1 else {
                XCTAssertThrowsError(
                    try Argon2id.deriveKey(passphrase: passphrase, salt: salt,
                                           t: v.t, m: v.m, p: v.p, dkLen: v.dkLen)
                ) { error in
                    XCTAssertEqual(error as? Argon2id.Failure, .unsupportedParallelism(v.p))
                }
                unexpressible.append("vector \(i): p=\(v.p)")
                continue
            }

            let derived = try Argon2id.deriveKey(passphrase: passphrase, salt: salt,
                                                 t: v.t, m: v.m, p: v.p, dkLen: v.dkLen)
            XCTAssertEqual(hex(derived), v.key,
                           "vector \(i) (t=\(v.t) m=\(v.m) p=\(v.p)) does not match the reference")
            checked += 1
        }

        /* Without this the suite would go green on a fixture where every
         * vector had become unexpressible, which is a test that checks
         * nothing while reporting success. */
        XCTAssertGreaterThanOrEqual(checked, 1,
            "no vector was actually derived; only refusals were exercised. Unexpressible: \(unexpressible)")
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

    func testSaltLengthIsTheOneTheFormatUses() {
        // src/keys/seal.ts: SALT_BYTES = 16. If either side ever moves, the
        // native path stops being reachable and this says so immediately.
        XCTAssertEqual(Argon2id.saltBytes, 16)
    }

    func testRefusesRatherThanApproximates() throws {
        let salt = [UInt8](repeating: 7, count: Argon2id.saltBytes)
        let pass = Array("passphrase".utf8)

        XCTAssertThrowsError(try Argon2id.deriveKey(passphrase: pass, salt: salt,
                                                    t: 3, m: 8192, p: 2, dkLen: 32)) {
            XCTAssertEqual($0 as? Argon2id.Failure, .unsupportedParallelism(2))
        }
        XCTAssertThrowsError(try Argon2id.deriveKey(passphrase: pass,
                                                    salt: [UInt8](repeating: 7, count: 8),
                                                    t: 3, m: 8192, p: 1, dkLen: 32)) {
            XCTAssertEqual($0 as? Argon2id.Failure, .saltLength(expected: 16, got: 8))
        }
        XCTAssertThrowsError(try Argon2id.deriveKey(passphrase: pass, salt: salt,
                                                    t: 0, m: 8192, p: 1, dkLen: 32)) {
            XCTAssertEqual($0 as? Argon2id.Failure, .parameterOutOfRange("t"))
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
