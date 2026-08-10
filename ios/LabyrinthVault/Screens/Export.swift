//  Export.swift
//  Watch-only export: the one thing the vault ever volunteers, and it is a
//  public key. The copy earns trust by stating the asymmetry plainly — the
//  companion can watch, it cannot spend, and this code contains no secret.

import SwiftUI

struct ExportView: View {
    @EnvironmentObject private var vault: Vault
    @State private var revealed = false

    /// STAGED: on device these are the ACCOUNT frames the envelope encoder
    /// produces from the real zpub (src/keys/bitcoin.ts watch-only export).
    private var frames: [String] {
        (1...6).map { "LV1:ACCOUNT:\($0):6:7f21a9c4:\(Fixtures.xpub.prefix(60))F\($0)" }
    }

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                VaultBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Eyebrow("EXPORT").padding(.top, 12)
                        Statement("WATCH-ONLY", "KEY", size: 36).padding(.top, 10)
                        Text("Your companion device can watch your funds with this. It cannot " +
                             "spend them: no private key has ever been on that device, and this " +
                             "code does not contain one.")
                            .font(Type.body())
                            .lineSpacing(5)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.top, 14)
                            .padding(.bottom, 22)

                        QRAperture(frames: frames, interval: 0.9)

                        FieldRow(label: "ASSET", value: "BITCOIN").padding(.top, 18)
                        FieldRow(label: "STANDARD", value: "BIP84")
                        FieldRow(label: "ACCOUNT", value: "0")
                        FieldRow(label: "CONTAINS", value: "PUBLIC KEY ONLY", tone: .verified)

                        Text("SCAN WITH COMPANION DEVICE")
                            .font(Type.mono(10))
                            .kerning(2)
                            .foregroundStyle(Ink.paper)
                            .padding(.top, 22)

                        Button {
                            Haptic.tick()
                            withAnimation(.easeOut(duration: 0.3)) { revealed.toggle() }
                        } label: {
                            Text(revealed ? "CONCEAL KEY TEXT" : "SHOW KEY AS TEXT")
                                .font(Type.mono(10))
                                .kerning(1.6)
                                .foregroundStyle(Ink.paperFaint)
                                .padding(.vertical, 12)
                        }
                        .buttonStyle(.plain)

                        Text(Fixtures.xpub)
                            .font(Type.mono(11))
                            .lineSpacing(5)
                            .foregroundStyle(Ink.paperDim)
                            .blur(radius: revealed ? 0 : 7)
                            .opacity(revealed ? 1 : 0.5)
                            .padding(.bottom, 26)
                    }
                    .padding(.horizontal, 24)
                }
                VaultTabs(current: "EXPORT")
            }
        }
    }
}
