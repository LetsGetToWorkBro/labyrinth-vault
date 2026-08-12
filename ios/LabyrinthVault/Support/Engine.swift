//  Engine.swift
//  The one place Swift talks to the vault.
//
//  Everything that decides anything — what a transaction says, whether it can
//  be signed, what an address is — lives in the TypeScript in `src/`, compiled
//  to `vault.bundle.js` and run here in JavaScriptCore. This file is a
//  telephone, not a participant. It marshals strings and it decodes JSON.
//
//  Why not port the logic to Swift: there would then be two implementations of
//  every derivation and every refusal, and only one of them would have the
//  cross-implementation vectors, the fuzzer and the mutation-tested guards. The
//  second implementation is always the one that is subtly wrong, and on a
//  signing device "subtly wrong" is a well-formed address nobody holds the key
//  for.
//
//  JavaScriptCore is in the operating system. It has no network stack, no DOM,
//  no timers this file does not give it, and no way to reach anything outside
//  the context. That is a smaller surface than any library we could add, and it
//  is the reason this design is available at all.

import CryptoKit
import Foundation
import JavaScriptCore
import Security

/// What the bundle answered, before it means anything.
private struct Envelope: Decodable {
    let ok: Bool
    let problem: String?
    /// Set when the refusal is one the screen has a case for. See
    /// `failCoded` in src/bridge/host.ts.
    let code: String?
}

enum EngineError: LocalizedError {
    case bundleMissing
    case bundleTampered(String)
    case bundleFailed(String)
    case versionMismatch(Int, Int)
    case refused(String)
    /// A refusal the engine named. The words may change; the code is the contract.
    case refusedAs(code: String, why: String)
    case undecodable(String)

    var errorDescription: String? {
        switch self {
        case .bundleMissing:
            "The vault engine is missing from this build."
        case .bundleTampered(let got):
            "The vault engine is not the one this app was built with (\(got.prefix(16))…). "
            + "Nothing was run. Reinstall from a source you trust."
        case .bundleFailed(let why):
            "The vault engine did not load: \(why)"
        case .versionMismatch(let got, let want):
            "This app expects engine \(want) and the bundle is \(got). Reinstall rather than guess."
        case .refused(let why):
            why
        case .refusedAs(_, let why):
            why
        case .undecodable(let what):
            "The engine answered with something this app could not read (\(what))."
        }
    }
}

/// The vault engine.
///
/// One instance, created at launch, held for the life of the process. Keys live
/// inside the JavaScript context and never cross into Swift: this side asks for
/// descriptions, signatures and addresses, and there is no call that returns a
/// private key.
final class Engine {
    /// Must match `HOST_VERSION` in src/bridge/host.ts. A bundle from a
    /// different contract is refused rather than called optimistically.
    static let expectedVersion = 3

    private let context: JSContext
    private let api: JSValue
    private let decoder = JSONDecoder()

    init(bundle: Bundle = .main) throws {
        guard let url = bundle.url(forResource: "vault.bundle", withExtension: "js"),
              let data = try? Data(contentsOf: url)
        else { throw EngineError.bundleMissing }

        /* Measure before running, not after.
         *
         * The engine is a resource file that this app evaluates as code. Code
         * signing covers it at install time and then nothing looks again, so
         * the app looks: hash what was loaded, compare against the constant
         * that scripts/build-bundle.mjs baked into the binary at build time,
         * and refuse before `evaluateScript` if they differ.
         *
         * The asymmetry is the whole point. The digest lives in the signed
         * text segment; the bundle does not. Anything that can rewrite the
         * bundle cannot also rewrite what it is being compared against without
         * breaking the signature that protects the executable itself.
         *
         * Not constant-time, deliberately: both sides of this comparison are
         * public. There is no secret here to leak through timing, and writing
         * it as though there were would suggest to a reader that there is. */
        let measured = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard measured == BundleDigest.sha256 else {
            throw EngineError.bundleTampered(measured)
        }

        guard let source = String(data: data, encoding: .utf8) else {
            throw EngineError.bundleFailed("the engine is not text")
        }

        guard let context = JSContext() else { throw EngineError.bundleFailed("no context") }
        self.context = context

        var thrown: String?
        context.exceptionHandler = { _, value in thrown = value?.toString() ?? "unknown" }
        context.evaluateScript(source)
        if let thrown { throw EngineError.bundleFailed(thrown) }

        guard let api = context.objectForKeyedSubscript("LabyrinthVault"), !api.isUndefined else {
            throw EngineError.bundleFailed("the bundle published nothing")
        }
        self.api = api

        // Check the contract before anything depends on it.
        let version: VersionReply = try decode(raw("version"))
        guard version.version == Engine.expectedVersion else {
            throw EngineError.versionMismatch(version.version, Engine.expectedVersion)
        }
    }

