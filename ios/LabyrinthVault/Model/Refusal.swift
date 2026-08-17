//  Refusal.swift
//  Every condition the reader refuses over, and the words for each.
//
//  Free of SwiftUI on purpose: this is the security-critical half of the
//  screen — which conditions stop a signature and what a person is told about
//  them — and it belongs somewhere a compiler can check it exhaustively.
//
//  That is not hypothetical. While this enum lived inside Vault.swift, next to
//  `import SwiftUI`, nothing in this repository could compile it, and `detail`
//  was a non-exhaustive switch missing five of its nine cases. A regex guard
//  cannot find that. `swift build` finds it instantly, which is the argument
//  for this file existing.
//
//  The rendering — colors, layout, the hold-to-continue that these screens
//  deliberately do not have — stays in Screens/Refusal.swift.

import Foundation

/// Every condition the reader refuses over: one case per fatal warning code in
/// src/keys/psbt.ts, plus the named refusals the bridge raises directly, such
/// as one of Monero's own wallet files arriving where a signature was the
/// question. (Arriving where *reading* is the question, an unsigned
/// transaction set gets described instead: see Screens/MoneroFile.swift. This
/// enum is the signing path's vocabulary.) Each is fatal: there is
/// deliberately no associated "override" payload, and no case carries a way to
/// continue.
///
/// The mapping is not decorative. When the bridge hands this layer a fatal
/// warning it does not recognize, the honest outcome is a refusal it cannot
/// describe well — never a screen that quietly proceeds — so `unrecognised`
/// exists as the catch-all and `test/app-wiring.test.ts` fails if psbt.ts
/// grows a fatal code with no case here.
enum Refusal: Equatable {
    /// `output-path-mismatch`
    case changeMismatch
    /// `unknown-input-value`
    case unknowableFee
    /// `unusual-sighash`
    case sighashFlags
    /// `duplicate-input`
    case duplicateInput
    /// `opaque-output`
    case opaqueOutput
    /// `watch-only`
    case noKeys
    /// `unreadable`
    case unreadable
    /// `monero-file-unsupported`
    case moneroFile
    /// The approval digest or wallet check in `signPsbt`.
    case digestMismatch
    /// The signer threw with a sentence rather than a code.
    ///
    /// It exists because the alternative was worse: both signing paths used to
    /// end in a bare `catch` that routed every engine failure to
    /// `digestMismatch`, which threw the engine's own words away and put a
    /// specific, false accusation in their place. `foreign-input` is the
    /// reachable one, since it is deliberately not fatal at describe time, so
    /// a PSBT with no input belonging to this vault was reported as bytes that
    /// changed between two screens, with advice ("scan it again") that can
    /// never work.
    case engineRefused(String)
    /// A fatal code this build does not have a case for. Refuses anyway.
    case unrecognised(String)

    /// Map a fatal warning code from src/keys/psbt.ts onto a screen.
    ///
    /// The default is `unrecognised`, and `unrecognised` refuses. A code this
    /// build has no words for is still a reason to stop, and the one thing
    /// this initializer must never do is return nil and let a caller carry on.
    init(code: String) {
        switch code {
        case "output-path-mismatch": self = .changeMismatch
        case "unknown-input-value": self = .unknowableFee
        case "unusual-sighash": self = .sighashFlags
        case "duplicate-input": self = .duplicateInput
        case "opaque-output": self = .opaqueOutput
        case "watch-only": self = .noKeys
        case "unreadable": self = .unreadable
        case "monero-file-unsupported": self = .moneroFile
        default: self = .unrecognised(code)
        }
    }

