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

/// Which Argon2id a derivation on this build actually runs.
///
/// The engine measures this rather than reporting whether a host derivation
/// was installed, and the distinction is the point: a build where every
/// `try? Argon2id.deriveKey` returns nil has one installed and runs the
/// JavaScript. `src/keys/seal.ts` carries the full argument.
///
///   - `native`: a host derivation is installed and produced the engine's own
///     bytes for a reference input. Fast, and its blobs open anywhere.
///   - `engine`: nothing is installed, or what is installed declined. The
///     JavaScript runs, which is correct and about a minute a derivation on a
///     phone with no JIT.
///   - `mismatch`: something is installed, `deriveKey` will use it because the
///     length is right, and it is not Argon2id. A vault sealed here opens on
///     this build and nowhere else.
///
/// An unrecognized word reads as `mismatch` rather than `engine`. A bundle
/// answering something this app has never heard of is a bundle whose
/// derivation this app cannot account for, and the safe reading of "cannot
/// account for" is the state that says do not trust a vault sealed here.
enum KdfSource {
    case native
    case engine
    case mismatch

    init(reported: String?) {
        /* Absent, not unknown. A bundle built before this field existed
         * answers nothing at all, and that build is the interpreted one. */
        guard let reported else {
            self = .engine
            return
        }
        switch reported {
        case "native": self = .native
        case "engine": self = .engine
        default: self = .mismatch
        }
    }

    /// The words the Settings screen prints. Here rather than in the screen
    /// because the screen is excluded from `Package.swift`'s target and this
    /// file is not, so the mapping is compiled by something.
    var label: String {
        switch self {
        case .native: return "COMPILED"
        case .engine: return "INTERPRETED"
        case .mismatch: return "NOT ARGON2ID"
        }
    }
}

/// Every shape the engine can answer with. One per host function, same name.
enum EngineReply {
    /// `kdf` says which implementation a derivation would actually use. See
    /// `KdfSource` above for the three answers and what each costs. Optional
    /// so that a bundle built before this existed still decodes rather than
    /// failing the launch gate over a field nobody had heard of.
    ///
    /// It is worth reporting because the failure it catches is silent. A
    /// native derivation that never gets installed is not an error anywhere;
    /// it is an unlock that takes a minute, on a build that was supposed to
    /// take a second, with nothing on screen to say which happened.
    struct Version: Decodable {
        let version: Int
        let kdf: String?
        /// "native" or "absent". Optional so a bundle built before the
        /// CryptoNight seam existed still decodes rather than failing the
        /// launch gate over a field nobody had heard of.
        let cryptonight: String?
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
        /// The BIP-380 output descriptors for this account. Nil for Monero,
        /// which has no such thing, and nil for a watch-only vault, which has
        /// no master fingerprint and so cannot state a key origin.
        ///
        /// The one pairing form that needs no scanner and no registry support:
        /// a wallet can take it pasted, typed or photographed. That matters
        /// most for Electrum, which reads no BC-UR at all.
        let descriptors: Descriptors?
        struct Descriptors: Decodable {
            /// `/0/*`, the addresses somebody is given.
            let receive: String
            /// `/1/*`, where change comes back.
            let change: String
            /// Both chains in one string. Sparrow, Nunchuk and Bitcoin Core 26
            /// and later take it; older wallets want the pair.
            let combined: String
        }
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
        /// `ur:crypto-psbt`, carrying the signed PSBT. What Sparrow, Keystone,
        /// Passport and BlueWallet read.
        ///
        /// Optional so a bundle built before this existed still decodes rather
        /// than failing the launch gate over a field nobody had heard of.
        let urFrames: [String]?
        /// The same bytes labelled `ur:psbt`, the registry's newer name for
        /// the type. Cake matches on that prefix and rejects the older one.
        let urPsbtFrames: [String]?
        /// The same PSBT as base43 in one static code, which is the whole of
        /// what Electrum can read from a camera.
        ///
        /// Null, rather than empty, when the PSBT will not fit a single QR.
        /// Electrum has no animated format, so there is no larger version of
        /// this to fall back to and the screen has to say so.
        let electrumFrames: [String]?
        /// The same PSBT as BBQr, which is the only animated format Coldcard
        /// reads. Sparrow, Nunchuk and BlueWallet read it too.
        let bbqrFrames: [String]?
    }

    /// Equatable for the same reason as `Sign`: `Route.keyImages` carries it.
    struct KeyImages: Decodable, Equatable {
        let answered: Int
        let refused: Int
        let frames: [String]
        /// How many bytes of platform randomness the *other* wire would need,
        /// or nil when this build cannot write that file at all.
        ///
        /// Optional twice over, and for two different reasons. It is absent
        /// from a bundle built before the file wire existed, which is what
        /// keeps an older engine decodable here; and it is `null` from a
        /// current bundle with no CryptoNight, which is the honest answer to
        /// "what would it cost" when the answer is that it cannot be done.
        /// The screen treats both the same way: no second wire offered.
        let fileRandomBytes: Int?
    }

    /// The key images again, as the file Cake, Feather and the Monero CLI
    /// import. See `moneroKeyImageFile` in host.ts.
    struct KeyImageFile: Decodable, Equatable {
        let answered: Int
        /// Where these sit in the requesting wallet's own transfer list.
        /// `import_key_images` pairs records with transfers by position, so
        /// this is not decoration.
        let offset: Int
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
