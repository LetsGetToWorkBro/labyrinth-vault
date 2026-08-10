//  Vault.swift
//  The application state machine, and the shapes the screens render.
//
//  The routes encode the security model. There is no route from a refusal to
//  anywhere but the scanner, and no way to construct `.approve` without the
//  reviewed summary — the same digest-carrying contract as `signPsbt` in
//  src/keys/psbt.ts: the bytes a person saw are the bytes that get signed.

import SwiftUI
import Combine

// MARK: - Transaction shapes
// These mirror the summary that src/keys/psbt.ts produces when it reads a
// PSBT. The view layer never re-derives or re-orders anything from them.

struct TxSummary: Equatable {
    let sendAmount: String        // "0.482731"
    let asset: Asset
    let destination: String
    let destinationType: String   // "P2WPKH · NOT YOURS"
    let fee: String
    let feeShare: String          // "0.03%"
    let feeRate: String           // "68 SAT/VB"
    let vsize: String
    let change: String
    let changeAddress: String
    let changePath: String        // "m/84'/0'/0'/1/17"
    let inputs: Int
    let outputs: Int
    let totalIn: String
    let rbf: Bool
    /// Digest of this summary. Carried from review to approval to signing so
    /// that describing one transaction and signing another fails closed.
    let digest: String
}

enum Asset: String {
    case btc = "BTC"
    case xmr = "XMR"
    var color: Color { self == .btc ? Ink.btc : Ink.xmr }
    var name: String { self == .btc ? "BITCOIN" : "MONERO" }
}

/// Every condition the reader refuses over, one case per fatal warning code in
/// src/keys/psbt.ts. Each is fatal: there is deliberately no associated
/// "override" payload, and no case carries a way to continue.
///
/// The mapping is not decorative. When the bridge hands this layer a fatal
/// warning it does not recognise, the honest outcome is a refusal it cannot
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
    /// The approval digest or wallet check in `signPsbt`.
    case digestMismatch
    /// A fatal code this build does not have a case for. Refuses anyway.
    case unrecognised(String)

    var headline: [String] {
        switch self {
        case .changeMismatch: ["CANNOT", "SIGN"]
        case .unknowableFee: ["CANNOT", "DETERMINE", "FEE"]
        case .sighashFlags: ["CANNOT", "SIGN"]
        case .duplicateInput: ["CANNOT", "SIGN"]
        case .opaqueOutput: ["CANNOT", "READ", "DESTINATION"]
        case .noKeys: ["NO", "SIGNING", "KEY"]
        case .unreadable: ["CANNOT", "READ", "TRANSACTION"]
        case .digestMismatch: ["CANNOT", "SIGN"]
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
        case .digestMismatch: ["TRANSACTION DIGEST", "DOES NOT MATCH", "APPROVED SUMMARY."]
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
        case .digestMismatch:
            "The bytes in front of the signer are not the bytes that were reviewed on the " +
            "previous screen. Whatever happened between the two steps, a signature over " +
            "something nobody read is not going to be produced."
        case .unrecognised(let code):
            "The transaction reader refused this with a condition (\(code)) that this version of " +
            "the screen has no words for. It is still a refusal: an unrecognised reason to stop is " +
            "a reason to stop. Update the app."
        }
    }
    var findings: [(String, Bool)] {
        switch self {
        case .changeMismatch: [
            ("OUTPUT 1 CLAIMED AS CHANGE", false),
            ("RE-DERIVED SCRIPT DIFFERS", false),
            ("NO SIGNATURE PRODUCED", true)]
        case .unknowableFee: [
            ("INPUT 2 · PREVIOUS OUTPUT MISSING", false),
            ("FEE NOT COMPUTABLE", false),
            ("NO SIGNATURE PRODUCED", true)]
        case .sighashFlags: [
            ("INPUT 1 · SIGHASH NOT ALL", false),
            ("SIGNATURE WOULD NOT BIND OUTPUTS", false),
            ("NO SIGNATURE PRODUCED", true)]
        case .duplicateInput: [
            ("INPUT 2 REPEATS INPUT 1", false),
            ("STATED TOTALS EXCEED REALITY", false),
            ("NO SIGNATURE PRODUCED", true)]
        case .opaqueOutput: [
            ("OUTPUT 1 · SCRIPT DECODES TO NO ADDRESS", false),
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
        case .digestMismatch: [
            ("APPROVED SUMMARY DIGEST 9F2A1C04", false),
            ("PRESENTED BYTES DIGEST 71D3E80B", false),
            ("NO SIGNATURE PRODUCED", true)]
        case .unrecognised(let code): [
            ("READER REFUSED: \(code.uppercased())", false),
            ("NO CASE IN THIS BUILD", false),
            ("NO SIGNATURE PRODUCED", true)]
        }
    }
}