    // MARK: - Calling

    /// Invoke a function on the bundle. Returns its raw JSON string.
    ///
    /// A JavaScript exception cannot reach here — every entry point in host.ts
    /// catches its own — but the handler stays because "cannot" is a claim
    /// about someone else's code and this is the boundary that would crash.
    private func raw(_ name: String, _ arguments: [Any] = []) -> String {
        var thrown: String?
        context.exceptionHandler = { _, value in thrown = value?.toString() ?? "unknown" }
        let result = api.invokeMethod(name, withArguments: arguments)
        if let thrown {
            return #"{"ok":false,"problem":"the engine raised: \#(thrown)"}"#
        }
        return result?.toString() ?? #"{"ok":false,"problem":"the engine answered nothing"}"#
    }

    private func decode<T: Decodable>(_ json: String) throws -> T {
        guard let data = json.data(using: .utf8) else { throw EngineError.undecodable("not text") }
        // The refusal shape first: a failure carries no payload to decode.
        if let envelope = try? decoder.decode(Envelope.self, from: data), !envelope.ok {
            let why = envelope.problem ?? "The vault refused."
            if let code = envelope.code { throw EngineError.refusedAs(code: code, why: why) }
            throw EngineError.refused(why)
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw EngineError.undecodable(String(describing: T.self))
        }
    }

    private func call<T: Decodable>(_ name: String, _ arguments: [Any] = []) throws -> T {
        try decode(raw(name, arguments))
    }

    /// For calls whose only interesting answer is "did it work".
    @discardableResult
    private func callVoid(_ name: String, _ arguments: [Any] = []) throws -> Bool {
        let _: Envelope = try decode(raw(name, arguments))
        return true
    }

    // MARK: - Reply shapes
    // Each mirrors what the matching function in host.ts returns.

    private struct VersionReply: Decodable { let version: Int }
    struct SelfTestReply: Decodable {
        let passed: Bool
        let checks: [Check]
        struct Check: Decodable, Identifiable {
            let name: String
            let proves: String
            let ok: Bool
            let detail: String
            var id: String { name }
        }
    }
    struct CreateReply: Decodable { let sealed: String }
    struct UnlockReply: Decodable {
        let btcAccount: BtcAccount
        let xmrAddress: String
        struct BtcAccount: Decodable { let zpub: String; let first: String }
    }
    struct UnlockedReply: Decodable { let unlocked: Bool }
    /// The watch-only export: the frames to animate, and the account they
    /// carry. `zpub` is optional because the same reply shape serves a Monero
    /// export, which has an address rather than an account key; the one screen
    /// that reads it exports Bitcoin, where it is always present.
    struct ExportReply: Decodable {
        let frames: [String]
        let account: Account
        struct Account: Decodable { let zpub: String? }
    }
    struct BackupReply: Decodable { let bitcoin: [String]; let monero: [String] }
    struct ScanReply: Decodable {
        let format: String?
        let have: Int
        let total: Int
        let kind: String?
        let problem: String?
        let payload: String?
    }
    struct DescribeReply: Decodable { let summary: TxSummary }
    /// Equatable because `Route.xmrSigned` carries it, same as `SignReply`.
    /// The reply also carries the outputs for the record; the screen renders
    /// the summary a person approved, not a re-statement of it, so they are
    /// deliberately not decoded here.
    struct MoneroSignReply: Decodable, Equatable {
        let txid: String
        let network: String
        let keyImages: [String]
        let frames: [String]
    }
    /// Equatable because `Route` carries it and `Route` is Equatable: the
    /// screens compare routes for their animation identity, and a reply that
    /// was not comparable would make the enum uncompilable rather than merely
    /// awkward. Every field already is.
    struct SignReply: Decodable, Equatable {
        let signed: Int
        let txid: String?
        let frames: [String]?
    }
    struct CalibrateReply: Decodable {
        let params: Params
        struct Params: Decodable { let t: Int; let m: Int; let p: Int }
    }
    struct CheckReply: Decodable { let state: String; let note: String? }
    /// Equatable for the same reason as `SignReply`: `Route.keyImages` carries it.
    struct KeyImagesReply: Decodable, Equatable {
        let answered: Int
        let refused: Int
        let frames: [String]
    }

