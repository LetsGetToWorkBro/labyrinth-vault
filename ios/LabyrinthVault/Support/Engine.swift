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
// The native Argon2id, and the vendored reference C beneath it. A separate
// module because it is a separate SwiftPM target, which is what lets
// `swift build` check it on every `npm test` with no Xcode anywhere. The price
// of that separation is this line: Xcode is the only thing that type checks
// this file, so a missing import is a failed archive and nothing sooner.
// test/app-wiring.test.ts holds the import to the use.
import LabyrinthVaultKDF
import Security

/// What the bundle answered, before it means anything.
/// The vault engine.
///
/// One instance, created at launch, held for the life of the process. Keys live
/// inside the JavaScript context and never cross into Swift: this side asks for
/// descriptions, signatures and addresses, and there is no call that returns a
/// private key.
final class Engine {
    /// Must match `HOST_VERSION` in src/bridge/host.ts. A bundle from a
    /// different contract is refused rather than called optimistically.
    static let expectedVersion = 5

    private let context: JSContext
    private let api: JSValue
    /// Whether the engine adopted the native derivation at boot. Surfaced on
    /// the Settings screen next to the bundle digest.
    private(set) var kdfIsNative = false
    /// Whether the vendored CryptoNight reached the engine. False means the
    /// Monero key-image export other wallets read cannot be produced, and the
    /// engine refuses it rather than encrypting under a substitute.
    private(set) var cryptonightIsNative = false
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

        /* ## The one function that goes the other way
         *
         * Every other call crosses Swift to JavaScript. This one is installed
         * before the bundle is evaluated so that the bundle's top level can
         * find it, because a derivation adopted later would mean two sessions
         * of the same app deriving keys by different routes.
         *
         * Only the derivation crosses. It is handed bytes and four numbers and
         * hands back bytes; it is told nothing about vaults, blobs, headers or
         * limits, and it decides nothing. What a parameter may be and what
         * gets refused stays in src/keys/seal.ts. docs/native-primitives.md
         * argues why this function is allowed to leave and its neighbours are
         * not.
         *
         * Arrays of numbers rather than hex, because a hex passphrase would be
         * an immutable JavaScript string, which is exactly what Passphrase.swift
         * exists to keep it from being. */
        let derive: @convention(block) ([Any], [Any], Int, Int, Int, Int) -> [UInt8]? = {
            passphrase, salt, t, m, p, dkLen in
            var passBytes = passphrase.compactMap { ($0 as? NSNumber).map { n in UInt8(truncatingIfNeeded: n.intValue) } }
            let saltBytes = salt.compactMap { ($0 as? NSNumber).map { n in UInt8(truncatingIfNeeded: n.intValue) } }
            defer { for i in passBytes.indices { passBytes[i] = 0 } }
            guard passBytes.count == passphrase.count, saltBytes.count == salt.count else { return nil }
            /* Refusals come back as nil, never as a short key: seal.ts checks
             * the length and falls back to its own Argon2id, so a refusal
             * costs a slow unlock and never a weaker vault. */
            return try? Argon2id.deriveKey(passphrase: passBytes, salt: saltBytes,
                                           t: t, m: m, p: p, dkLen: dkLen)
        }
        context.setObject(derive, forKeyedSubscript: "__labyrinthArgon2id" as NSString)

        /* CryptoNight, for the Monero key-image export and nothing else.
         *
         * Installed the same way and before the same `evaluateScript`, with
         * one difference in what a failure means. The KDF above has a
         * JavaScript implementation behind it, so a nil return costs a slow
         * unlock. This has none: `chachaKeyFor` in the engine refuses when
         * nothing was installed, because the alternative is an export file
         * encrypted under a key Monero would never have derived — a file that
         * looks correct, imports into no wallet, and quietly reports the wrong
         * balance to whoever trusted it.
         *
         * So this returns nil on failure and the engine turns that into a
         * refusal, rather than either side substituting something plausible. */
        let cnSlowHash: @convention(block) ([NSNumber]) -> [NSNumber]? = { data in
            let input = data.map { $0.uint8Value }
            let digest = CryptoNight.slowHashV0(input)
            return digest.map { NSNumber(value: $0) }
        }
        context.setObject(cnSlowHash, forKeyedSubscript: "__labyrinthCnSlowHash" as NSString)

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
        /* Recorded rather than enforced. A build where the native derivation
         * failed to install still works — it is the app people have been using
         * — it is just a minute slower per unlock, and that is a difference
         * worth being able to see rather than guess at. */
        self.kdfIsNative = version.kdf == "native"
        /* Same treatment: recorded, not enforced. A build without it signs and
         * computes key images exactly as before; the one thing it cannot do is
         * write the file Cake and Feather import, and the screen that offers
         * that is the place to say so. */
        self.cryptonightIsNative = version.cryptonight == "native"
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

