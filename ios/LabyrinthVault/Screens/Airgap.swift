//  Airgap.swift
//  The diagnostic, split along the one line that matters: what the build can
//  claim about itself, and what only the person holding the phone can make
//  true. The app has no instrument for the radios — reading their switches
//  would need the very frameworks it refuses to link — so it does not
//  pretend to a reading. It states its half as fact and hands the other half
//  over, named, checkable in Settings.

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
                            Text("NO PATH OUT")
                                .font(Type.readout(38))
                                .foregroundStyle(Ink.verified)
                                .padding(.top, 10)
                        }
                        .padding(.top, 26)
                        .padding(.bottom, 26)

                        section("THIS BUILD, AS FACT")
                        FieldRow(label: "NETWORK CODE IN BINARY", value: "NONE", tone: .verified)
                        FieldRow(label: "NETWORK PERMISSION", value: "NONE REQUESTED", tone: .verified)
                        FieldRow(label: "CLOUD CONTAINER", value: "NONE")
                        FieldRow(label: "ACCOUNT", value: "NONE")

                        section("YOURS TO KEEP TRUE")
                        FieldRow(label: "WI-FI OFF", value: "CHECK IN SETTINGS", tone: .dim)
                        FieldRow(label: "BLUETOOTH OFF", value: "CHECK IN SETTINGS", tone: .dim)
                        FieldRow(label: "CELLULAR OFF", value: "CHECK IN SETTINGS", tone: .dim)
                        FieldRow(label: "SIM OUT", value: "THE TRAY, NOT A SETTING", tone: .dim)

                        section("KEY STORAGE")
                        FieldRow(label: "ENCRYPTION AT REST", value: "ACTIVE", tone: .verified)
                        FieldRow(label: "PASSPHRASE", value: "REQUIRED TO OPEN", tone: .verified)
                        FieldRow(label: "KEYCHAIN CLASS", value: "PASSCODE-BOUND · THIS DEVICE ONLY")
                        FieldRow(label: "BACKUP SERVICE", value: "NONE")

                        section("BUILD")
                        FieldRow(label: "WIRE", value: "LV1 · BC-UR")
                        FieldRow(label: "VAULT ID", value: vault.vaultID)

                        Text("The app cannot see the radio switches, on purpose: reading them " +
                             "would need frameworks this build refuses to link. Its half of the " +
                             "airgap is compiled in and checkable against the binary. Your half " +
                             "is in Settings, and it is the half that finishes the job.")
                            .font(Type.body(13.5))
                            .lineSpacing(4)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.vertical, 24)
                    }
                    .padding(.horizontal, 24)
                }
                VaultTabs(current: "SETTINGS")
            }
        }
    }

    private func section(_ title: String) -> some View {
        Eyebrow(title, color: Ink.paperDim)
            .padding(.top, 30)
            .padding(.bottom, 10)
    }
}
