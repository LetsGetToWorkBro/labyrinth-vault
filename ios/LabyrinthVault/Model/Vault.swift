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

/// One output being paid. Mirrors `WireOutput` in src/bridge/summary.ts.
struct TxOutput: Equatable, Decodable {
    let position: Int
    /// Nil when the script decodes to no address. The screen must say so
    /// rather than draw a blank where a destination goes; the reader has
    /// already made it fatal when it carries money.
    let address: String?
    let scriptHex: String
    /// Formatted upstream. Nothing here divides by a hundred million.
    let amount: String
    let mine: Bool
    let path: String?
}

/// One previous output being spent. Mirrors `WireInput`.
struct TxInput: Equatable, Decodable {
    let position: Int
    let txid: String
    let vout: Int
    /// Nil when the PSBT did not say what it was worth, which is fatal.
    let amount: String?
    let address: String?
    let mine: Bool
    let path: String?
}

struct TxWarning: Equatable, Decodable {
    let code: String
    let fatal: Bool
    let message: String
}

/// What the confirmation screen is allowed to know.
///
/// Field for field, this is `WireSummary` in src/bridge/summary.ts, and
/// `test/app-wiring.test.ts` fails if the two drift apart. Every amount
/// arrives already formatted, because a second implementation of what a
/// satoshi is worth is how two screens come to disagree about a number.
///
/// It carries *every* output, not one destination. The version before this
/// had a single `destination`, which meant a transaction paying two people
/// would have shown one of them, and money would have left to an address
/// nobody approving it ever saw.
struct TxSummary: Equatable, Decodable {
    let ok: Bool
    let problem: String?
    /// Digest of the described bytes. Carried from review to approval to
    /// signing so that describing one transaction and signing another fails.
    let digest: String
    /// Which keyring it was described against.
    let walletId: String
    let inputs: [TxInput]
    let outputs: [TxOutput]
    let spending: String
    let leaving: String
    let returning: String
    /// The number to put next to the word "paying". Not `leaving`.
    let yourNet: String
    let fee: String?
    let feeRate: String?
    /// "~208 vB". An estimate, worded as one upstream.
    let vsize: String
    /// "0.03%". Nil when nothing is being paid, so there is no share to take.
    let feeShare: String?
    let warnings: [TxWarning]
    let signable: Bool
    /// The first fatal warning's code, if any.
    let refusal: String?

    // MARK: Derived, and derived means arranged — never recomputed.

    /// The outputs that are not yours: what this transaction actually pays.
    var payees: [TxOutput] { outputs.filter { !$0.mine } }
    /// The outputs coming back to you.
    var change: [TxOutput] { outputs.filter { $0.mine } }
    /// True when there is more than one payee, which the screen must list
    /// rather than summarise.
    var paysSeveral: Bool { payees.count > 1 }
    /// True when any output has no address a person could read.
    var hasUnreadableOutput: Bool { outputs.contains { $0.address == nil } }
    var asset: Asset { .btc }
}

enum Asset: String {
    case btc = "BTC"
    case xmr = "XMR"
    var color: Color { self == .btc ? Ink.btc : Ink.xmr }
    var name: String { self == .btc ? "BITCOIN" : "MONERO" }
}

