//  Protocols.swift
//  Bitcoin and Monero as protocols, not brands: one vault, two signing
//  systems, each described by what is installed. Both chains sign now —
//  PSBT for Bitcoin, CLSAG over an unsigned set for Monero — and each
//  screen names what the vault checks before a signature exists, because
//  the checking is the product.

import SwiftUI

struct BitcoinView: View {
    @EnvironmentObject private var vault: Vault

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                VaultBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Eyebrow("BITCOIN", color: Ink.btc).padding(.top, 16)
                        Statement("BIP84", "ACCOUNT 0", size: 40).padding(.top, 12).padding(.bottom, 24)

                        FieldRow(label: "DERIVATION", value: "m/84'/0'/0'")
                        FieldRow(label: "SCRIPT", value: "P2WPKH · NATIVE SEGWIT")
                        FieldRow(label: "FINGERPRINT", value: vault.fingerprint)
                        FieldRow(label: "ADDRESS GAP SCAN", value: "200")
                        FieldRow(label: "SIGNING", value: "INSTALLED", tone: .verified)

                        Text("The vault derives its own addresses and re-derives every output a " +
                             "transaction claims is yours. Nothing about ownership is ever read " +
                             "from the file a companion sends.")
                            .font(Type.body())
                            .lineSpacing(5)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.vertical, 24)

                        Lever(title: "EXPORT WATCH-ONLY KEY", hint: "ZPUB", style: .quiet) {
                            vault.go(.export)
                        }
                        .padding(.bottom, 24)
                    }
                    .padding(.horizontal, 24)
                }
                Lever(title: "DONE") { vault.go(.home) }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
            }
        }
    }
}

struct MoneroView: View {
    @EnvironmentObject private var vault: Vault

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                VaultBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Eyebrow("MONERO", color: Ink.xmr).padding(.top, 16)
                        Statement("VIEW KEY", "EXPORT", size: 40).padding(.top, 12).padding(.bottom, 24)

                        FieldRow(label: "SEED", value: "25 WORDS · ELECTRUM STYLE")
                        FieldRow(label: "PRIMARY ADDRESS", value: "DERIVED")
                        FieldRow(label: "PRIVATE VIEW KEY", value: "EXPORTABLE")
                        FieldRow(label: "SPEND KEY", value: "NEVER LEAVES DEVICE", tone: .verified)
                        FieldRow(label: "TRANSACTION SIGNING", value: "INSTALLED · CLSAG", tone: .verified)

                        VStack(alignment: .leading, spacing: 10) {
                            Eyebrow("WHAT THE VAULT CHECKS", color: Ink.paper)
                            Text("An unsigned set is read and rendered in full before anything " +
                                 "is signed: every destination, the stated fee, and the claim " +
                                 "that change returns here, checked against this vault's own " +
                                 "address, and refused outright when the claim lies. The ring " +
                                 "signature, range proof and balance are proven during signing; " +
                                 "a set that fails any of them fails instead of signing.")
                                .font(Type.body(13.5))
                                .lineSpacing(4)
                                .foregroundStyle(Ink.paperDim)
                        }
                        .padding(18)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay { Rectangle().strokeBorder(Ink.rule, lineWidth: 1) }
                        .padding(.top, 24)
                        .padding(.bottom, 24)
                    }
                    .padding(.horizontal, 24)
                }
                Lever(title: "DONE") { vault.go(.home) }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
            }
        }
    }
}
