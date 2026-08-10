//  Settings.swift
//  Minimal by principle. The most important section is the one listing what
//  is deliberately absent — each absence would need a network, and the build
//  has no code that could open one.

import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var vault: Vault

    private var rows: [(String, String, Route)] {
        [
            ("BITCOIN", "BIP84 · ACCOUNT 0", .bitcoin),
            ("MONERO", "VIEW KEY ONLY", .monero),
            ("SECURITY DIAGNOSTICS", "ALL CLEAR", .airgap),
            ("KEY MANAGEMENT", "ENCRYPTED", .recovery),
            ("RE-RUN AIRGAP CHECK", "", .setup(.verify)),
        ]
    }

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                VaultBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Statement("VAULT", size: 40).padding(.top, 16).padding(.bottom, 20)

                        ForEach(rows, id: \.0) { row in
                            Button {
                                Haptic.tick()
                                vault.go(row.2)
                            } label: {
                                VStack(spacing: 0) {
                                    HStack {
                                        Text(row.0)
                                            .font(.system(size: 15, weight: .medium))
                                            .foregroundStyle(Ink.paper)
                                        Spacer()
                                        Text(row.1.isEmpty ? "→" : "\(row.1)  →")
                                            .font(Type.mono(12))
                                            .foregroundStyle(Ink.paperDim)
                                    }
                                    .padding(.vertical, 17)
                                    Hairline()
                                }
                            }
                            .buttonStyle(.plain)
                        }

                        FieldRow(label: "APP VERSION", value: "0.1.0").padding(.top, 22)
                        FieldRow(label: "WIRE", value: "LV1 · BC-UR")
                        FieldRow(label: "VAULT ID", value: Fixtures.vaultID)

                        VStack(alignment: .leading, spacing: 10) {
                            Eyebrow("WHAT IS NOT HERE", color: Ink.paper)
                            Text("No cloud backup. No account. No price feed. No address book " +
                                 "synced from anywhere. No notifications. Each of those would " +
                                 "need a network, and this build has no code that could open one.")
                                .font(Type.body(13))
                                .lineSpacing(4)
                                .foregroundStyle(Ink.paperDim)
                        }
                        .padding(18)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay { Rectangle().strokeBorder(Ink.rule, lineWidth: 1) }
                        .padding(.top, 28)
                        .padding(.bottom, 24)
                    }
                    .padding(.horizontal, 24)
                }
                VaultTabs(current: "")
            }
        }
    }
}

struct RecoveryView: View {
    @EnvironmentObject private var vault: Vault
    @State private var revealed = false

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                VaultBar(airgap: .hidden)
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Eyebrow("RECOVERY").padding(.top, 16)
                        Statement("TWELVE WORDS", "ON PAPER", size: 34).padding(.top, 12)
                        Text("This is the only backup that exists. Write it by hand. Do not " +
                             "photograph it — the camera roll is on a phone that has a network.")
                            .font(Type.body())
                            .lineSpacing(5)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.top, 14)
                            .padding(.bottom, 22)

                        // Concealed until held; concealed again on release.
                        seedGrid
                            .blur(radius: revealed ? 0 : 7)
                            .opacity(revealed ? 1 : 0.5)

                        HStack {
                            Text("HOLD TO REVEAL")
                                .font(Type.mono(10))
                                .kerning(1.6)
                                .foregroundStyle(Ink.paperFaint)
                            Spacer()
                            Text(revealed ? "VISIBLE" : "CONCEALED")
                                .font(Type.mono(10))
                                .kerning(1.6)
                                .foregroundStyle(revealed ? Ink.attention : Ink.paperFaint)
                        }
                        .padding(.vertical, 14)
                        .contentShape(Rectangle())
                        .gesture(
                            DragGesture(minimumDistance: 0)
                                .onChanged { _ in
                                    if !revealed { Haptic.tick() }
                                    withAnimation(.easeOut(duration: 0.3)) { revealed = true }
                                }
                                .onEnded { _ in
                                    withAnimation(.easeOut(duration: 0.3)) { revealed = false }
                                }
                        )

                        Eyebrow("AT REST", color: Ink.paperDim).padding(.top, 22).padding(.bottom, 8)
                        FieldRow(label: "ENCRYPTION", value: "ACTIVE", tone: .verified)
                        FieldRow(label: "PASSPHRASE", value: "CONFIGURED")
                        FieldRow(label: "SECURE HARDWARE", value: "BOUND TO THIS DEVICE")
                        FieldRow(label: "EXPORTABLE", value: "NO")

                        VStack(spacing: 10) {
                            Lever(title: "CHANGE PASSPHRASE", style: .quiet) {}
                            Lever(title: "ERASE VAULT", hint: "IRREVERSIBLE", style: .quiet) {}
                        }
                        .padding(.top, 24)

                        Text("Erasing destroys the key material in secure hardware. Without the " +
                             "twelve words there is no way back, and no service to ask.")
                            .font(Type.body(13))
                            .lineSpacing(4)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.vertical, 18)
                    }
                    .padding(.horizontal, 24)
                }
                Lever(title: "DONE") { vault.go(.home) }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
            }
        }
    }

    private var seedGrid: some View {
        let columns = [GridItem(.flexible(), spacing: 1), GridItem(.flexible(), spacing: 1)]
        return LazyVGrid(columns: columns, spacing: 1) {
            ForEach(Fixtures.seed.indices, id: \.self) { i in
                HStack(spacing: 10) {
                    Text("\(i + 1)")
                        .font(Type.mono(10))
                        .foregroundStyle(Ink.paperGhost)
                        .frame(width: 16, alignment: .leading)
                    Text(Fixtures.seed[i])
                        .font(Type.mono(12.5))
                        .foregroundStyle(Ink.paper)
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 11)
                .background(Ink.void)
            }
        }
        .background(Ink.rule)
        .overlay { Rectangle().strokeBorder(Ink.rule, lineWidth: 1) }
    }
}
