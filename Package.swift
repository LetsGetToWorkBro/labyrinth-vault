// swift-tools-version: 5.9

//  Package.swift
//  The part of the app a compiler can reach without Xcode.
//
//  ## Why this exists
//
//  Until this file, every Swift source in this repository was checked by
//  regular expressions. `test/app-wiring.test.ts` greps for a case in an enum,
//  a name in a signature, a call that must not appear. Those guards are worth
//  having — they are the only thing tying the two languages together — but
//  they cannot type-check, and the difference is not academic: `Refusal.detail`
//  was a non-exhaustive switch missing five of its nine cases and would not
//  have built. Nothing in the repository could tell. A compiler tells you in
//  four hundred milliseconds.
//
//  So the platform-free half of the app is a library target here, built and
//  tested by an ordinary `swift build` / `swift test` on any platform,
//  including the Linux container this was written in. `npm test` runs it.
//
//  ## What is in, and what cannot be
//
//  In: the transaction shapes, the refusal model, and the passphrase
//  encoding. These import Foundation and nothing else, which is not an
//  accident — they are the parts where a mistake is a wrong number on a
//  confirmation screen or a vault that opens on one device, so they are the
//  parts most worth putting under a compiler.
//
//  Out, unavoidably: everything that imports SwiftUI, JavaScriptCore or
//  CryptoKit. Those frameworks are Apple's and do not exist off Apple
//  platforms, so `Engine.swift`, `Vault.swift` and every screen can only be
//  built in Xcode. `scripts/swift-check.sh` parses them, which catches syntax
//  and nothing more, and says so rather than implying more.
//
//  ## This is not the app
//
//  It shares its sources with the iOS target by path — the same files, not
//  copies — so the two cannot drift. But a green `swift test` means the model
//  layer compiles and its tests pass. It does not mean the app builds, and it
//  does not even mean these same tests build: Xcode compiles them under
//  different conventions, and each difference surfaces only on a Mac.
//
//  **Before adding anything under `ios/LabyrinthVaultTests/`, read "Two build
//  systems, one set of sources" in `ios/README.md`.** The module name is
//  `LabyrinthVaultCore` here and `LabyrinthVault` in Xcode; `Bundle.module` is
//  synthesized here and does not exist there; `.copy` keeps the `Fixtures/`
//  directory here and Xcode flattens it to the bundle root. All three were
//  found one at a time, each only after the previous was fixed, and all three
//  are now held by `test/shipping.test.ts`.

import PackageDescription

let package = Package(
    name: "LabyrinthVaultCore",
    /* Declared so the iOS app can consume this package directly. The app takes
     * `LabyrinthVaultKDF` and nothing else: `LabyrinthVaultCore` shares its
     * sources with the app target by path, so linking that product too would
     * be the same symbols twice. */
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [
        .library(name: "LabyrinthVaultCore", targets: ["LabyrinthVaultCore"]),
        .library(name: "LabyrinthVaultKDF", targets: ["LabyrinthVaultKDF"]),
    ],
    targets: [
        .target(
            name: "LabyrinthVaultCore",
            path: "ios/LabyrinthVault",
            /* The Apple-only half, named so that this list is a manifest and
             * not just noise suppression. Everything here imports SwiftUI,
             * JavaScriptCore or CryptoKit and can therefore only be built by
             * Xcode. `scripts/swift-check.sh` parses them, which catches
             * syntax and nothing else. */
            exclude: [
                "App.swift",
                "Design",
                "Screens",
                "Resources",
                "Model/Vault.swift",         // SwiftUI, Combine, @MainActor
                "Support/Engine.swift",      // JavaScriptCore, CryptoKit
                "Support/QRCode.swift",      // CoreImage
                "Support/SealedStore.swift", // Security (the keychain)
            ],
            /* Named one by one rather than by directory. A glob would silently
             * pull in the next file somebody adds — and the next file will
             * import SwiftUI, break the Linux build, and get "fixed" by
             * deleting this target from the pipeline. Adding a file here is a
             * deliberate claim that it is platform-free. */
            sources: [
                "Model/TxSummary.swift",
                "Model/MoneroSummary.swift",
                "Model/Refusal.swift",
                "Model/Flow.swift",
                "Model/Identity.swift",
                "Support/EngineReplies.swift",
                "Support/Passphrase.swift",
                "Support/BundleDigest.swift",
            ]
        ),
        /* The Argon2 reference C, vendored under vendor/argon2 and pinned file
         * by file in its MANIFEST.json. Thirteen files and about 3,300 lines,
         * which is the whole of the dependency.
         *
         * Chosen over libsodium deliberately. libsodium's `crypto_pwhash` is
         * not general-purpose Argon2id: it fixes the salt at its own length
         * and fixes parallelism at one, and `KDF_LIMITS.maxP` is 4, so a blob
         * this format permits could not have been derived natively at all.
         * This is also the implementation that generated
         * `test/fixtures/primitives.json` by way of argon2-cffi, so the vector
         * check is against the same code the vectors came from.
         *
         * And it builds anywhere a C compiler runs, which libsodium as a
         * system library did not: there is no system libsodium on a phone.
         * That was the open half of step 1 and this closes it.
         *
         * ARGON2_NO_THREADS: `p > 1` is then computed lane by lane rather than
         * in parallel. Same output, since the algorithm is defined by the data
         * dependencies and not by the scheduling; less to go wrong on a
         * platform whose threading this project has no reason to exercise. */
        .target(
            name: "CArgon2",
            path: "vendor/argon2",
            exclude: ["MANIFEST.json", "LICENSE"],
            sources: ["src"],
            publicHeadersPath: "include",
            cSettings: [
                .define("ARGON2_NO_THREADS"),
                .headerSearchPath("include"),
                .headerSearchPath("src"),
            ]
        ),
        .target(
            name: "LabyrinthVaultKDF",
            dependencies: ["CArgon2"],
            path: "ios/LabyrinthVaultKDF",
            exclude: ["README.md"],
            sources: ["Argon2id.swift"]
        ),
        .testTarget(
            name: "LabyrinthVaultKDFTests",
            dependencies: ["LabyrinthVaultKDF"],
            path: "ios/LabyrinthVaultKDFTests",
            resources: [.copy("Fixtures/primitives.json")]
        ),
        .testTarget(
            name: "LabyrinthVaultCoreTests",
            dependencies: ["LabyrinthVaultCore"],
            path: "ios/LabyrinthVaultTests",
            resources: [
                /* The same file test/primitives.test.ts checks TypeScript
                 * against. Copied, not processed: it is a fixture, and a build
                 * system that "optimizes" a test vector has broken the test. */
                .copy("Fixtures/primitives.json"),
                .copy("Fixtures/summary.json"),
                .copy("Fixtures/monero-summary.json"),
            ]
        ),
    ]
)
