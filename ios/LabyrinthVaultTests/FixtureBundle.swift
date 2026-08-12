//  FixtureBundle.swift
//  Where the test vectors are, under both build systems.
//
//  These tests read the same JSON the TypeScript suite reads, which is the
//  whole point of them: `test/primitives.test.ts` and
//  `PassphraseContractTests` check two languages against one file, so a
//  disagreement is a real disagreement rather than two drifting copies.
//
//  Finding that file differs by build system, and only one of the two ways
//  compiles in each.
//
//  **SwiftPM** generates `Bundle.module` for any target that declares
//  `resources:`, which `Package.swift` does. It exists only because SwiftPM
//  synthesises it.
//
//  **Xcode** has no such accessor, and referring to it is a compile error:
//  "Type 'Bundle' has no member 'module'". A test bundle finds its own
//  resources through `Bundle(for:)` with a class that lives inside it. The
//  two lookups also differ in where the file lands: SwiftPM's `.copy`
//  preserves the `Fixtures/` directory, while Xcode's resource phase flattens
//  it to the bundle root, so the Xcode branch tries both rather than assuming
//  one.
//
//  Kept in one file so the three test cases that read fixtures say what they
//  mean and nothing else.

import Foundation

/// A class whose only job is to name the bundle it is compiled into.
/// `Bundle(for:)` needs a type, and the tests should not have to lend it one.
private final class FixtureAnchor {}

enum FixtureBundle {
    /// The URL of a JSON fixture by name, without its extension.
    static func url(_ name: String) -> URL? {
        #if SWIFT_PACKAGE
        return Bundle.module.url(forResource: name, withExtension: "json")
        #else
        let bundle = Bundle(for: FixtureAnchor.self)
        return bundle.url(forResource: name, withExtension: "json")
            ?? bundle.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")
        #endif
    }
}
