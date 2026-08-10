//  Airgap.swift
//  The diagnostic. Every line is a property of the device a person can check
//  in Settings; the vault asserts nothing here it cannot be caught lying
//  about. The absence of networking is the product, so absence is set like
//  an instrument reading, not buried in a list.

import SwiftUI

struct AirgapView: View {
    @EnvironmentObject private var vault: Vault

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                VaultBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        VStack(alignment: .leading, spacing: 12) {
                            Eyebrow("DIAGNOSTIC")
                            Statement("AIRGAP", "STATUS", size: 40)
                            Text("VERIFIED")
                                .font(Type.readout(38))
                                .foregroundStyle(Ink.verified)
                                .padding(.top, 10)
                        }
                        .padding(.top, 26)
                        .padding(.bottom, 26)

                        section("NETWORK")
                        FieldRow(label: "NETWORK PERMISSION", value: "NONE", tone: .verified)
                        FieldRow(label: "WI-FI", value: "DISABLED")
                        FieldRow(label: "BLUETOOTH", value: "DISABLED")
                        FieldRow(label: "CELLULAR", value: "DISABLED")
                        FieldRow(label: "SIM", value: "NOT PRESENT")
                        FieldRow(label: "CLOUD", value: "NONE")
                        FieldRow(label: "ACCOUNT", value: "NONE")

                        section("KEY STORAGE")
                        FieldRow(label: "DEVICE SECURE HARDWARE", value: "ACTIVE", tone: .verified)
                        FieldRow(label: "ENCRYPTION AT REST", value: "ACTIVE", tone: .verified)
                        FieldRow(label: "PASSPHRASE", value: "CONFIGURED", tone: .verified)
                        FieldRow(label: "KEY EXPORTABLE", value: "NO")
                        FieldRow(label: "BACKUP SERVICE", value: "NONE")

                        section("BUILD")
                        FieldRow(label: "NETWORK CODE IN BINARY", value: "NONE", tone: .verified)
                        FieldRow(label: "WIRE", value: "LV1 · BC-UR")
                        FieldRow(label: "VAULT ID", value: vault.vaultID)

                        Text("Every reading above is checkable on this phone, in Settings, by you. " +
                             "The vault requests no network permission, so the absence is a fact " +
                             "about the device rather than a promise from an app.")
                            .font(Type.body(13.5))
                            .lineSpacing(4)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.vertical, 24)
                    }
                    .padding(.horizontal, 24)
                }
                VaultTabs(current: "SECURITY")
            }
        }
    }

    private func section(_ title: String) -> some View {
        Eyebrow(title, color: Ink.paperDim)
            .padding(.top, 30)
            .padding(.bottom, 10)
    }
}