// MARK: - Fixtures
// STAGED. The shipped app receives these from the transaction reader in
// src/keys/psbt.ts through the bridge; the numbers here are internally
// consistent (in = out + fee, rate matches vsize) because a demo that does
// not add up teaches the wrong reflexes.

enum Fixtures {
    static let tx = TxSummary(
        sendAmount: "0.482731",
        asset: .btc,
        destination: "bc1q7k9x2t4vlqz8m3n0d5r6sgu9hj2wf4paeyc3lz",
        destinationType: "P2WPKH · NOT YOURS",
        fee: "0.000142",
        feeShare: "0.03%",
        feeRate: "68 SAT/VB",
        vsize: "208 VB",
        change: "0.317891",
        changeAddress: "bc1q9m4v0xr2ekstd7q5c3jag8huw6zfn2ypl4v0d3",
        changePath: "m/84'/0'/0'/1/17",
        inputs: 3,
        outputs: 2,
        totalIn: "0.800764",
        rbf: true,
        digest: "9F2A1C04E7B83D56"
    )

    static let vaultID = "•••• •••• 7F21"
    static let fingerprint = "7F21A9C4"
    static let xpub = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wnrGmqRjTnAoyzYaGrBqRPRDULoZv5ovbaAtCXKLQ7kFznKrJ8m3rTfQeVsn2Kh4"
    static let txid = "C1D0A4F7E2B95836AA41C07D9E3F5B28"
    static let seed = ["aperture", "basin", "cinder", "draft", "ember", "fathom",
                       "girder", "harbour", "ingot", "jetty", "kiln", "lantern"]
}

// MARK: - Routes

enum Route: Equatable {
    case launch
    case setup(SetupStage)
    case home
    case airgap
    case export
    case scanner
    case acquiring
    case received
    /// Review holds the summary; approve additionally holds the digest the
    /// person scrolled past. The compiler enforces the order.
    case review(TxSummary)
    case destination(TxSummary)
    case approve(TxSummary, reviewedDigest: String)
    case signed(TxSummary)
    case signedQR(TxSummary)
    case refused(Refusal)
    case settings
    case bitcoin
    case monero
    case recovery
}

enum SetupStage: Equatable {
    case declaration, radios, verify, boundary, entropy, created
}

// MARK: - The model

@MainActor
final class Vault: ObservableObject {
    @Published private(set) var route: Route = .launch
    @Published var setupComplete = false

    /// Every transition is animated the same way: slow, mechanical, settled.
    func go(_ to: Route) {
        withAnimation(.timingCurve(0.16, 0.84, 0.24, 1, duration: 0.42)) {
            route = to
        }
    }

    /// The only exit from a refusal. Called by the single control on those
    /// screens; nothing else in the app navigates away from `.refused`.
    func scanAgain() {
        Haptic.tick()
        go(.scanner)
    }

    /// Signing succeeds only when the digest carried through approval is the
    /// digest of the summary being signed. In the shipped app this check is
    /// the bridge's (`signPsbt` takes the shown summary and verifies it); the
    /// shell enforces the same shape so a future regression cannot route
    /// around it.
    func completeSigning(_ tx: TxSummary, reviewedDigest: String) {
        guard reviewedDigest == tx.digest else {
            Haptic.refuse()
            go(.refused(.digestMismatch))
            return
        }
        Haptic.signed()
        go(.signed(tx))
    }
}
