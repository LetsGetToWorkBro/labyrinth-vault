//  Export.swift
//  Watch-only export: the one thing the vault ever volunteers, and it is a
//  public key. The copy earns trust by stating the asymmetry plainly — the
//  companion can watch, it cannot spend, and this code contains no secret.

import SwiftUI

struct ExportView: View {
    @EnvironmentObject private var vault: Vault
    @State private var revealed = false

    /// The real ACCOUNT frames, from the engine's watch-only export.
    @State private var frames: [String] = []
    @State private var zpub = ""
    @State private var problem: String?

    private func load(_ vault: Vault) {
        do {
            let exported = try vault.exportAccount(chain: "btc")
            frames = exported.frames
            zpub = exported.account.zpub ?? ""
        } catch {
            problem = error.localizedDescription
        }
    }

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                VaultBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Eyebrow("EXPORT").padding(.top, 12)
                        Statement("WATCH-ONLY", "KEY", size: 36).padding(.top, 10)
                        if let problem {
                            Text(problem)
                                .font(Type.body(13))
                                .lineSpacing(4)
                                .foregroundStyle(Ink.refused)
                                .padding(.top, 12)
                        }
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

                        Text(zpub)
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
        /* The call that was designed for and then never made: without it this
         * screen animated an empty aperture. The frames come from the engine's
         * live session, so an unlocked vault is a precondition, which the
         * routes now enforce. */
        .onAppear { load(vault) }
    }
}
