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

    var body: some View {
        ZStack {
            Ink.void.ignoresSafeArea()
            screen
                .id(routeKey)
                .transition(.asymmetric(
                    insertion: .opacity.combined(with: .offset(y: 10)),
                    removal: .opacity))
        }
    }

    @ViewBuilder private var screen: some View {
        switch vault.route {
        case .launch: LaunchView()
        case .setup(let stage): SetupView(stage: stage)
        case .home: HomeView()
        case .airgap: AirgapView()
        case .export: ExportView()
        case .scanner: ScannerView()
        case .acquiring: AcquiringView()
        case .received: ReceivedView()
        case .review(let tx): ReviewView(tx: tx)
        case .destination(let tx, let out): DestinationView(tx: tx, output: out)
        case .approve(let tx, let digest): ApproveView(tx: tx, reviewedDigest: digest)
        case .signed(let tx): SignedView(tx: tx)
        case .signedQR(let tx): SignedQRView(tx: tx)
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
        case .home: "home"
        case .airgap: "airgap"
        case .export: "export"
        case .scanner: "scanner"
        case .acquiring: "acquiring"
        case .received: "received"
        case .review: "review"
        case .destination: "destination"
        case .approve: "approve"
        case .signed: "signed"
        case .signedQR: "signedqr"
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

    private let items: [(String, Route)] = [
        ("VAULT", .home), ("SIGN", .scanner),
        ("EXPORT", .export), ("SECURITY", .airgap),
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