/// Every condition the reader refuses over: one case per fatal warning code in
/// src/keys/psbt.ts, plus the named refusals the bridge raises directly, such
/// as a Monero wallet file this build cannot open. Each is fatal: there is
/// deliberately no associated "override" payload, and no case carries a way to
/// continue.
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
    /// `monero-file-unsupported`
    case moneroFile
    /// The approval digest or wallet check in `signPsbt`.
    case digestMismatch
    /// A fatal code this build does not have a case for. Refuses anyway.
    case unrecognised(String)

    /// Map a fatal warning code from src/keys/psbt.ts onto a screen.
    ///
    /// The default is `unrecognised`, and `unrecognised` refuses. A code this
    /// build has no words for is still a reason to stop, and the one thing
    /// this initialiser must never do is return nil and let a caller carry on.
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
        case .moneroFile: ["MONERO", "NOT YET"]
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
        case .moneroFile: ["THIS IS A MONERO", "WALLET FILE. THE", "VAULT CANNOT OPEN IT."]
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
        case .sighashFlags:
            "This transaction asks to be signed in a way that does not commit to where the money " +
            "goes. A signature like that can be lifted out and reused around outputs nobody " +
            "showed you, so the only safe reading of the request is that it is not the request " +
            "it appears to be."
        case .duplicateInput:
            "The same coin appears as an input twice. It can only be spent once, so every total " +
            "computed from this transaction — what leaves, what returns, what the fee is — is a " +
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
            "This is one of Monero's own wallet files, and it is a perfectly good one — the " +
            "vault recognises the header. What it cannot do is open it: everything past the " +
            "header is encrypted with a key derived by CryptoNight, which this build does not " +
            "implement, and signing a Monero transaction needs CLSAG ring signatures on top of " +
            "that. Bitcoin signing works today. Monero here is keys, addresses and recovery " +
            "phrases only. Nothing was signed and nothing was changed."
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
        case .moneroFile: [
            ("MONERO WALLET FILE RECOGNISED", true),
            ("CONTENTS ENCRYPTED · CANNOT OPEN", false),
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
    /// A single-payee transaction, the ordinary case.
    static let tx = TxSummary(
        ok: true,
        problem: nil,
        digest: "9F2A1C04E7B83D56",
        walletId: "7f21a9c40b3e5d81",
        inputs: [
            TxInput(position: 1, txid: "c1d0a4f7e2b95836aa41c07d9e3f5b28c1d0a4f7e2b95836aa41c07d9e3f5b28",
                    vout: 0, amount: "0.400000", address: "bc1q3f8w2n5k7v0zqxr4mtd9jl6cshy8pae2guv1k0",
                    mine: true, path: "m/84'/0'/0'/0/4"),
            TxInput(position: 2, txid: "9b7e3d21c5a04f68d2e91b7c3a5f80d49b7e3d21c5a04f68d2e91b7c3a5f80d4",
                    vout: 1, amount: "0.250764", address: "bc1qz0m5r8t2xkw4hvn7dq3js6el9cyu1pafg2b4x7",
                    mine: true, path: "m/84'/0'/0'/0/9"),
            TxInput(position: 3, txid: "44a1f6b8e07c2d35910bf4a6c8d2e7539b0c4a1f6b8e07c2d35910bf4a6c8d2e",
                    vout: 0, amount: "0.150000", address: "bc1qw6s2j9k4v7n0dtxr3mhq8lz5cfa1pue3gyb0d2",
                    mine: true, path: "m/84'/0'/0'/0/12"),
        ],
        outputs: [
            TxOutput(position: 1, address: "bc1q7k9x2t4vlqz8m3n0d5r6sgu9hj2wf4paeyc3lz",
                     scriptHex: "0014f58a6b2c9d0e4713a85f2c6b90d4e7318a52c0fb",
                     amount: "0.482731", mine: false, path: nil),
            TxOutput(position: 2, address: "bc1q9m4v0xr2ekstd7q5c3jag8huw6zfn2ypl4v0d3",
                     scriptHex: "00142ec7b90a5f13d846c02b7e59a1d38f640c9a7b25",
                     amount: "0.317891", mine: true, path: "m/84'/0'/0'/1/17"),
        ],
        spending: "0.800764",
        leaving: "0.482731",
        returning: "0.317891",
        yourNet: "0.482873",
        fee: "0.000142",
        feeRate: "68 sat/vB",
        vsize: "~208 vB",
        feeShare: "0.03%",
        warnings: [],
        signable: true,
        refusal: nil
    )

    /// Two payees. Staged deliberately: the model this replaced could not
    /// represent it, so the screen would have shown one of the two.
    static let txMultiPayee = TxSummary(
        ok: true,
        problem: nil,
        digest: "3D71B0C82E9F4A65",
        walletId: "7f21a9c40b3e5d81",
        inputs: [
            TxInput(position: 1, txid: "c1d0a4f7e2b95836aa41c07d9e3f5b28c1d0a4f7e2b95836aa41c07d9e3f5b28",
                    vout: 0, amount: "1.000000", address: "bc1q3f8w2n5k7v0zqxr4mtd9jl6cshy8pae2guv1k0",
                    mine: true, path: "m/84'/0'/0'/0/4"),
        ],
        outputs: [
            TxOutput(position: 1, address: "bc1q7k9x2t4vlqz8m3n0d5r6sgu9hj2wf4paeyc3lz",
                     scriptHex: "0014f58a6b2c9d0e4713a85f2c6b90d4e7318a52c0fb",
                     amount: "0.300000", mine: false, path: nil),
            TxOutput(position: 2, address: "bc1qr2v8m0kt5x7cwe4nj9dqh3zs6la1pfug0yb2d5",
                     scriptHex: "001485c3f0a72b9e461d0af35c28d61b93e7420cf58a",
                     amount: "0.450000", mine: false, path: nil),
            TxOutput(position: 3, address: "bc1q9m4v0xr2ekstd7q5c3jag8huw6zfn2ypl4v0d3",
                     scriptHex: "00142ec7b90a5f13d846c02b7e59a1d38f640c9a7b25",
                     amount: "0.249800", mine: true, path: "m/84'/0'/0'/1/18"),
        ],
        spending: "1.000000",
        leaving: "0.750000",
        returning: "0.249800",
        yourNet: "0.750200",
        fee: "0.000200",
        feeRate: "71 sat/vB",
        vsize: "~141 vB",
        feeShare: "0.03%",
        warnings: [],
        signable: true,
        refusal: nil
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
    /// Inspecting one specific output, not "the" destination: a
    /// transaction can pay several, and each is checked on its own.
    case destination(TxSummary, TxOutput)
    case approve(TxSummary, reviewedDigest: String)
    /// The signed result travels with the summary: the frames to show and
    /// the txid come from the engine, not from a fixture.
    case signed(TxSummary, Engine.SignReply)
    case signedQR(TxSummary, Engine.SignReply)
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
    /// The launch gate's verdict. Nothing else runs until this passes.
    @Published private(set) var checks: [Engine.SelfTestReply.Check] = []
    @Published private(set) var engineProblem: String?
    /// Frames gathered so far, for the scanner's progress line.
    @Published private(set) var scanProgress: (have: Int, total: Int) = (0, 0)

    private var engine: Engine?
    /// The transaction currently being read, kept so signing uses the same
    /// bytes the description was made from.
    private var pendingPsbtHex: String?

    var isUnlocked: Bool { engine?.isUnlocked() ?? false }

    /// A short name for this vault, derived from its own account key rather
    /// than invented. Two devices holding the same keys show the same id, and
    /// that is the point: it is how somebody checks they are looking at the
    /// wallet they think they are.
    @Published private(set) var vaultID = "•••• •••• ••••"
    @Published private(set) var fingerprint = "········"

    func exportAccount(chain: String) throws -> Engine.ExportReply {
        guard let engine else { throw EngineError.bundleMissing }
        return try engine.exportAccount(chain: chain)
    }

    /// The recovery words, for the one screen that asks somebody to write them
    /// down. Nothing caches the result.
    func revealBackup() throws -> Engine.BackupReply {
        guard let engine else { throw EngineError.bundleMissing }
        return try engine.revealBackup()
    }

    // MARK: - Launch

    /// Load the engine and make it prove itself.
    ///
    /// A failure here is terminal by design. There is no "continue anyway":
    /// a device whose derivation no longer matches the published vectors has
    /// one honest behaviour, and it is to say so and stop.
    func boot() {
        do {
            let engine = try Engine()
            self.engine = engine
            let result = try engine.selfTest()
            checks = result.checks
            engineProblem = result.passed ? nil : "The vault failed its own checks."
        } catch {
            checks = []
            engineProblem = error.localizedDescription
        }
    }

    var launchPassed: Bool { engineProblem == nil && !checks.isEmpty && checks.allSatisfy(\.ok) }

    // MARK: - The session

    /// Open the vault.
    ///
    /// The passphrase is turned into bytes and zeroed on the way out, on every
    /// path including the throwing one — see Passphrase.swift for why a
    /// `String` is not good enough here. What the text field itself is holding
    /// is the caller's problem and should be cleared as soon as this returns.
    func unlock(passphrase: String, sealedHex: String) -> String? {
        guard let engine else { return "The vault engine is not loaded." }
        do {
            let opened = try Passphrase.withBytes(of: passphrase) { bytes in
                try engine.unlock(sealedHex: sealedHex, passphrase: bytes)
            }
            // Identity from the account key, so it means something.
            let tail = String(opened.btcAccount.zpub.suffix(12)).uppercased()
            vaultID = stride(from: 0, to: tail.count, by: 4)
                .map { i -> String in
                    let s = tail.index(tail.startIndex, offsetBy: i)
                    let e = tail.index(s, offsetBy: min(4, tail.count - i))
                    return String(tail[s..<e])
                }
                .joined(separator: " ")
            fingerprint = String(opened.btcAccount.first.suffix(8)).uppercased()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Called on lock, on backgrounding and on the app switcher. Wipes keys.
    func lock() {
        engine?.lock()
        pendingPsbtHex = nil
        scanProgress = (0, 0)
        vaultID = "•••• •••• ••••"
        fingerprint = "········"
    }

    // MARK: - Scanning, and what a completed scan becomes

    func scanAgain() {
        Haptic.tick()
        engine?.scanReset()
        pendingPsbtHex = nil
        scanProgress = (0, 0)
        go(.scanner)
    }

    /// Offer one frame from the camera.
    ///
    /// When a payload completes, it is described immediately and the result
    /// decides the route: a refusal goes to the refusal screen and cannot
    /// reach review at all, which is the property the routes exist to encode.
    func offer(frame text: String) {
        guard let engine else { return }

        let reply: Engine.ScanReply
        do {
            reply = try engine.scan(text)
        } catch EngineError.refusedAs(let code, _) {
            /* The scanner named what it was looking at. A frame it simply does
             * not recognise is not an error and lands in the `catch` below,
             * where staying silent is right: the camera is still running and
             * the next frame may be the one. A *named* refusal is different —
             * the engine knows exactly what this is — so it gets a screen. */
            Haptic.refuse()
            go(.refused(Refusal(code: code)))
            return
        } catch {
            return
        }

        scanProgress = (reply.have, reply.total)
        guard let payload = reply.payload else { return }

        pendingPsbtHex = payload
        do {
            let summary = try engine.describe(psbtHex: payload)
            if let code = summary.refusal {
                Haptic.refuse()
                go(.refused(Refusal(code: code)))
            } else {
                Haptic.tick()
                go(.review(summary))
            }
        } catch EngineError.refusedAs(let code, _) {
            Haptic.refuse()
            go(.refused(Refusal(code: code)))
        } catch {
            Haptic.refuse()
            go(.refused(.unreadable))
        }
    }

    // MARK: - Signing

    /// Every transition is animated the same way: slow, mechanical, settled.
    func go(_ to: Route) {
        withAnimation(.timingCurve(0.16, 0.84, 0.24, 1, duration: 0.42)) {
            route = to
        }
    }

    /// Sign, quoting the digest of the summary that was on screen.
    ///
    /// Two checks, deliberately not one. The shell compares the digest it is
    /// carrying against the summary it is about to sign, and the engine
    /// compares that digest against the description it produced. Either alone
    /// would do on a good day; the point is that a refactor has to defeat
    /// both.
    func completeSigning(_ tx: TxSummary, reviewedDigest: String) {
        guard reviewedDigest == tx.digest else {
            Haptic.refuse()
            go(.refused(.digestMismatch))
            return
        }
        guard let engine, let psbt = pendingPsbtHex else {
            Haptic.refuse()
            go(.refused(.unreadable))
            return
        }
        do {
            let signed = try engine.sign(psbtHex: psbt, approvedDigest: reviewedDigest)
            Haptic.signed()
            go(.signed(tx, signed))
        } catch {
            Haptic.refuse()
            go(.refused(.digestMismatch))
        }
    }
}
