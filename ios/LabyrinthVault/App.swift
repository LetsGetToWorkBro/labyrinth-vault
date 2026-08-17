//  App.swift
//  Entry point and router.
//
//  Navigation is a single switch over `Route` rather than a NavigationStack:
//  the vault has no "back" in the browser sense. Screens are states of an
//  instrument, transitions between them are explicit, and the security-
//  critical properties fall out of the enum: a refusal has exactly one exit,
//  and the approve state cannot be reached except through review.

import SwiftUI

@main
struct LabyrinthVaultApp: App {
    @StateObject private var vault = Vault()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(vault)
                .statusBarHidden()   // the vault draws its own status: the airgap
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var vault: Vault
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Ink.void.ignoresSafeArea()
            screen
                .id(routeKey)
                .transition(.asymmetric(
                    insertion: .opacity.combined(with: .offset(y: 10)),
                    removal: .opacity))

            /* The app switcher's snapshot is taken from whatever is on
             * screen the moment focus is lost. A confirmation screen or a
             * recovery phrase must not be what it captures, so anything
             * short of active gets the void. */
            if scenePhase != .active {
                Ink.void.ignoresSafeArea()
            }
        }
        .onChange(of: scenePhase) { phase in
            /* `.background`, not `.inactive`: permission prompts (the
             * camera's, during a scan) pass through inactive, and locking on
             * them would wipe the session mid-flow. Leaving the app is the
             * boundary. `sleep` wipes the keys and gates the return behind
             * the passphrase whenever a vault exists. */
            if phase == .background {
                vault.sleep()
            }
        }
    }

    @ViewBuilder private var screen: some View {
        switch vault.route {
        case .launch: LaunchView()
        case .setup(let stage): SetupView(stage: stage)
        case .unlock: UnlockView()
        case .home: HomeView()
        case .airgap: AirgapView()
        case .export: ExportView()
        case .scanner: ScannerView()
        case .acquiring: AcquiringView()
        case .review(let tx): ReviewView(tx: tx)
        case .destination(let tx, let out): DestinationView(tx: tx, output: out)
        case .approve(let tx, let digest): ApproveView(tx: tx, reviewedDigest: digest)
        case .signed(let tx, let result): SignedView(tx: tx, result: result)
        case .signedQR(let tx, let result): SignedQRView(tx: tx, result: result)
        case .xmrReview(let tx): XmrReviewView(tx: tx)
        case .xmrDestination(let tx, let out): XmrDestinationView(tx: tx, output: out)
        case .xmrApprove(let tx, let digest): XmrApproveView(tx: tx, reviewedDigest: digest)
        case .xmrSigned(let tx, let result): XmrSignedView(tx: tx, result: result)
        case .xmrSignedQR(let tx, let result): XmrSignedQRView(tx: tx, result: result)
        case .keyImages(let result): KeyImagesView(result: result)
        case .xmrFile(let file): MoneroFileView(file: file)
        case .refused(let refusal): RefusalView(refusal: refusal)
        case .settings: SettingsView()
        case .bitcoin: BitcoinView()
        case .monero: MoneroView()
        case .recovery: RecoveryView()
        }
    }

    /// Distinct animation identity per screen (not per associated value).
    private var routeKey: String {
        switch vault.route {
        case .launch: "launch"
        case .setup(let s): "setup-\(s)"
        case .unlock: "unlock"
        case .home: "home"
        case .airgap: "airgap"
        case .export: "export"
        case .scanner: "scanner"
        case .acquiring: "acquiring"
        case .review: "review"
        case .destination: "destination"
        case .approve: "approve"
        case .signed: "signed"
        case .signedQR: "signedqr"
        case .xmrReview: "xmrreview"
        case .xmrDestination: "xmrdestination"
        case .xmrApprove: "xmrapprove"
        case .xmrSigned: "xmrsigned"
        case .xmrSignedQR: "xmrsignedqr"
        case .keyImages: "keyimages"
        case .xmrFile: "xmrfile"
        case .refused(let r): "refused-\(r.headline.joined())"
        case .settings: "settings"
        case .bitcoin: "bitcoin"
        case .monero: "monero"
        case .recovery: "recovery"
        }
    }
}

/// The four destinations. Bottom-anchored, thumb-height, monospace whispers.
struct VaultTabs: View {
    @EnvironmentObject private var vault: Vault
    let current: String

    /* SECURITY lands on the settings screen, whose first row is the airgap
     * readout. That is one tap further from the readout than it was, and it
     * is worth it.
     *
     * `SettingsView` had no way in at all: nothing in this app ever called
     * `go(.settings)`. It is the only route to `RecoveryView`, which holds
     * the recovery phrases, the switch that stops using Face ID, and ERASE
     * VAULT. The one other door to that screen is a lever on the setup
     * completion screen, so anybody who tapped OPEN VAULT there could never
     * see their seed words again, never withdraw the stored passphrase, and
     * never erase the vault from inside the app.
     *
     * `test/app-wiring.test.ts` fails if a screen the router can show loses
     * its way in again, which is the check that was missing. */
    private let items: [(String, Route)] = [
        ("VAULT", .home), ("SIGN", .scanner),
        ("EXPORT", .export), ("SETTINGS", .settings),
    ]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(items, id: \.0) { item in
                Button {
                    Haptic.tick()
                    vault.go(item.1)
                } label: {
                    Text(item.0)
                        .font(.system(size: 9, weight: .medium, design: .monospaced))
                        .kerning(1.4)
                        .foregroundStyle(item.0 == current ? Ink.paper : Ink.paperFaint)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 14)
                        .padding(.bottom, 6)
                        .overlay(alignment: .top) {
                            if item.0 == current {
                                Rectangle().fill(Ink.paper).frame(height: 2)
                            }
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .overlay(alignment: .top) { Hairline() }
        .background(Ink.void)
    }
}
