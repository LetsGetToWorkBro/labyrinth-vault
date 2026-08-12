//  Vault.swift
//  The application state machine, and the shapes the screens render.
//
//  The routes encode the security model. There is no route from a refusal to
//  anywhere but the scanner, and no way to construct `.approve` without the
//  reviewed summary — the same digest-carrying contract as `signPsbt` in
//  src/keys/psbt.ts: the bytes a person saw are the bytes that get signed.

import SwiftUI
import Combine

/// Which chain a summary is about.
///
/// Lives here rather than beside `TxSummary` because it carries a `Color`, and
/// the point of that file is that it has no SwiftUI in it.
extension TxSummary {
    var asset: Asset { .btc }
}

enum Asset: String {
    case btc = "BTC"
    case xmr = "XMR"
    var color: Color { self == .btc ? Ink.btc : Ink.xmr }
    var name: String { self == .btc ? "BITCOIN" : "MONERO" }
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
    /// The Monero flow, one case per face, mapping onto the *same* route
    /// kinds as the Bitcoin flow — `Flow.allowed` does not know which chain a
    /// summary describes, and must not: the rules about what may precede a
    /// signature are chain-independent, and two tables would be two chances
    /// for one of them to be wrong.
    case xmrReview(MoneroSummary)
    case xmrDestination(MoneroSummary, MoneroOutput)
    case xmrApprove(MoneroSummary, reviewedDigest: String)
    case xmrSigned(MoneroSummary, Engine.MoneroSignReply)
    case xmrSignedQR(MoneroSummary, Engine.MoneroSignReply)
    /// The answer to a companion's key image request: how many were
    /// computed, how many refused, and the frames to show back.
    case keyImages(Engine.KeyImagesReply)
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
    /// one honest behavior, and it is to say so and stop.
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
            // Identity from the account key, so it means something. The
            // formatting lives in Model/Identity.swift, where it is compiled
            // and tested off-device.
            vaultID = Identity.vaultID(fromAccountKey: opened.btcAccount.zpub)
            fingerprint = Identity.fingerprint(fromFirstAddress: opened.btcAccount.first)
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

    /// STAGED, Simulator only. The demo transaction's frames from the engine,
    /// which also opens the demo vault so the sign that follows is genuine.
    /// Feeding these through `offer(frame:)` drives the same describe-and-route
    /// path a scanned transaction takes, so the whole flow can be walked where
    /// there is no camera and no companion.
    func demoFrames() -> [String] {
        guard let engine else { return [] }
        return (try? engine.demoUnsigned())?.frames ?? []
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
             * not recognize is not an error and lands in the `catch` below,
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

        /* Dispatch on what arrived, not on what was expected. A key image
         * request is the companion doing Monero bookkeeping, and describing
         * it as a transaction would refuse a payload the engine understands
         * perfectly well. */
        if reply.kind == "XMROUTPUTS" {
            do {
                let answer = try engine.moneroKeyImages(payloadHex: payload)
                Haptic.tick()
                go(.keyImages(answer))
            } catch EngineError.refusedAs(let code, _) {
                Haptic.refuse()
                go(.refused(Refusal(code: code)))
            } catch {
                Haptic.refuse()
                go(.refused(.unreadable))
            }
            return
        }

        if reply.kind == "XMRUNSIGNED" {
            do {
                let summary = try engine.moneroDescribe(payloadHex: payload)
                Haptic.tick()
                go(.xmrReview(summary))
            } catch EngineError.refusedAs(let code, _) {
                Haptic.refuse()
                go(.refused(Refusal(code: code)))
            } catch {
                /* parseUnsignedSet speaks in sentences, not codes: a claimed
                 * change that does not re-derive, a ring whose real member is
                 * missing, a malformed amount. Each is fatal and none carries
                 * an override, so they all land on the refusal screen with
                 * the engine's own words. */
                Haptic.refuse()
                go(.refused(.unreadable))
            }
            return
        }

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
    ///
    /// And checked. The legality of a move lives in `Flow.allowed`, which is
    /// compiled and tested off-device; this method maps the routes to their
    /// kinds and asks. An illegal transition is a programming error, so debug
    /// builds stop on it, and a release build refuses to move, which leaves
    /// the person on a coherent screen rather than an impossible one.
    func go(_ to: Route) {
        guard Flow.allowed(from: kind(of: route), to: kind(of: to)) else {
            assertionFailure("illegal route transition: \(kind(of: route)) -> \(kind(of: to))")
            return
        }
        withAnimation(.timingCurve(0.16, 0.84, 0.24, 1, duration: 0.42)) {
            route = to
        }
    }

    private func kind(of route: Route) -> RouteKind {
        switch route {
        case .launch: .launch
        case .setup: .setup
        case .home: .home
        case .airgap: .airgap
        case .export: .export
        case .scanner: .scanner
        case .acquiring: .acquiring
        case .received: .received
        case .review: .review
        case .destination: .destination
        case .approve: .approve
        case .signed: .signed
        case .signedQR: .signedQR
        case .xmrReview: .review
        case .xmrDestination: .destination
        case .xmrApprove: .approve
        case .xmrSigned: .signed
        case .xmrSignedQR: .signedQR
        case .keyImages: .keyImages
        case .refused: .refused
        case .settings: .settings
        case .bitcoin: .bitcoin
        case .monero: .monero
        case .recovery: .recovery
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

    /// Sign the Monero set, same double check as the Bitcoin path: the shell
    /// compares the digest it carried against the summary it is about to
    /// sign, and the engine compares that digest against the set it described.
    ///
    /// The randomness is drawn here, at the call site, in exactly the amount
    /// the description stated — the engine owns the formula and refuses any
    /// other length. If the platform CSPRNG fails (which documented practice
    /// treats as impossible), nothing weaker is substituted: the signing
    /// simply does not happen.
    func completeMoneroSigning(_ tx: MoneroSummary, reviewedDigest: String) {
        guard reviewedDigest == tx.digest else {
            Haptic.refuse()
            go(.refused(.digestMismatch))
            return
        }
        guard let engine, let randomHex = Engine.freshRandomHex(bytes: tx.randomBytes) else {
            Haptic.refuse()
            go(.refused(.unreadable))
            return
        }
        do {
            let signed = try engine.moneroSign(approvedDigest: reviewedDigest, randomHex: randomHex)
            Haptic.signed()
            go(.xmrSigned(tx, signed))
        } catch EngineError.refusedAs(let code, _) {
            Haptic.refuse()
            go(.refused(Refusal(code: code)))
        } catch {
            Haptic.refuse()
            go(.refused(.digestMismatch))
        }
    }
}
