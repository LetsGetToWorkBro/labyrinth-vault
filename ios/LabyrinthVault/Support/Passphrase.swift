//  Passphrase.swift
//  Where a typed passphrase stops being text.
//
//  A `String` cannot be overwritten. Not in Swift, not in JavaScript. Once a
//  passphrase has been one, every copy the runtime made lives until something
//  else happens to reuse that memory, and there is no call you can make to
//  bring that forward. `memset` on a `String`'s storage is not a thing.
//
//  That was tolerable for the seed, which is generated rather than typed and
//  never needed to be text at all. It was never tolerable for the passphrase,
//  which is the one secret a person types and the one that opens everything
//  else — and until this file existed it crossed into JavaScriptCore as a
//  string argument, so it existed unwipeable in two heaps at once.
//
//  So: the text becomes bytes as early as it can, the bytes are what travel,
//  and the bytes are zeroed the moment they have been used. What remains is
//  the `String` the keyboard itself produced, which nothing in this process
//  can do anything about. Narrowing the window is the available move; closing
//  it is not, and this file does not pretend otherwise.
//
//  ## The normalization is a cross-language contract
//
//  NFKD, then UTF-8, matching `passphraseToBytes` in src/keys/seal.ts exactly.
//  This is the one piece of behavior that had to be implemented twice, and it
//  is worth naming why that is acceptable here when it is not elsewhere: it is
//  a Unicode operation with a specification, both implementations are the
//  platform's rather than ours, and `test/fixtures/primitives.json` pins the
//  exact bytes for inputs chosen to catch a disagreement.
//
//  Get it wrong and nothing fails loudly. You get a vault that opens on the
//  phone that sealed it and on no other device, discovered by somebody
//  restoring from a backup after losing the phone — which is the worst
//  possible moment to discover anything.

import Foundation

/* The wipe below needs a function the compiler is forbidden to optimize away,
 * and the two platforms spell it differently. Both imports are here so that
 * this file builds on a phone and under a plain `swift test` on Linux, which
 * is the only reason any of it is checked by a compiler at all — see
 * Package.swift. */
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

enum Passphrase {
    /// Typed text to the bytes the engine seals under.
    ///
    /// `decomposedStringWithCompatibilityMapping` is Foundation's NFKD, the
    /// same normal form `String.prototype.normalize('NFKD')` produces and the
    /// same one BIP39 applies to its passphrases. It matters because two
    /// keyboards can produce different code points for the same visible
    /// passphrase, and a person should not be locked out by which one they
    /// happened to use.
    ///
    /// The caller owns the result and should `wipe` it.
    static func bytes(from text: String) -> [UInt8] {
        Array(text.decomposedStringWithCompatibilityMapping.utf8)
    }

    /// Zero a byte array in place.
    ///
    /// `withUnsafeMutableBufferPointer` so the write reaches the array's real
    /// storage rather than a copy. The function called through it is the part
    /// that matters: a plain `for i in ...  { bytes[i] = 0 }` is a store to
    /// memory nothing reads afterwards, which is precisely the store an
    /// optimizer is allowed to delete. `memset_s` and `explicit_bzero` exist
    /// because that deletion is a real and repeatedly-observed bug, and both
    /// carry a guarantee that it will not happen.
    ///
    /// Two spellings because they are different platforms' answers to the same
    /// problem: Annex K's on Apple's, glibc's on Linux. There is no portable
    /// one, and picking a portable-looking loop instead would be choosing the
    /// version that silently does nothing.
    static func wipe(_ bytes: inout [UInt8]) {
        bytes.withUnsafeMutableBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            #if canImport(Darwin)
            memset_s(base, buffer.count, 0, buffer.count)
            #else
            explicit_bzero(base, buffer.count)
            #endif
        }
    }

    /// Run `use` over the bytes of `text`, and zero them afterwards whatever
    /// happens — including on a thrown error, which is precisely when nobody
    /// is thinking about cleanup.
    ///
    /// This is the shape every call site should use. Taking the bytes and
    /// remembering to wipe them later is the same shape with a gap in it.
    static func withBytes<T>(of text: String, _ use: ([UInt8]) throws -> T) rethrows -> T {
        var bytes = Self.bytes(from: text)
        defer { Self.wipe(&bytes) }
        return try use(bytes)
    }

    /// The bytes a blob is actually sealed under: what the keychain guards,
    /// then what the person knows.
    ///
    /// ## Why there are two layers
    ///
    /// Sealing under the typed passphrase alone protects a vault while the
    /// phone is intact, because the blob lives in a passcode-bound keychain
    /// item. It protects nothing once the ciphertext is out — a forensic
    /// image, a backup that should not exist — because from that point an
    /// attacker has the file and all the time in the world, and the only thing
    /// between them and the keys is how good the passphrase was.
    ///
    /// The device secret is 32 random bytes that never leave the keychain and
    /// never leave this phone. Layering means AND: unsealing needs what the
    /// keychain guards *and* what the person knows, so an extracted blob is
    /// useless off the device it was sealed on. That property is worth more
    /// than any amount of key stretching, and it costs nothing to compute.
    ///
    /// ## Why a newline, and why joined after normalising
    ///
    /// The device secret arrives as hex, and `\n` is not in the hex alphabet,
    /// so the two layers cannot slide into one another: no user passphrase can
    /// impersonate a longer device secret or vice versa.
    ///
    /// The parts are normalised separately and then joined, rather than joined
    /// and then normalised. The two are supposed to agree — U+000A is a
    /// starter, so NFKD can neither compose nor reorder across it — but
    /// "supposed to" is how subtle Unicode bugs get in, and a vault that seals
    /// under one byte sequence and unseals under another opens on no device at
    /// all. `PassphraseContractTests` asserts the two forms agree over inputs
    /// chosen to break it if it is breakable.
    ///
    /// Ported from `app/storage.ts`, which specified this and never shipped.
    static func withLayeredBytes<T>(deviceHex: String,
                                    user: String,
                                    _ use: ([UInt8]) throws -> T) rethrows -> T {
        var device = Self.bytes(from: deviceHex)
        var userBytes = Self.bytes(from: user)
        var layered = [UInt8]()
        layered.reserveCapacity(device.count + 1 + userBytes.count)
        layered.append(contentsOf: device)
        layered.append(0x0a)
        layered.append(contentsOf: userBytes)
        defer {
            Self.wipe(&device)
            Self.wipe(&userBytes)
            Self.wipe(&layered)
        }
        return try use(layered)
    }
}
