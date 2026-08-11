//  Flow.swift
//  The route transition rules, as checkable code.
//
//  Vault.swift's header has always made a claim: "there is no route from a
//  refusal to anywhere but the scanner, and no way to construct `.approve`
//  without the reviewed summary." Half of that claim was held by the type
//  system (the associated values) and half of it was held by nothing at all —
//  `go(_:)` moved to whatever it was handed, and the discipline lived in which
//  buttons the screens happened to draw. A refactor that added a button could
//  break the security model without breaking a single type.
//
//  This file is the other half, written down. It imports Foundation and
//  nothing else, so it compiles and its tests run on any platform, which is
//  the difference between a claim in a comment and a claim a machine checks
//  on every push.
//
//  The table is deny-first about the states that matter and permissive about
//  the rest. Chrome navigation — home to settings, settings to home — is not
//  a security property and enumerating it here would mean every new screen
//  edits this file, which is how a table stops being read. The signing path
//  is different: each of its states names exactly what may precede it.

import Foundation

/// The shape of a route, without its payload.
///
/// `Route` itself carries summaries and engine replies and lives with the
/// screens; this enum is what the transition rules are written in terms of.
/// Every `Route` case has exactly one kind, and `Vault.go` maps before asking.
public enum RouteKind: String, CaseIterable, Sendable {
    case launch, setup, home, airgap, export, scanner, acquiring, received
    case review, destination, approve, signed, signedQR, refused
    case settings, bitcoin, monero, recovery
}

public enum Flow {
    /// May the application move from `from` to `to`?
    ///
    /// The invariants, in the order they would hurt:
    ///
    ///   1. **`approve` follows review.** Only `review` or `destination`
    ///      (review's own inspect detour) may precede it. There is no path to
    ///      the signing lever that did not pass the screen that shows what is
    ///      being signed.
    ///   2. **`signed` follows approve.** A signature exists only after the
    ///      hold-to-sign, and `signedQR` is a face of `signed`, reachable
    ///      only from it and back.
    ///   3. **A refusal is a dead end.** From `refused` the only ways out are
    ///      the scanner (scan something else) and home (give up). A refusal
    ///      that could reach `review` would be a refusal somebody can click
    ///      through, which is no refusal at all.
    ///   4. **Review comes from the reader.** `review` may follow only the
    ///      scan path (`scanner`, `acquiring`, `received`), itself, or its
    ///      detour. Nothing walks into a confirmation screen from the home
    ///      screen with a stale summary.
    public static func allowed(from: RouteKind, to: RouteKind) -> Bool {
        // Rule 3 first: from a refusal, two exits.
        if from == .refused {
            return to == .scanner || to == .home
        }

        switch to {
        case .approve:
            return from == .review || from == .destination
        case .signed:
            return from == .approve || from == .signedQR
        case .signedQR:
            return from == .signed
        case .review:
            return from == .scanner || from == .acquiring || from == .received
                || from == .destination || from == .review
        case .destination:
            return from == .review
        case .refused:
            /* Anything on the reading or signing path may refuse. The states
             * that never touch a transaction have nothing to refuse, and a
             * refusal appearing out of the settings screen would mean state
             * leaked somewhere it should not exist. */
            return from == .scanner || from == .acquiring || from == .received
                || from == .review || from == .destination || from == .approve
                || from == .signed || from == .signedQR
        case .launch:
            // Nothing returns to the launch gate; relaunching is the OS's job.
            return false
        default:
            return true
        }
    }
}