    var headline: [String] {
        switch self {
        case .changeMismatch: ["CANNOT", "SIGN"]
        case .unknowableFee: ["CANNOT", "DETERMINE", "FEE"]
        case .sighashFlags: ["CANNOT", "SIGN"]
        case .duplicateInput: ["CANNOT", "SIGN"]
        case .opaqueOutput: ["CANNOT", "READ", "DESTINATION"]
        case .noKeys: ["NO", "SIGNING", "KEY"]
        case .unreadable: ["CANNOT", "READ", "TRANSACTION"]
        case .moneroFile: ["NOT SIGNED", "FROM A FILE"]
        case .digestMismatch: ["CANNOT", "SIGN"]
        case .engineRefused: ["SIGNER", "STOPPED"]
        case .unrecognised: ["CANNOT", "SIGN"]
        }
    }
    var why: [String] {
        switch self {
        case .changeMismatch: ["CHANGE OUTPUT", "DOES NOT MATCH", "VAULT DERIVATION."]
        case .unknowableFee: ["THE VAULT CANNOT", "HONESTLY TELL YOU", "WHAT THIS COSTS."]
        case .sighashFlags: ["SIGNATURE WOULD NOT", "COMMIT TO WHERE", "THE MONEY GOES."]
        case .duplicateInput: ["THE SAME COIN", "IS SPENT TWICE.", "TOTALS ARE FICTION."]
        case .opaqueOutput: ["AN OUTPUT PAYS", "A SCRIPT WITH NO", "READABLE ADDRESS."]
        case .noKeys: ["THIS WALLET IS", "WATCH-ONLY. IT HAS", "NO PRIVATE KEY."]
        case .unreadable: ["THESE BYTES ARE NOT", "A TRANSACTION THIS", "DEVICE CAN READ."]
        case .moneroFile: ["THIS IS A MONERO", "WALLET FILE, AND A", "SIGNER CANNOT USE ONE."]
        case .digestMismatch: ["TRANSACTION DIGEST", "DOES NOT MATCH", "APPROVED SUMMARY."]
        case .engineRefused: ["THE SIGNER STOPPED", "AND SAID WHY.", "ITS WORDS FOLLOW."]
        case .unrecognised: ["THE READER REFUSED", "FOR A REASON THIS", "SCREEN CANNOT NAME."]
        }
    }
    var detail: String {
        switch self {
        case .changeMismatch:
            "One output claims to be your change. The vault rebuilt that address from its own " +
            "key and got a different one, which means the transaction is describing itself " +
            "falsely. Nothing else it says can be trusted either, so none of it gets signed."
        case .unknowableFee:
            "A fee is what is left over after the outputs, so it can only be stated by a signer " +
            "that knows what every input was worth. This transaction did not supply one of them. " +
            "The alternative to refusing is printing a number the vault has not verified, which " +
            "is worse than printing nothing."
        case .sighashFlags:
            "This transaction asks to be signed in a way that does not commit to where the money " +
            "goes. A signature like that can be lifted out and reused around outputs nobody " +
            "showed you, so the only safe reading of the request is that it is not the request " +
            "it appears to be."
        case .duplicateInput:
            "The same coin appears as an input twice. It can only be spent once, so every total " +
            "computed from this transaction (what leaves, what returns, what the fee is) is a " +
            "number describing something that cannot happen."
        case .opaqueOutput:
            "One output pays a script that does not decode to any address this device can show " +
            "you. There is no honest way to put it on the confirmation screen, and signing a " +
            "destination nobody could read is the thing this screen exists to prevent."
        case .noKeys:
            "This vault is holding a watch-only key. It can tell you what a transaction does and " +
            "it has nothing to sign it with. That is not a fault; it is what watch-only means."
        case .unreadable:
            "These bytes did not parse as a transaction. Most often that is a misread camera " +
            "frame, and scanning again fixes it. The vault will not guess at a partial parse."
        case .moneroFile:
            "This is one of Monero's own wallet files, and it is a perfectly good one. The " +
            "vault will not sign it. Everything such a file contains is the sending wallet's " +
            "own account of its own transaction, and a signature has to be over destinations " +
            "this device rebuilt from its own keys. To send Monero the vault will check, start " +
            "the payment in the Labyrinth wallet and show this device the code it produces. " +
            "Nothing was signed and nothing was changed."
        case .digestMismatch:
            "The bytes in front of the signer are not the bytes that were reviewed on the " +
            "previous screen. Whatever happened between the two steps, a signature over " +
            "something nobody read is not going to be produced."
        case .engineRefused(let why):
            "The signer stopped before producing a signature, and these are its own words: " +
            "\(why) Nothing was changed. The reader had already accepted these bytes, so " +
            "what went wrong is in what the signing step was asked to do rather than in " +
            "the transaction being unreadable, and scanning it again will do the same thing."
        case .unrecognised(let code):
            "The transaction reader refused this with a condition (\(code)) that this version of " +
            "the screen has no words for. It is still a refusal: an unrecognized reason to stop is " +
            "a reason to stop. Update the app."
        }
    }

