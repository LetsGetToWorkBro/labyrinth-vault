//  Export.swift
//  Watch-only export: the one thing the vault ever volunteers, and it is a
//  public key. The copy earns trust by stating the asymmetry plainly — the
//  companion can watch, it cannot spend, and this code contains no secret.

import SwiftUI

struct ExportView: View {
    @EnvironmentObject private var vault: Vault
    @State private var revealed = false

    /// Which wallet is going to scan this.
    ///
    /// The same choice the signed screen makes, for the same reason: the vault
    /// cannot know what is pointed at it, and picking wrong is somebody
    /// holding a phone up to a wallet that will never respond. Before this
    /// existed, pairing with anything but the Labyrinth wallet meant reading
    /// the zpub off the glass and typing it.
    ///
    /// Electrum used to be named on the second button and has been taken off
    /// it. Electrum reads no BC-UR of any kind, so it could never have scanned
    /// that code. Pairing it is the zpub below, which is not a workaround —
    /// pasting a master public key is how Electrum has always made a
    /// watch-only wallet — but a button that promised a scan it could not
    /// deliver was worse than no button.
    enum Wire: String, CaseIterable {
        case labyrinth = "LABYRINTH"
        case account = "SPARROW · BLUEWALLET"

        var kind: String { self == .labyrinth ? "ACCOUNT · LV1" : "UR:CRYPTO-ACCOUNT" }
    }

    @State private var wire: Wire = .labyrinth

    /// The real ACCOUNT frames, from the engine's watch-only export.
    @State private var frames: [String] = []
    @State private var urFrames: [String] = []
    @State private var zpub = ""
    @State private var problem: String?

    private func load(_ vault: Vault) {
        do {
            let exported = try vault.exportAccount(chain: "btc")
            frames = exported.frames
            urFrames = exported.urFrames ?? []
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

                        HStack(spacing: 0) {
                            ForEach(Wire.allCases, id: \.rawValue) { option in
                                Button {
                                    Haptic.tick()
                                    wire = option
                                } label: {
                                    Text(option.rawValue)
                                        .font(Type.mono(10))
                                        .kerning(1.4)
                                        .foregroundStyle(wire == option ? Ink.void : Ink.paperDim)
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 9)
                                        .background(wire == option ? Ink.paper : Color.clear)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .overlay { Rectangle().strokeBorder(Ink.rule, lineWidth: 1) }
                        .padding(.bottom, 14)

                        QRAperture(frames: wire == .labyrinth ? frames : urFrames, interval: 0.9)

                        FieldRow(label: "FORMAT", value: wire.kind).padding(.top, 18)
                        FieldRow(label: "ASSET", value: "BITCOIN")
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
                            Text(revealed ? "CONCEAL KEY TEXT" : "SHOW KEY AS TEXT — FOR ELECTRUM")
                                .font(Type.mono(10))
                                .kerning(1.6)
                                .foregroundStyle(Ink.paperFaint)
                                .padding(.vertical, 12)
                        }
                        .buttonStyle(.plain)

                        if revealed {
                            /* Electrum has no camera path to a watch-only
                             * wallet at all: it reads no BC-UR, and its new
                             * wallet wizard takes a typed master public key.
                             * So this is not the fallback, it is the route,
                             * and saying where to put it saves somebody
                             * hunting through a menu with a zpub on screen. */
                            Text("ELECTRUM: FILE ▸ NEW ▸ STANDARD WALLET ▸ USE A MASTER KEY, THEN PASTE THIS.")
                                .font(Type.mono(9))
                                .kerning(1.1)
                                .lineSpacing(3)
                                .foregroundStyle(Ink.paperFaint)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.bottom, 10)
                        }

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
