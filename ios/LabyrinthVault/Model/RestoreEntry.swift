//  RestoreEntry.swift
//  Two phrases being typed, and what the screen may say about them.
//
//  ## Why this is not in the view
//
//  The restore stage is the first place this app has ever accepted typed key
//  material, and the thing it must never do is let somebody press RESTORE on a
//  phrase that is not the one they meant. A SwiftUI view holding that logic
//  would be logic nothing runs: `Setup.swift` imports SwiftUI, so it is on
//  `Package.swift`'s exclude list and is parsed for syntax by
//  `scripts/swift-check.sh` and type-checked by nobody until Xcode opens.
//
//  Everything below imports Foundation and nothing else, so it compiles for
//  real on Linux and `RestoreEntryTests` runs on every push. What is left in
//  the view is the two fields and a button, which is the amount of untested
//  code a screen is allowed to be.
//
//  ## What this decides, and what it deliberately does not
//
//  It counts words. That is all. Whether the words are *right* is the engine's
//  answer and only the engine's: `restore` in src/bridge/host.ts reads the
//  Bitcoin phrase through BIP39's checksum and the Monero phrase through
//  Monero's, and names which field is wrong. Re-implementing either checksum
//  here would be a second opinion about somebody else's format, which is the
//  thing CLAUDE.md refuses in as many words, and the second opinion is always
//  the one that is wrong at the worst moment.
//
//  So the strongest thing this file can honestly say is "that is not yet
//  twelve words". A phrase of exactly twelve wrong words gets the button and
//  is refused by the engine, in a sentence, which is correct: it is the only
//  half of the system that can tell.
//
//  ## Normalization, and the one hazard in it
//
//  Lowercase, collapse runs of whitespace, trim. Bounded on purpose: BIP39's
//  English list and Monero's are both lowercase ASCII, so neither operation
//  can turn one valid phrase into a different valid phrase. The worst a
//  disagreement with `checkMnemonic`'s normalization could produce is a count
//  that differs by one, which shows up as an enabled button and a refusal from
//  the engine. Annoying, and not a wrong vault, which is the distinction that
//  decided how much of this to do here.

import Foundation

public enum RestoreEntry {

    /// A vault's Bitcoin phrase. Twelve, fixed by the engine's `SECRET_BYTES`:
    /// sixteen bytes of BIP39 entropy is twelve words and nothing else.
    public static let bitcoinWords = 12

    /// A vault's Monero phrase. Twenty-five: twenty-four encoding the seed and
    /// a checksum word. `seedFromMnemonic` accepts that length and no other.
    public static let moneroWords = 25

    /// What one field has in it.
    public enum Field: Equatable, Sendable {
        case empty
        /// Fewer words than the phrase needs. Carries both numbers so the
        /// screen can count up rather than saying "not yet" forever.
        case short(have: Int, want: Int)
        /// More words than the phrase needs. Its own case rather than folded
        /// into `short`, because the two are different mistakes: one is
        /// someone still typing and the other is someone pasting the wrong
        /// phrase into the wrong field, which is worth saying out loud.
        case over(have: Int, want: Int)
        case ready

        public var isReady: Bool { self == .ready }
    }

    /// Both fields, and whether the lever may be pressed.
    public struct Reading: Equatable, Sendable {
        public let bitcoin: Field
        public let monero: Field
        /// The normalized text to hand the engine. What was counted is what is
        /// sent, so a person cannot be shown a count for one string and have
        /// another one restored.
        public let bitcoinWords: String
        public let moneroWords: String

        /// Both fields the right length. Not "both valid": see the header.
        public var mayRestore: Bool { bitcoin.isReady && monero.isReady }
    }

    /// Lowercased, single-spaced, trimmed. See the header for why this is as
    /// far as it goes.
    public static func normalize(_ text: String) -> String {
        text
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .lowercased()
    }

    public static func count(_ text: String) -> Int {
        text.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.count
    }

    static func judge(_ text: String, want: Int) -> Field {
        let have = count(text)
        if have == 0 { return .empty }
        if have == want { return .ready }
        return have < want ? .short(have: have, want: want) : .over(have: have, want: want)
    }

    public static func read(bitcoin: String, monero: String) -> Reading {
        Reading(
            bitcoin: judge(bitcoin, want: bitcoinWords),
            monero: judge(monero, want: moneroWords),
            bitcoinWords: normalize(bitcoin),
            moneroWords: normalize(monero)
        )
    }

    /// What to print under a field, or nil when there is nothing useful to say.
    ///
    /// Sentences rather than codes, and nothing at all for an empty field: a
    /// screen that says "0 of 12" before anybody has typed is a screen
    /// complaining about a person for opening it.
    public static func hint(for field: Field, chain: String) -> String? {
        switch field {
        case .empty:
            return nil
        case .short(let have, let want):
            return "\(have) of \(want) \(chain) words."
        case .over(let have, let want):
            return "That is \(have) words and a \(chain) phrase is \(want). "
                + "Check that each phrase is in its own field."
        case .ready:
            return nil
        }
    }
}
