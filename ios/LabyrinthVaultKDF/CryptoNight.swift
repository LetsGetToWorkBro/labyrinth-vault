//  CryptoNight.swift
//  The hash Monero uses as a key derivation function, and only where it does.
//
//  ## Why an app that signs transactions contains a mining algorithm
//
//  It does not, quite. CryptoNight was Monero's proof of work until 2019 and
//  is dead in that role. What outlived it is one incidental use: wallet2 turns
//  a view secret key into a symmetric key by hashing it with CryptoNight, and
//  that is the key over every exported key-image set, outgoing and incoming.
//
//      crypto::generate_chacha_key(&view_secret_key, 32, key, kdf_rounds)
//        -> cn_slow_hash(data, 32, out, variant 0, prehashed 0, height 0)
//
//  `src/crypto/chacha.h` and `wallet2.cpp:15510`. Nothing about that choice is
//  defensible on its merits — it is a memory-hard PoW hash standing in for a
//  password KDF over a key that was already uniformly random — but it is not
//  ours to relitigate. It is the format. Cake Wallet, Feather and monero-cli
//  all read each other's key-image exports for exactly one reason: all three
//  link this same C, and produce the same 32 bytes from it.
//
//  So the alternative to vendoring was reimplementing CryptoNight, and that is
//  where this parts company with Argon2id. That port could be argued for
//  because RFC 9106 publishes vectors from an oracle neither implementation
//  had seen, which makes a second implementation a cross-check. CryptoNight
//  has four test vectors in `tests/hash/tests-slow.txt` and otherwise has only
//  Monero's own source as its specification. A second implementation of it
//  would not be checked by anything; it would be a thousand lines of
//  scratchpad indexing that either matches four inputs or is wrong on the
//  fifth, and the fifth would be somebody's wallet.
//
//  ## What this file will not grow into
//
//  `cn_slow_hash` has five variants selected by an int. Four of them are
//  proof-of-work history, one of them generates machine code at runtime, and
//  none of them appear in a wallet file. The C entry point in
//  vendor/cryptonight/include/labyrinth_cryptonight.h takes no variant
//  argument, so this file could not pass one if it wanted to.

import Foundation
import CCryptoNight

public enum CryptoNight {
    public enum Failure: Error, Equatable, CustomStringConvertible {
        case secretKeyWrongLength(Int)
        case roundsOutOfRange(UInt64)

        public var description: String {
            switch self {
            case .secretKeyWrongLength(let n):
                return "A Monero secret key is 32 bytes; this one is \(n)."
            case .roundsOutOfRange(let n):
                return "Refusing \(n) key derivation rounds."
            }
        }
    }

    /// CryptoNight variant 0 over arbitrary input.
    ///
    /// Exposed mainly so `tests/hash/tests-slow.txt` can be run against it
    /// directly. Anything in the app that needs a wallet key should call
    /// `walletChachaKey` instead, which is the shape the format actually uses.
    public static func slowHashV0(_ data: [UInt8]) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: 32)
        data.withUnsafeBufferPointer { input in
            out.withUnsafeMutableBufferPointer { output in
                /* An empty input is legal — CryptoNight starts with Keccak,
                 * which is defined on the empty string — but `baseAddress` is
                 * nil for an empty buffer and the C would be reading from it.
                 * Give it somewhere to point. */
                let base = input.baseAddress ?? UnsafePointer<UInt8>(bitPattern: MemoryLayout<UInt8>.alignment)!
                labyrinth_cn_slow_hash_v0(base, input.count, output.baseAddress)
            }
        }
        return out
    }

    /// The ChaCha20 key wallet2 puts over an exported key-image set.
    ///
    /// - Parameters:
    ///   - secretKey: 32 bytes. For key-image export this is the *view* secret
    ///     key, which is the one wallet2 passes to `encrypt_with_view_secret_key`.
    ///   - rounds: `m_kdf_rounds`. One in every wallet this app will meet —
    ///     it is the wallet2 default, and Cake and Feather leave it there. The
    ///     parameter exists because the field exists and a wallet opened with
    ///     `--kdf-rounds` would otherwise be silently mis-decrypted rather
    ///     than visibly refused.
    ///
    /// The secret key is copied into this function and the copy is wiped
    /// before it returns, along with each intermediate round. What is *not*
    /// wiped is the 2 MiB scratchpad and the working state inside the vendored
    /// C, because that is upstream's stack and heap and reaching into it would
    /// mean editing files this repository pins byte for byte. Worth saying
    /// plainly rather than implying the whole path is scrubbed: it is not.
    public static func walletChachaKey(fromSecretKey secretKey: [UInt8],
                                       rounds: UInt64 = 1) throws -> [UInt8] {
        guard secretKey.count == 32 else { throw Failure.secretKeyWrongLength(secretKey.count) }

        /* Upstream's loop runs `rounds - 1` extra times, so zero and one are
         * the same thing there and zero reads as a mistake. The ceiling is
         * arbitrary and generous: each round is a 2 MiB hash, so a wallet
         * claiming a million of them is a request to hang, not a wallet. */
        guard rounds >= 1, rounds <= 10_000 else { throw Failure.roundsOutOfRange(rounds) }

        var digest = slowHashV0(secretKey)
        for _ in 1..<max(rounds, 1) {
            var next = slowHashV0(digest)
            wipe(&digest)
            swap(&digest, &next)
            wipe(&next)
        }
        return digest
    }

    /// Overwrite a buffer, through Monero's `memwipe` rather than a `for` loop
    /// the optimiser is entitled to delete.
    public static func wipe(_ bytes: inout [UInt8]) {
        bytes.withUnsafeMutableBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            labyrinth_cn_wipe(base, buffer.count)
        }
    }
}
