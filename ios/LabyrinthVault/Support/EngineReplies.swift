//  EngineReplies.swift
//  The boundary where the engine's answers become Swift values.
//
//  ## Why this is its own file
//
//  It used to live inside Engine.swift, which imports JavaScriptCore and
//  CryptoKit and therefore cannot be built anywhere but Xcode. That put the
//  one place untrusted output turns into typed values on the wrong side of a
//  line drawn for an unrelated reason: nothing here needs a JavaScript
//  context, and everything here is worth a compiler and a test.
//
//  What stayed behind is genuinely Apple's: the JSContext, the bundle digest,
//  and `raw`, which pulls a string out of a JSValue. What moved is the refusal
//  envelope, the error vocabulary, the reply shapes and the decode. That is
//  the part where a mistake is a wrong number on a confirmation screen.
//
//  ## The rule this file exists to hold
//
//  **A refusal is read before a payload, always.** `src/bridge/host.ts` answers
//  every call with either `{ok: false, problem, code?}` or a result, on the
//  same channel. If the payload were decoded first, a refusal whose shape
//  happened to satisfy the expected type would be read as a success, and the
//  screen would render an answer to a question the engine declined. So the
//  envelope is tried first and a failing one throws, and `decodeReply` is the
//  only way replies are read.
//
//  ## Names
//
//  Namespaced under `EngineReply` rather than left loose, so that the
//  typealiases in Engine.swift keep every existing `Engine.SignReply` call
//  site working. The typealias list is deliberate: it is the manifest of what
//  the engine can answer, in one place, and a new reply that forgets to appear
//  there will not compile at its call site.

import Foundation

/// The shape every host answer shares. See `failCoded` in src/bridge/host.ts.
struct EngineEnvelope: Decodable {
    let ok: Bool
    let problem: String?
    /// Set when the refusal is one the screen has a case for.
    let code: String?
}

enum EngineError: LocalizedError, Equatable {
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

/// Every shape the engine can answer with. One per host function, same name.
enum EngineReply {
    /// `kdf` says which implementation a derivation would actually use:
    /// "native" once the host's Argon2id has been adopted, "engine" when the
    /// interpreted one is still doing the work. Optional so that a bundle
    /// built before this existed still decodes rather than failing the launch
    /// gate over a field nobody had heard of.
    ///
    /// It is worth reporting because the failure it catches is silent. A
    /// native derivation that never gets installed is not an error anywhere;
    /// it is an unlock that takes a minute, on a build that was supposed to
    /// take a second, with nothing on screen to say which happened.
    struct Version: Decodable {
        let version: Int
        let kdf: String?
    }

    struct SelfTest: Decodable {
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

    struct Create: Decodable { let sealed: String }

    struct Unlock: Decodable {
        let btcAccount: BtcAccount
        let xmrAddress: String
        struct BtcAccount: Decodable { let zpub: String; let first: String }
    }

    struct Unlocked: Decodable { let unlocked: Bool }

    /// The watch-only export: the frames to animate, and the account they
    /// carry. `zpub` is optional because the same reply shape serves a Monero
    /// export, which has an address rather than an account key; the one screen
    /// that reads it exports Bitcoin, where it is always present.
    struct Export: Decodable {
        let frames: [String]
        /// `ur:crypto-account`, for a wallet that is not ours. Nil for Monero,
        /// which the registry has no type for, and nil for a watch-only
        /// wallet, which has no master key to fingerprint.
        let urFrames: [String]?
        let account: Account
        struct Account: Decodable { let zpub: String? }
    }

    /// The built-in demo transaction's frames.
    struct Demo: Decodable { let frames: [String] }

    struct Backup: Decodable { let bitcoin: [String]; let monero: [String] }

    struct Scan: Decodable {
        let format: String?
        let have: Int
        let total: Int
        let kind: String?
        let problem: String?
        let payload: String?
    }

    struct Describe: Decodable { let summary: TxSummary }

    /// Equatable because `Route.xmrSigned` carries it, same as `Sign`. The
    /// reply also carries the outputs for the record; the screen renders the
    /// summary a person approved, not a re-statement of it, so they are
    /// deliberately not decoded here.
    struct MoneroSign: Decodable, Equatable {
        let txid: String
        let network: String
        let keyImages: [String]
        let frames: [String]
    }

    /// Equatable because `Route` carries it and `Route` is Equatable: the
    /// screens compare routes for their animation identity, and a reply that
    /// was not comparable would make the enum uncompilable rather than merely
    /// awkward. Every field already is.
    struct Sign: Decodable, Equatable {
        let signed: Int
        let txid: String?
        /// This project's own wire, carrying the finished transaction. What
        /// the Labyrinth wallet broadcasts.
        let frames: [String]?
        /// `ur:crypto-psbt`, carrying the signed PSBT. What Sparrow, Electrum
        /// and the hardware-signer companions read.
        ///
        /// Optional so a bundle built before this existed still decodes rather
        /// than failing the launch gate over a field nobody had heard of.
        let urFrames: [String]?
        /// The same bytes labelled `ur:psbt`, the registry's newer name for
        /// the type. Cake matches on that prefix and rejects the older one.
        let urPsbtFrames: [String]?
    }

    struct Calibrate: Decodable {
        let params: Params
        struct Params: Decodable { let t: Int; let m: Int; let p: Int }
    }

    struct Check: Decodable { let state: String; let note: String? }

    /// Equatable for the same reason as `Sign`: `Route.keyImages` carries it.
    struct KeyImages: Decodable, Equatable {
        let answered: Int
        let refused: Int
        let frames: [String]
    }
}

/// The one door replies come through.
///
/// Order is the whole point. The refusal envelope is tried first, so a
/// `{"ok":false}` can never be decoded as whatever the caller was hoping for.
/// A refusal carrying a `code` throws `refusedAs`, because the words on a
/// refusal may be rewritten and the code is what a screen switches on.
///
/// Anything that is neither a clean refusal nor the expected shape is
/// `undecodable`, named by the type that was wanted rather than by the JSON
/// that arrived: the JSON came out of the vault and may describe somebody's
/// transaction, and an error string is a place text goes to be logged.
func decodeReply<T: Decodable>(_ json: String, using decoder: JSONDecoder = JSONDecoder()) throws -> T {
    guard let data = json.data(using: .utf8) else { throw EngineError.undecodable("not text") }
    if let envelope = try? decoder.decode(EngineEnvelope.self, from: data), !envelope.ok {
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