    /* The reading itself, including the rule that a refusal is read before a
     * payload, is in EngineReplies.swift under test. This is only the
     * decoder instance. */
    private func decode<T: Decodable>(_ json: String) throws -> T {
        try decodeReply(json, using: decoder)
    }

    private func call<T: Decodable>(_ name: String, _ arguments: [Any] = []) throws -> T {
        try decode(raw(name, arguments))
    }

    /// For calls whose only interesting answer is "did it work".
    @discardableResult
    private func callVoid(_ name: String, _ arguments: [Any] = []) throws -> Bool {
        let _: EngineEnvelope = try decode(raw(name, arguments))
        return true
    }

    // MARK: - Reply shapes
    // Each mirrors what the matching function in host.ts returns.

    /* The shapes themselves are in EngineReplies.swift, which a compiler can
     * reach without Xcode. These aliases keep every call site written as
     * `Engine.SignReply` and make this list the manifest of what the engine
     * can answer: a reply added without an entry here fails to compile where
     * it is used, which is where somebody will be looking. */
    typealias VersionReply = EngineReply.Version
    typealias SelfTestReply = EngineReply.SelfTest
    typealias CreateReply = EngineReply.Create
    typealias UnlockReply = EngineReply.Unlock
    typealias UnlockedReply = EngineReply.Unlocked
    typealias ExportReply = EngineReply.Export
    typealias DemoReply = EngineReply.Demo
    typealias BackupReply = EngineReply.Backup
    typealias ScanReply = EngineReply.Scan
    typealias DescribeReply = EngineReply.Describe
    typealias MoneroSignReply = EngineReply.MoneroSign
    typealias SignReply = EngineReply.Sign
    typealias CalibrateReply = EngineReply.Calibrate
    typealias CheckReply = EngineReply.Check
    typealias KeyImagesReply = EngineReply.KeyImages

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

    /// Re-seal a vault under a different passphrase, without opening a session.
    ///
    /// The secret never crosses this bridge: the engine unseals and re-seals
    /// inside its own context and hands back a blob. Used by the migration
    /// that moves a vault onto the two-layer scheme.
    func reseal(sealedHex: String, from: [UInt8], to: [UInt8], randomHex: String) throws -> CreateReply {
        try call("reseal", [sealedHex, from, to, randomHex])
    }

    func unlock(sealedHex: String, passphrase: [UInt8]) throws -> UnlockReply {
        try call("unlock", [sealedHex, passphrase])
    }

    func lock() { _ = try? callVoid("lock") }
    func isUnlocked() -> Bool { ((try? call("unlocked")) as UnlockedReply?)?.unlocked ?? false }

    func exportAccount(chain: String) throws -> ExportReply { try call("exportAccount", [chain]) }

    /// Simulator only: a demo transaction as scannable frames. Opens the demo
    /// vault into the session as a side effect, so `describe` and `sign` then
    /// work on it exactly as they would for a scanned one. See host.ts.
    func demoUnsigned() throws -> DemoReply { try call("demoUnsigned") }
    func revealBackup() throws -> BackupReply { try call("revealBackup") }

    func scan(_ text: String) throws -> ScanReply { try call("scan", [text]) }
    func scanReset() { _ = try? callVoid("scanReset") }

    func describe(psbtHex: String) throws -> TxSummary {
        let reply: DescribeReply = try call("describe", [psbtHex])
        return reply.summary
    }

    /// Sign, quoting the digest of the summary that was actually on screen.
    ///
    /// The summary object never crosses the bridge and back: re-serializing it
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
    /// Fresh bytes from the platform CSPRNG, or nil. Never a weaker substitute.
    static func freshRandomBytes(_ count: Int) -> [UInt8]? {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else { return nil }
        return bytes
    }

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
