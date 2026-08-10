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
//  ## The normalisation is a cross-language contract
//
//  NFKD, then UTF-8, matching `passphraseToBytes` in src/keys/seal.ts exactly.
//  This is the one piece of behaviour that had to be implemented twice, and it
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
    /// `withUnsafeMutableBufferPointer` so the write goes to the array's real
    /// storage, and the pointer keeps the optimiser from deciding that stores
    /// to memory nobody reads afterwards can be skipped — which is exactly
    /// what a plain loop over the elements invites it to do.
    static func wipe(_ bytes: inout [UInt8]) {
        bytes.withUnsafeMutableBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            memset_s(base, buffer.count, 0, buffer.count)
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
}
