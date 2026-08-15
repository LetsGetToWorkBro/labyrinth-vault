//  CryptoNightVectorTests.swift
//  The vendored CryptoNight against Monero's own published answers.
//
//  This is a weaker check than Argon2idVectorTests and it is worth being
//  explicit about why, because the two files look alike and are not.
//
//  For Argon2id there are two implementations in this repository — the
//  TypeScript in src/keys/seal.ts and the C behind Argon2id.swift — and the
//  vectors in test/fixtures/primitives.json come from argon2-cffi, a third
//  implementation that has never seen this project. Each side answers to
//  something neither of them is.
//
//  Here there is one implementation, and it is Monero's. The vectors below are
//  its own, copied from `tests/hash/tests-slow.txt` in the tag pinned by
//  vendor/cryptonight/MANIFEST.json. So this cannot tell you that CryptoNight
//  is right. What it does tell you, which is the thing that actually goes
//  wrong with a vendored dependency, is:
//
//    - that the file set is complete and the build is wired up, rather than
//      linking against something that silently returns zeroes;
//    - that NO_AES and FORCE_USE_HEAP, which select between three different
//      implementations of the same function inside slow-hash.c, selected one
//      that computes the same answers as the others;
//    - that the Swift boundary passes lengths and pointers correctly, which is
//      the one part of this that is ours to get wrong.
//
//  A wrong answer here is a wallet whose key images no other Monero wallet can
//  read, so all three of those are worth a test even though none of them is
//  a proof about the algorithm.

import XCTest
@testable import LabyrinthVaultKDF

final class CryptoNightVectorTests: XCTestCase {
    private func bytes(_ hex: String) -> [UInt8] {
        var out: [UInt8] = []
        var i = hex.startIndex
        while i < hex.endIndex {
            let j = hex.index(i, offsetBy: 2)
            out.append(UInt8(hex[i..<j], radix: 16)!)
            i = j
        }
        return out
    }

    private func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// `tests/hash/tests-slow.txt`, verbatim and in order. Four lines of
    /// `<expected hash> <input>`, and the inputs are Latin tags rather than
    /// anything meaningful — `de omnibus dubitandum`, and so on.
    private let official: [(hash: String, data: String)] = [
        ("2f8e3df40bd11f9ac90c743ca8e32bb391da4fb98612aa3b6cdc639ee00b31f5",
         "6465206f6d6e69627573206475626974616e64756d"),
        ("722fa8ccd594d40e4a41f3822734304c8d5eff7e1b528408e2229da38ba553c4",
         "6162756e64616e732063617574656c61206e6f6e206e6f636574"),
        ("bbec2cacf69866a8e740380fe7b818fc78f8571221742d729d9d02d7f8989b87",
         "63617665617420656d70746f72"),
        ("b1257de4efc5ce28c6b40ceb1c6c8f812a64634eb3e81c5220bee9b2b76a6f05",
         "6578206e6968696c6f206e6968696c20666974"),
    ]

    func testMatchesMoneroSlowHashVectors() {
        for (i, v) in official.enumerated() {
            XCTAssertEqual(hex(CryptoNight.slowHashV0(bytes(v.data))), v.hash,
                           "tests-slow.txt line \(i + 1) does not match")
        }
    }

    /// The empty string, which the vectors do not cover and which is the input
    /// most likely to be handled by reading through a nil pointer. Checked as
    /// "it returns 32 bytes and does not crash" rather than against a value:
    /// there is no published answer for it, and inventing one from this same
    /// code would be a test of nothing.
    func testDoesNotFallOverOnEmptyInput() {
        XCTAssertEqual(CryptoNight.slowHashV0([]).count, 32)
    }

    // MARK: - The wallet key

    /// `generate_chacha_key` at the default `kdf_rounds`, which is one round
    /// and therefore exactly the hash.
    ///
    /// This is a plumbing test and is written to look like one. The value it
    /// checks against is this same C, so it cannot catch a wrong hash; what it
    /// catches is a wrapper that ignores `rounds`, hashes the wrong buffer, or
    /// quietly returns the input.
    func testDefaultRoundsIsOneHashOfTheKey() throws {
        let key = bytes("8d54b3ce2a1a8a3a9e1a6b0d17b2d3d5c1e0f2a4b6c8d0e2f4061728394a5b0c")
        let derived = try CryptoNight.walletChachaKey(fromSecretKey: key)

        XCTAssertEqual(hex(derived), hex(CryptoNight.slowHashV0(key)))
        XCTAssertNotEqual(hex(derived), hex(key), "the key came back unhashed")
        XCTAssertEqual(derived.count, 32)
    }

