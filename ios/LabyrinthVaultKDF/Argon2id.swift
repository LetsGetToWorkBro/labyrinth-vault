//  Argon2id.swift
//  The one derivation worth taking away from JavaScript, and nothing else.
//
//  ## Why this file exists
//
//  Measured on an iPhone 17 Pro Max, one Argon2id pass at the parameters this
//  app seals with takes about 67 seconds in JavaScriptCore, which has no JIT
//  inside a third-party app. Creation runs two of them. That is not a slow
//  unlock, it is an app that had to be taught not to let the phone fall asleep
//  underneath it. docs/native-primitives.md carries the measurement and the
//  argument; this is the implementation it authorises.
//
//  ## What this file is allowed to be
//
//  A key derivation function with somebody else's specification and somebody
//  else's test vectors. That is the whole of the rule in
//  docs/native-primitives.md: RFC 9106 has an oracle that does not care which
//  language answers, so a second implementation of *it* is a cross-check
//  rather than a second chance to be subtly wrong.
//
//  Nothing else comes across. The sealed-blob format, the parameter floors and
//  ceilings, the header authentication and every refusal stay in
//  src/keys/seal.ts, because those are judgement, and judgement does not get a
//  second implementation.
//
//  ## What it cannot do, stated up front
//
//  libsodium's `crypto_pwhash` is not general-purpose Argon2id. It fixes the
//  salt at `crypto_pwhash_SALTBYTES` and it fixes parallelism at one. Our
//  format's `SALT_BYTES` is 16 and matches, but `KDF_LIMITS.maxP` is 4, so a
//  blob may legitimately declare a parallelism this function cannot compute.
//
//  It refuses those rather than approximating them. A KDF that quietly ignored
//  `p` would return a different key and the vault would simply not open, with
//  no error anyone could read — the exact failure this whole project is built
//  to make impossible. The JavaScript path stays in the build and takes them,
//  which is also why step 4 of the port says to keep it.

import Foundation
import Csodium

public enum Argon2id {
    /// Why a derivation did not happen. Never "it produced something else".
    public enum Failure: Error, Equatable, CustomStringConvertible {
        case libraryUnavailable
        case saltLength(expected: Int, got: Int)
        case unsupportedParallelism(Int)
        case parameterOutOfRange(String)
        case refused

        public var description: String {
            switch self {
            case .libraryUnavailable:
                return "The key derivation library did not start."
            case .saltLength(let expected, let got):
                return "This derivation needs a \(expected) byte salt and was given \(got)."
            case .unsupportedParallelism(let p):
                return "Parallelism \(p) is not available natively; this must be derived in the engine."
            case .parameterOutOfRange(let what):
                return "Key derivation parameter out of range: \(what)."
            case .refused:
                return "The key derivation library refused the request, most likely for memory."
            }
        }
    }

    /// The only salt length this can compute, straight from the library
    /// rather than written down here where it could drift.
    public static var saltBytes: Int { Int(crypto_pwhash_saltbytes()) }

    /// The shortest key it will produce, likewise.
    public static var minimumKeyBytes: Int { Int(crypto_pwhash_bytes_min()) }

    /// `sodium_init` is required before any other call and is documented as
    /// safe to call more than once. Returning 1 means "already initialised",
    /// which is success; only a negative result is a failure.
    private static func started() -> Bool { sodium_init() >= 0 }

    /// Argon2id v1.3, RFC 9106.
    ///
    /// - Parameters:
    ///   - m: memory, in **kibibytes**, matching `KdfParams` and the Argon2
    ///        specification. libsodium wants bytes and is given them here,
    ///        which is the one unit conversion in this file and the reason it
    ///        is spelled out in the signature.
    public static func deriveKey(passphrase: [UInt8],
                                 salt: [UInt8],
                                 t: Int,
                                 m: Int,
                                 p: Int,
                                 dkLen: Int) throws -> [UInt8] {
        guard started() else { throw Failure.libraryUnavailable }
        guard salt.count == saltBytes else {
            throw Failure.saltLength(expected: saltBytes, got: salt.count)
        }
        guard p == 1 else { throw Failure.unsupportedParallelism(p) }
        guard t >= 1 else { throw Failure.parameterOutOfRange("t") }
        guard m >= 8 else { throw Failure.parameterOutOfRange("m") }
        guard dkLen >= minimumKeyBytes else { throw Failure.parameterOutOfRange("dkLen") }

        // KiB to bytes, checked rather than assumed: on a 32-bit platform this
        // multiplication is where a 512 MiB ceiling would overflow into a
        // small allocation and a wrong key.
        let (memlimit, overflowed) = m.multipliedReportingOverflow(by: 1024)
        guard !overflowed, memlimit > 0 else { throw Failure.parameterOutOfRange("m") }

        var out = [UInt8](repeating: 0, count: dkLen)
        let status: Int32 = try passphrase.withUnsafeBufferPointer { pass in
            try salt.withUnsafeBufferPointer { saltBuffer in
                try out.withUnsafeMutableBufferPointer { key in
                    /* An empty buffer has no base address, and handing a
                     * dangling pointer to C is undefined even where the callee
                     * would never read it. All three are non-empty by the
                     * guards above, so reaching this is a bug rather than a
                     * user error, and it says so instead of force-unwrapping.
                     * seal.ts refuses an empty passphrase long before here. */
                    guard let passBase = pass.baseAddress,
                          let saltBase = saltBuffer.baseAddress,
                          let keyBase = key.baseAddress else {
                        throw Failure.parameterOutOfRange("empty buffer")
                    }
                    return passBase.withMemoryRebound(to: CChar.self, capacity: pass.count) { chars in
                        crypto_pwhash(keyBase,
                                      UInt64(dkLen),
                                      chars,
                                      UInt64(pass.count),
                                      saltBase,
                                      UInt64(t),
                                      memlimit,
                                      crypto_pwhash_alg_argon2id13())
                    }
                }
            }
        }
        guard status == 0 else {
            /* The library does not say why. Its documented failure is running
             * out of memory, and inventing a more specific sentence than it
             * gave us would be inventing information. */
            for i in out.indices { out[i] = 0 }
            throw Failure.refused
        }
        return out
    }
}
