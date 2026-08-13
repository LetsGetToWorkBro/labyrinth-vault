//  Argon2id.swift
//  The one derivation worth taking away from JavaScript, and nothing else.
//
//  ## Why this file exists
//
//  Measured on an iPhone 17 Pro Max, one Argon2id pass at the parameters this
//  app seals with takes about 67 seconds in JavaScriptCore, which gets no JIT
//  inside a third-party app. Creation runs two of them. That is not a slow
//  unlock; it is an app that had to be taught to stop the phone falling asleep
//  underneath it. docs/native-primitives.md carries the measurement and the
//  argument. This is the implementation it authorises.
//
//  ## What this file is allowed to be
//
//  A key derivation function with somebody else's specification and somebody
//  else's test vectors. That is the whole of the rule: RFC 9106 has an oracle
//  that does not care which language answers, so a second implementation of
//  *it* is a cross-check rather than a second chance to be subtly wrong.
//
//  Nothing else comes across. The sealed-blob format, the parameter floors and
//  ceilings, the header authentication and every refusal stay in
//  src/keys/seal.ts, because those are judgement, and judgement does not get a
//  second implementation.
//
//  ## Why the reference C rather than libsodium
//
//  This was built on libsodium first and the vectors passed. Then two of them
//  could not be expressed at all: `crypto_pwhash` fixes the salt at its own
//  length and fixes parallelism at one, and `KDF_LIMITS.maxP` is 4. A blob
//  this format permits could not have been derived natively, so the native
//  path would have had to refuse work the format allows.
//
//  The reference C has neither limit. It is also the implementation that
//  produced test/fixtures/primitives.json by way of argon2-cffi, so the vector
//  check now runs against the same code the vectors came from. And it compiles
//  wherever a C compiler does, which the system libsodium could not: there is
//  no system libsodium on a phone.
//
//  It is vendored at vendor/argon2 and pinned file by file in its
//  MANIFEST.json, the same tamper-evidence the engine bundle gets.

import Foundation
import CArgon2

public enum Argon2id {
    /// Why a derivation did not happen. Never "it produced something else".
    public enum Failure: Error, Equatable, CustomStringConvertible {
        case parameterOutOfRange(String)
        case refused(code: Int32, reason: String)

        public var description: String {
            switch self {
            case .parameterOutOfRange(let what):
                return "Key derivation parameter out of range: \(what)."
            case .refused(_, let reason):
                return "The key derivation refused this request: \(reason)."
            }
        }
    }

    /// Argon2id v1.3, RFC 9106.
    ///
    /// - Parameters:
    ///   - m: memory, in **kibibytes**, matching `KdfParams` and the Argon2
    ///        specification. This is the unit the reference C takes too, so
    ///        unlike the libsodium version this file used to be, there is no
    ///        conversion here to get wrong.
    public static func deriveKey(passphrase: [UInt8],
                                 salt: [UInt8],
                                 t: Int,
                                 m: Int,
                                 p: Int,
                                 dkLen: Int) throws -> [UInt8] {
        /* Bounds first and in Swift, so the C is never asked a question it
         * would have to answer with an error code. These are the shapes of
         * the arguments, not the policy: what a *vault* may be sealed with is
         * KDF_LIMITS in src/keys/seal.ts, which is judgement and stays there.
         * Anything this lets through, the C still checks for itself. */
        guard t >= 1 else { throw Failure.parameterOutOfRange("t") }
        guard m >= 8 else { throw Failure.parameterOutOfRange("m") }
        guard p >= 1 else { throw Failure.parameterOutOfRange("p") }
        guard dkLen >= 4 else { throw Failure.parameterOutOfRange("dkLen") }
        guard !salt.isEmpty else { throw Failure.parameterOutOfRange("salt") }
        guard !passphrase.isEmpty else { throw Failure.parameterOutOfRange("passphrase") }
        guard let t32 = UInt32(exactly: t), let m32 = UInt32(exactly: m),
              let p32 = UInt32(exactly: p) else {
            throw Failure.parameterOutOfRange("t, m or p does not fit the interface")
        }

        var out = [UInt8](repeating: 0, count: dkLen)
        let status: Int32 = passphrase.withUnsafeBufferPointer { pass in
            salt.withUnsafeBufferPointer { saltBuffer in
                out.withUnsafeMutableBufferPointer { key in
                    argon2id_hash_raw(t32, m32, p32,
                                      pass.baseAddress, pass.count,
                                      saltBuffer.baseAddress, saltBuffer.count,
                                      key.baseAddress, key.count)
                }
            }
        }
        guard status == ARGON2_OK.rawValue else {
            /* Never return a key that came out of a failed call, and never
             * leave one in memory to be read later. */
            for i in out.indices { out[i] = 0 }
            let reason = argon2_error_message(status).map { String(cString: $0) }
                ?? "unknown error \(status)"
            throw Failure.refused(code: status, reason: reason)
        }
        return out
    }
}
