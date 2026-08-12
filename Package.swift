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
//  layer compiles and its tests pass. It does not mean the app builds. Only
//  Xcode can say that, and it has not been asked yet.

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
