//  Signed.swift
//  After the signature. The distinction this screen exists to draw:
//  SIGNED is not SENT. The vault has produced a signature and nothing has
//  left the device — cannot leave the device — until a person shows the QR
//  to the companion. Success here is quiet, not celebratory.

import SwiftUI

struct SignedView: View {
    @EnvironmentObject private var vault: Vault
    let tx: TxSummary

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
                    FieldRow(label: "SIGNATURES", value: "\(tx.inputs.filter(\.mine).count) OF \(tx.inputs.count)")
                    FieldRow(label: "SIGHASH", value: "ALL")
                    FieldRow(label: "TXID", value: String(Fixtures.txid.prefix(16)) + "…")
                    FieldRow(label: "SENT ANYWHERE", value: "NO", tone: .verified)

                    Text("Nothing has left this device and nothing will. The vault has no way " +
                         "to reach the network — carrying this to the chain is the companion's " +
                         "job, and only if you show it the code.")
                        .font(Type.body())
                        .lineSpacing(5)
                        .foregroundStyle(Ink.paperDim)
                        .padding(.top, 22)
                }
                .padding(.horizontal, 24)
                Spacer()
                Lever(title: "SHOW TO COMPANION", hint: "QR") { vault.go(.signedQR(tx)) }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
            }
        }
    }
}

struct SignedQRView: View {
    @EnvironmentObject private var vault: Vault
    let tx: TxSummary

    /// STAGED: on device these are the real TXSIGNED frames from the envelope
    /// encoder in src/airgap/envelope.ts. Twelve frames, same wire format.
    private var frames: [String] {
        (1...12).map { "LV1:TXSIGNED:\($0):12:9f2a1c04:\(Fixtures.txid)F\($0)" }
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

                        QRAperture(frames: frames, interval: 0.7)

                        FieldRow(label: "KIND", value: "TXSIGNED").padding(.top, 18)
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
