//  Home.swift
//  The vault at rest. The headline is the security state, never a balance:
//  this device does not manage money, it protects keys and approves
//  signatures, and the composition says so before any copy does.

import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var vault: Vault

    var body: some View {
        Screen {
            ZStack {
                LabyrinthWatermark()
                VStack(spacing: 0) {
                    VaultBar()
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            // State, enormous.
                            VStack(alignment: .leading, spacing: 10) {
                                Eyebrow("VAULT")
                                Text("READY")
                                    .font(Type.mega(72))
                                    .kerning(-3.2)
                                    .foregroundStyle(Ink.paper)
                            }
                            .padding(.top, 30)
                            .padding(.bottom, 28)

                            FieldRow(label: "NETWORK", value: "NONE")
                            FieldRow(label: "KEYS", value: "SECURED", tone: .verified)
                            FieldRow(label: "SIGNING", value: "READY")
                            FieldRow(label: "BROADCAST CAPABILITY", value: "NONE")

                            VStack(spacing: 10) {
                                Lever(title: "SCAN TRANSACTION", hint: "CAMERA") {
                                    vault.go(.scanner)
                                }
                                Lever(title: "EXPORT WATCH-ONLY", hint: "QR", style: .quiet) {
                                    vault.go(.export)
                                }
                            }
                            .padding(.top, 28)
                            .padding(.bottom, 30)

                            // Protocols, not brands.
                            HStack(alignment: .top, spacing: 0) {
                                protocolCell(.btc, status: "SIGNING · READY") { vault.go(.bitcoin) }
                                Rectangle().fill(Ink.rule).frame(width: 1)
                                protocolCell(.xmr, status: "KEYS ONLY · SIGNING NOT INSTALLED") { vault.go(.monero) }
                            }
                            .overlay(alignment: .top) { Hairline() }
                            .overlay(alignment: .bottom) { Hairline() }

                            VStack(spacing: 2) {
                                HStack {
                                    Eyebrow("VAULT ID")
                                    Spacer()
                                    Text(vault.vaultID).font(Type.mono(13)).foregroundStyle(Ink.paper)
                                }
                                HStack {
                                    Eyebrow("LAST VERIFIED")
                                    Spacer()
                                    Text("NEVER").font(Type.mono(13)).foregroundStyle(Ink.paperDim)
                                }
                            }
                            .padding(.vertical, 22)
                        }
                        .padding(.horizontal, 24)
                    }
                    VaultTabs(current: "VAULT")
                }
            }
        }
    }

    private func protocolCell(_ asset: Asset, status: String, action: @escaping () -> Void) -> some View {
        Button(action: { Haptic.tick(); action() }) {
            VStack(alignment: .leading, spacing: 8) {
                Rectangle().fill(asset.color).frame(height: 2)
                HStack(spacing: 8) {
                    Text(asset.name).font(.system(size: 13, weight: .semibold)).kerning(1)
                    Text(asset.rawValue).font(.system(size: 13)).foregroundStyle(Ink.paperFaint)
                }
                .foregroundStyle(Ink.paper)
                Text(status)
                    .font(Type.mono(9))
                    .kerning(1.2)
                    .foregroundStyle(Ink.paperFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
    }
}