    /// The attestation rows under the explanation.
    ///
    /// ## Nothing here may name a number this enum did not see
    ///
    /// These rows used to number the offending input and output, and the
    /// digest screen used to print a pair of eight-character digests as if it
    /// had compared them. Every one of those was invented. The positions
    /// belong to no transaction; the approved digest was the leading
    /// characters of the demo fixture in Vault.swift, and the presented one
    /// matched nothing that has ever existed. (Deliberately not quoted here:
    /// a guard that fails on hex in this file would otherwise fail on the
    /// paragraph explaining why there is none.)
    ///
    /// It matters more here than it would anywhere else in the app, because
    /// this is the screen where the training gets used. `Review.swift` prints
    /// the digest in full under "The signature will be taken over these bytes
    /// and no others" and `Signed.swift` prints its first eight characters, so
    /// a person arriving here has been taught to compare exactly these strings
    /// and has no way to know that this pair is scenery. A refusal screen that
    /// states one false fact costs the true ones their standing.
    ///
    /// So the rows say what the case itself knows and no more. `Refusal` is
    /// constructed from a code or from nothing at all: it never receives the
    /// transaction, so it cannot honestly count inputs, number outputs or
    /// quote a digest, and the wording is general because the knowledge is.
    /// The only rows that print a specific string are the ones on a case that
    /// carries it: `unrecognised` prints the code it was handed, and
    /// `engineRefused` leaves its sentence to `detail`, where a paragraph
    /// belongs.
    ///
    /// Keep a row under about forty characters. `Attestation` sets no line
    /// limit and no `fixedSize`, so a longer row inside its `HStack` truncates
    /// rather than wraps, and the only machine that can see that is a phone.
    /// Thirty-nine is what shipped and rendered; that is the budget.
    var findings: [(String, Bool)] {
        switch self {
        case .changeMismatch: [
            ("AN OUTPUT CLAIMS TO BE YOUR CHANGE", false),
            ("RE-DERIVED SCRIPT DIFFERS", false),
            ("NO SIGNATURE PRODUCED", true)]
        case .unknowableFee: [
            ("AN INPUT'S PREVIOUS OUTPUT IS MISSING", false),
            ("FEE NOT COMPUTABLE", false),
            ("NO SIGNATURE PRODUCED", true)]
        case .sighashFlags: [
            ("AN INPUT'S SIGHASH IS NOT ALL", false),
            ("SIGNATURE WOULD NOT BIND OUTPUTS", false),
            ("NO SIGNATURE PRODUCED", true)]
        case .duplicateInput: [
            ("ONE COIN APPEARS AS TWO INPUTS", false),
            ("STATED TOTALS EXCEED REALITY", false),
            ("NO SIGNATURE PRODUCED", true)]
        case .opaqueOutput: [
            ("A SCRIPT DECODES TO NO ADDRESS", false),
            ("DESTINATION NOT REVIEWABLE", false),
            ("NO SIGNATURE PRODUCED", true)]
        case .noKeys: [
            ("WALLET IS WATCH-ONLY", false),
            ("NO PRIVATE KEY PRESENT", false),
            ("NO SIGNATURE PRODUCED", true)]
        case .unreadable: [
            ("BYTES DID NOT PARSE", false),
            ("NOTHING TO DESCRIBE", false),
            ("NO SIGNATURE PRODUCED", true)]
        case .moneroFile: [
            ("MONERO WALLET FILE RECOGNIZED", true),
            ("FILE DESCRIBES ITSELF · NOT CHECKABLE", false),
            ("NO SIGNATURE PRODUCED", true)]
        case .digestMismatch: [
            ("APPROVED AND PRESENTED DIGESTS DIFFER", false),
            ("NEITHER SET OF BYTES WAS SIGNED", false),
            ("NO SIGNATURE PRODUCED", true)]
        case .engineRefused: [
            /* No fourth row quoting the sentence. It is already printed in
             * full above, and an attestation is a short fact rather than a
             * second copy of the paragraph. */
            ("THE READER ACCEPTED THESE BYTES", true),
            ("THE SIGNER REFUSED, IN ITS WORDS ABOVE", false),
            ("NO SIGNATURE PRODUCED", true)]
        case .unrecognised(let code): [
            ("READER REFUSED: \(code.uppercased())", false),
            ("NO CASE IN THIS BUILD", false),
            ("NO SIGNATURE PRODUCED", true)]
        }
    }
}