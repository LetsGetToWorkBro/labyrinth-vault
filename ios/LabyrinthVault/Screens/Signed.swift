//  Signed.swift
//  After the signature. The distinction this screen exists to draw:
//  SIGNED is not SENT. The vault has produced a signature and nothing has
//  left the device — cannot leave the device — until a person shows the QR
//  to the companion. Success here is quiet, not celebratory.

import SwiftUI

struct SignedView: View {
    // Declaration order is the memberwise-init order, and the router builds
    // this as `SignedView(tx:result:)`. Keep `tx` first so the two agree.
    let tx: TxSummary
    let result: Engine.SignReply
    @EnvironmentObject private var vault: Vault

    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 0) {
                VaultBar()
                Spacer()
                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow("COMPLETE", color: Ink.verified)
                    Text("SIGNED")
                        .font(Type.mega(64))
                        .kerning(-2.8)
                        .foregroundStyle(Ink.paper)
                        .padding(.top, 12)
                    Text("NOT BROADCAST")
                        .font(Type.statement(28))
                        .kerning(-0.8)
                        .foregroundStyle(Ink.paperFaint)
                        .padding(.top, 2)

                    Hairline(weight: 2, color: Ink.ruleHeavy).padding(.top, 28)
                    FieldRow(label: "SIGNATURES", value: "\(result.signed) OF \(tx.inputs.count)")
                    FieldRow(label: "SIGHASH", value: "ALL")
                    FieldRow(label: "TXID", value: result.txid.map { String($0.prefix(16)) + "…" } ?? "NOT FINAL")
                    FieldRow(label: "SENT ANYWHERE", value: "NO", tone: .verified)

                    Text("Nothing has left this device and nothing will. The vault has no way " +
                         "to reach the network. Carrying this to the chain is the companion's " +
                         "job, and only if you show it the code.")
                        .font(Type.body())
                        .lineSpacing(5)
                        .foregroundStyle(Ink.paperDim)
                        .padding(.top, 22)
                }
                .padding(.horizontal, 24)
                Spacer()
                Lever(title: "SHOW TO COMPANION", hint: "QR") { vault.go(.signedQR(tx, result)) }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
            }
        }
    }
}

struct SignedQRView: View {
    // Same order contract as SignedView: the router builds `SignedQRView(tx:result:)`.
    let tx: TxSummary
    let result: Engine.SignReply
    @EnvironmentObject private var vault: Vault

    /// Which wallet is going to read this off the glass.
    ///
    /// Until this existed the vault could accept a PSBT from another wallet
    /// and had no way to give one back: signing produced this project's own
    /// frames, which nobody else reads. A round trip was import-only.
    ///
    /// A picker rather than a guess, because the vault has no way to know what
    /// scanned the code that came in, and picking wrong is a person holding
    /// their phone up to a wallet that will never recognise it.
    ///
    /// ## Why five and not one
    ///
    /// There is no common QR format. There are three, they share no bytes, and
    /// a wallet that reads one generally reads none of the others:
    ///
    ///   - **BC-UR** — Sparrow, Keystone, Passport, BlueWallet. Two spellings,
    ///     because the registry renamed its types in 2023 and the wallets did
    ///     not move together.
    ///   - **base43** — Electrum, and only Electrum. One static code.
    ///   - **BBQr** — Coldcard, and also read by Sparrow, Nunchuk, BlueWallet.
    ///
    /// This list was built by reading those wallets' source. Electrum was on
    /// the BC-UR button here and reads no BC-UR at all; Coldcard was missing
    /// entirely. Both of those were claims the app made and could not keep.
    enum Wire: String, CaseIterable {
        case labyrinth = "LABYRINTH"
        case psbt = "SPARROW · BLUEWALLET"
        case cake = "CAKE"
        case electrum = "ELECTRUM"
        case bbqr = "COLDCARD · NUNCHUK"

        var kind: String {
            switch self {
            case .labyrinth: return "TXSIGNED · LV1"
            case .psbt: return "UR:CRYPTO-PSBT"
            case .cake: return "UR:PSBT"
            case .electrum: return "BASE43 · ONE CODE"
            case .bbqr: return "BBQR · B$2P"
            }
        }
        var carries: String {
            switch self {
            case .labyrinth: return "The finished transaction, ready to broadcast."
            case .psbt: return "The signed PSBT, under the name those wallets subscribe to."
            /* Same bytes as the option above. BC-UR renamed its types in 2023
             * and the wallets did not move together, so the label is the whole
             * of the difference. */
            case .cake: return "The same PSBT, under the registry's newer name."
            case .electrum: return "The same PSBT, in the one static code Electrum reads."
            case .bbqr: return "The same PSBT, in the only animated format Coldcard reads."
            }
        }
    }

