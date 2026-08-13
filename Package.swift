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
    products: [
        .library(name: "LabyrinthVaultCore", targets: ["LabyrinthVaultCore"]),
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
        /* libsodium, from whatever the platform already has: apt on the
         * Linux container this runs in, Homebrew on a Mac. That is enough to
         * settle step 2 of the port in docs/native-primitives.md — does a
         * native Argon2id reproduce the reference vectors, and can it express
         * the parameters this format uses — which is the question worth
         * answering before any key material moves.
         *
         * It is deliberately not how the iOS app gets libsodium. A phone has
         * no system libsodium, so the app needs one built for it, and that is
         * a supply-chain decision with its own diff. Keeping the two apart
         * means the cryptographic question is answered and checked in `npm
         * test` today, while the packaging question stays open and visible
         * instead of being half-done inside an Xcode project nobody here can
         * build. ios/LabyrinthVaultKDF/README.md carries the options. */
        .systemLibrary(
            name: "Csodium",
            path: "ios/LabyrinthVaultKDF/Csodium",
            pkgConfig: "libsodium",
            providers: [.apt(["libsodium-dev"]), .brew(["libsodium"])]
        ),
        .target(
            name: "LabyrinthVaultKDF",
            dependencies: ["Csodium"],
            path: "ios/LabyrinthVaultKDF",
            exclude: ["Csodium", "README.md"],
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