    // MARK: - The API
    //
    // Deliberately one Swift method per host function, same name, no
    // convenience wrappers that call two. `test/app-wiring.test.ts` checks that
    // every name used here exists in host.ts.

    func selfTest() throws -> SelfTestReply { try call("selfTest") }
    func calibrate(targetMs: Int) throws -> CalibrateReply { try call("calibrate", [targetMs]) }

    /// Make a vault.
    ///
    /// The passphrase arrives as bytes and leaves as bytes. It is never a
    /// `String` on this side of the call and never a string on the other side
    /// either: `passphraseFromWire` in host.ts refuses one. A Swift `String`
    /// cannot be overwritten any more than a JavaScript one can, so the text
    /// is turned into bytes at the keyboard — see `Passphrase` — and only the
    /// bytes travel.
    ///
    /// The array is the caller's to zero. This method does not do it, because
    /// `create` and `unlock` are often called with the same passphrase in
    /// sequence and a method that quietly destroyed its argument would be a
    /// trap rather than a courtesy.
    func create(randomHex: String, passphrase: [UInt8], extraHex: String = "") throws -> CreateReply {
        try call("create", [randomHex, passphrase, extraHex])
    }

    func unlock(sealedHex: String, passphrase: [UInt8]) throws -> UnlockReply {
        try call("unlock", [sealedHex, passphrase])
    }

    func lock() { _ = try? callVoid("lock") }
    func isUnlocked() -> Bool { ((try? call("unlocked")) as UnlockedReply?)?.unlocked ?? false }

    func exportAccount(chain: String) throws -> ExportReply { try call("exportAccount", [chain]) }
    func revealBackup() throws -> BackupReply { try call("revealBackup") }

    func scan(_ text: String) throws -> ScanReply { try call("scan", [text]) }
    func scanReset() { _ = try? callVoid("scanReset") }

    func describe(psbtHex: String) throws -> TxSummary {
        let reply: DescribeReply = try call("describe", [psbtHex])
        return reply.summary
    }

    /// Sign, quoting the digest of the summary that was actually on screen.
    ///
    /// The summary object never crosses the bridge and back: re-serialising it
    /// would be a second chance for what gets signed to differ from what was
    /// read. Only the digest travels, and the engine compares it against the
    /// description it produced.
    func sign(psbtHex: String, approvedDigest: String) throws -> SignReply {
        try call("sign", [psbtHex, approvedDigest])
    }

    /// Read an unsigned Monero set. The engine parses, re-derives the change
    /// against the vault's own keys, remembers the digest, and answers with
    /// the summary the confirmation screen renders. Same describe-then-approve
    /// contract as `describe`/`sign`.
    func moneroDescribe(payloadHex: String) throws -> MoneroSummary {
        try call("moneroDescribe", [payloadHex])
    }

    /// Sign the described set, quoting the digest that was on screen and
    /// handing over exactly the randomness the description asked for. The
    /// engine re-checks the digest against what it described; a stale or
    /// altered approval fails there rather than signing.
    func moneroSign(approvedDigest: String, randomHex: String) throws -> MoneroSignReply {
        try call("moneroSign", [approvedDigest, randomHex])
    }

    /// Fresh platform randomness, hex-encoded, for the entropy arguments the
    /// engine takes. `SecRandomCopyBytes` is the platform CSPRNG; a failure —
    /// which documented practice treats as effectively impossible — returns
    /// nil rather than weaker bytes, and the caller refuses to proceed.
    static func freshRandomHex(bytes count: Int) -> String? {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else { return nil }
        defer { for i in bytes.indices { bytes[i] = 0 } }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// Key images for outputs the companion's scan found.
    ///
    /// The engine re-proves ownership of every output from this device's own
    /// keys before deriving anything, and the reply separates answered from
    /// refused so the screen can show both numbers rather than a total that
    /// quietly shrank.
    func moneroKeyImages(payloadHex: String) throws -> KeyImagesReply {
        try call("moneroKeyImages", [payloadHex])
    }

    func checkAddress(_ text: String, chain: String) throws -> CheckReply {
        try call("checkAddress", [text, chain])
    }
    func checkPhrase(_ text: String) throws -> CheckReply { try call("checkPhrase", [text]) }
    func checkExtendedKey(_ text: String) throws -> CheckReply { try call("checkExtendedKey", [text]) }
}