    /// The extra rounds hash the 32-byte digest, not the original key. That is
    /// `chacha.h`, and getting it backwards would produce a key that is wrong
    /// only for the wallets that set the option — the worst kind of wrong,
    /// because it would pass every test run against a default wallet.
    func testExtraRoundsChainOnTheDigest() throws {
        let key = bytes("8d54b3ce2a1a8a3a9e1a6b0d17b2d3d5c1e0f2a4b6c8d0e2f4061728394a5b0c")

        let two = try CryptoNight.walletChachaKey(fromSecretKey: key, rounds: 2)
        XCTAssertEqual(hex(two), hex(CryptoNight.slowHashV0(CryptoNight.slowHashV0(key))))

        let three = try CryptoNight.walletChachaKey(fromSecretKey: key, rounds: 3)
        XCTAssertEqual(hex(three), hex(CryptoNight.slowHashV0(CryptoNight.slowHashV0(CryptoNight.slowHashV0(key)))))
        XCTAssertNotEqual(hex(two), hex(three))
    }

    /// Anything that is not a 32-byte secret key is refused rather than padded,
    /// truncated or hashed anyway.
    func testRefusesInsteadOfGuessing() {
        for wrong in [0, 31, 33, 64] {
            XCTAssertThrowsError(try CryptoNight.walletChachaKey(
                fromSecretKey: [UInt8](repeating: 0x11, count: wrong))) {
                XCTAssertEqual($0 as? CryptoNight.Failure, .secretKeyWrongLength(wrong))
            }
        }

        let key = [UInt8](repeating: 0x11, count: 32)
        for rounds: UInt64 in [0, 10_001, .max] {
            XCTAssertThrowsError(try CryptoNight.walletChachaKey(fromSecretKey: key, rounds: rounds)) {
                XCTAssertEqual($0 as? CryptoNight.Failure, .roundsOutOfRange(rounds))
            }
        }
    }

    /// `wipe` reaches the buffer. Not a proof that no copy survives anywhere —
    /// Swift arrays are copy-on-write and the C keeps its own scratchpad — but
    /// a wipe that did not write at all would be worth knowing about.
    func testWipeClearsTheBuffer() {
        var secret = [UInt8](repeating: 0xAB, count: 32)
        CryptoNight.wipe(&secret)
        XCTAssertEqual(secret, [UInt8](repeating: 0, count: 32))
    }
    // MARK: - The loop that closes the TypeScript side

    /// The exact derivation `test/fixtures/monero-keyimages.json` was built on.
    ///
    /// `test/moneroexport.test.ts` cannot call this C, so it installs a shim
    /// that answers with the fixture's `chachaKey` and builds a whole export
    /// blob on top of it. On its own that would be circular: the TypeScript
    /// would be proving it agrees with a number it was handed.
    ///
    /// This is the other half. The same view secret key goes into the real
    /// vendored CryptoNight here, and has to come out as the same 32 bytes the
    /// fixture pins. With both halves, the fixture is a contract between the
    /// two languages rather than a note either of them wrote to itself.
    ///
    /// If this fails, do not adjust the constant. It came from Monero's own
    /// `generate_chacha_key`, and a disagreement means the vendored C is not
    /// computing what Monero computes.
    func testMatchesTheKeyImageFixtureTheEngineIsTestedAgainst() throws {
        let viewSecret = bytes("0e0d0c0b0a090807060504030201000f0e0d0c0b0a0908070605040302010001")
        let expected = "b479c8e1275b2a2e0274fd5490d29967fe0daee1f54b5e5d6db4831d066d1306"
        XCTAssertEqual(hex(try CryptoNight.walletChachaKey(fromSecretKey: viewSecret)), expected,
                       "the vendored CryptoNight disagrees with test/fixtures/monero-keyimages.json")
    }
}