    @State private var wire: Wire = .labyrinth

    private var frames: [String] {
        /* The real frames the engine produced. A transaction that cannot be
         * finalized, because somebody else still has to sign it, has no
         * Labyrinth frames at all: that wire carries a finished transaction
         * and there is not one yet. It always has PSBT frames, which is the
         * point of a PSBT.
         *
         * Electrum is the one that can legitimately be empty on a perfectly
         * good transaction: it has no animated format, so a PSBT past what one
         * QR holds cannot reach it by camera at all. The empty state below
         * says so instead of showing a code no scanner will resolve. */
        switch wire {
        case .labyrinth: return result.frames ?? []
        case .psbt: return result.urFrames ?? []
        case .cake: return result.urPsbtFrames ?? []
        case .electrum: return result.electrumFrames ?? []
        case .bbqr: return result.bbqrFrames ?? []
        }
    }

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                VaultBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Eyebrow("SIGNED TRANSACTION").padding(.top, 12)
                        Statement("SHOW THIS TO YOUR", "COMPANION DEVICE", size: 30)
                            .padding(.top, 10)
                            .padding(.bottom, 20)

                        /* The choice sits above the code rather than below
                         * it, because a person who holds up the wrong one
                         * finds out by a wallet not responding, which reads as
                         * the vault being broken. */
                        HStack(spacing: 0) {
                            ForEach(Wire.allCases, id: \.rawValue) { option in
                                Button {
                                    Haptic.tick()
                                    wire = option
                                } label: {
                                    Text(option.rawValue)
                                        .font(Type.mono(9))
                                        .kerning(1.0)
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

                        if frames.isEmpty {
                            /* Two different reasons, and they need different
                             * sentences. The Labyrinth wire is empty when
                             * another party still has to sign, and the fix is
                             * to pick a wire that carries a PSBT. Electrum is
                             * empty when the PSBT is too big for one QR, and
                             * there is no fix on this screen at all, because
                             * Electrum has no animated format to fall back to.
                             * Telling somebody to switch wires in that case
                             * would send them round a loop. */
                            Text(wire == .electrum
                                 ? "THIS PSBT IS TOO LARGE FOR ONE QR CODE, AND ELECTRUM READS NO ANIMATED FORMAT. USE THE FILE EXPORT, OR SEND IT TO A WALLET THAT READS BBQR."
                                 : "NOT FINAL, SO THERE IS NO FINISHED TRANSACTION TO SHOW. SWITCH TO ANY PSBT WIRE FOR THE SIGNED PSBT.")
                                .font(Type.mono(10))
                                .kerning(1.2)
                                .lineSpacing(4)
                                .foregroundStyle(Ink.attention)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.vertical, 30)
                        } else {
                            QRAperture(frames: frames, interval: 0.7)
                        }

                        FieldRow(label: "KIND", value: wire.kind).padding(.top, 18)
                        FieldRow(label: "CARRIES", value: "")
                        Text(wire.carries)
                            .font(Type.body(12))
                            .foregroundStyle(Ink.paperFaint)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.bottom, 4)
                        FieldRow(label: "DIGEST", value: String(tx.digest.prefix(8)))

                        VStack(alignment: .leading, spacing: 8) {
                            Text("THE VAULT CANNOT BROADCAST THIS TRANSACTION.")
                                .font(.system(size: 14, weight: .medium))
                                .kerning(0.3)
                                .foregroundStyle(Ink.paper)
                            Text("It has no code that could. Until your companion sends it, this " +
                                 "payment does not exist anywhere but on this screen.")
                                .font(Type.body(13))
                                .lineSpacing(4)
                                .foregroundStyle(Ink.paperDim)
                        }
                        .padding(18)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay { Rectangle().strokeBorder(Ink.ruleStrong, lineWidth: 1) }
                        .padding(.top, 22)
                        .padding(.bottom, 24)
                    }
                    .padding(.horizontal, 24)
                }
                Lever(title: "DONE", hint: "RETURN TO VAULT", style: .quiet) { vault.go(.home) }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
            }
        }
    }
}
