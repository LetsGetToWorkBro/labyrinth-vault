//  Settings.swift
//  Minimal by principle. The most important section is the one listing what
//  is deliberately absent — each absence would need a network, and the build
//  has no code that could open one.
//
//  This is what the SECURITY tab lands on, so the airgap readout is the first
//  row rather than one in the middle: the tab promises a diagnostic and the
//  screen should hand one over without being read first. Key management is
//  second because it is the only door to the recovery phrases.

import SwiftUI

/// ## The audit this screen came out of
///
/// It was called SECURITY, sat under a tab called SECURITY, and its first row
/// said SECURITY DIAGNOSTICS. Three uses of one word for three different
/// things, none of which was "the place the settings are".
///
/// Worse, the value column was doing three incompatible jobs at once. AIRGAP
/// was a topic, ENCRYPTED was a status, BIP84 · ACCOUNT 0 was a fact, and one
/// row had nothing at all. There was no pattern to learn, so a person could
/// not predict what any row would do before tapping it.
///
/// And the row reading KEY MANAGEMENT · ENCRYPTED led to the screen that shows
/// your recovery phrases and erases your vault. The two most consequential
/// things in the app were behind the vaguest label on the screen.
///
/// So: every row now says what is behind it in a sentence, the rows are
/// grouped by what they are for, and rows that *do* something are marked apart
/// from rows that only show something.
struct SettingsView: View {
    @EnvironmentObject private var vault: Vault

    /// A row: what it is, what is actually behind it, the fact worth showing
    /// on the right, and where it goes.
    private struct Entry {
        let title: String
        let inside: String
        let fact: String
        let route: Route
        /// True when tapping starts a procedure rather than opening a page.
        var acts: Bool = false
    }

    private var thisDevice: [Entry] {
        [
            Entry(title: "AIRGAP STATUS",
                  inside: "What this build can and cannot reach, and which half is yours",
                  fact: "NO NETWORK CODE",
                  route: .airgap),
            Entry(title: "RE-RUN THE AIRGAP CHECK",
                  inside: "Walk the radio steps again and re-verify this phone",
                  fact: "5 STEPS",
                  route: .setup(.verify),
                  acts: true),
        ]
    }

    private var yourKeys: [Entry] {
        [
            Entry(title: "RECOVERY PHRASES",
                  /* Naming the erase here is the point. It is the one
                   * irreversible action in the app and it used to live behind
                   * a row that said ENCRYPTED. Nobody should meet it by
                   * accident, and nobody should have to hunt for it either. */
                  inside: vault.biometricsEnrolled
                      ? "Show the words on paper, turn \(vault.biometricKind.name) off, or erase this vault"
                      : "Show the words on paper, or erase this vault",
                  fact: "12 + 25 WORDS",
                  route: .recovery),
        ]
    }

    private var whatItSigns: [Entry] {
        [
            Entry(title: "BITCOIN",
                  inside: "Derivation path, address type, and what the watcher gets",
                  fact: "BIP84 · ACCOUNT 0",
                  route: .bitcoin),
            Entry(title: "MONERO",
                  inside: "Ring signatures, key images, and what a companion may ask for",
                  fact: "CLSAG SIGNING",
                  route: .monero),
        ]
    }

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                VaultBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Statement("SETTINGS", size: 40).padding(.top, 16).padding(.bottom, 4)

                        section("THIS DEVICE", thisDevice)
                        section("YOUR KEYS", yourKeys)
                        section("WHAT THIS VAULT SIGNS", whatItSigns)

                        Eyebrow("THIS BUILD", color: Ink.paperDim)
                            .padding(.top, 26).padding(.bottom, 8)
                        FieldRow(label: "APP VERSION", value: "0.1.0")
                        FieldRow(label: "WIRE", value: "LV1 · BC-UR")
                        /* A fact about this build rather than about the vault
                         * at rest. The same vault opens either way; what
                         * differs is whether opening it takes a second or a
                         * minute.
                         *
                         * On the first screen because of how it fails. The
                         * native derivation is adopted through a string
                         * literal shared between Swift and the bundle, and a
                         * mismatch does not error: it falls back and the app
                         * is merely slow. */
                        FieldRow(label: "KEY STRETCHING",
                                 value: vault.kdfIsNative ? "COMPILED" : "INTERPRETED",
                                 tone: vault.kdfIsNative ? .verified : .dim)
                        FieldRow(label: "VAULT ID", value: vault.vaultID)

                        VStack(alignment: .leading, spacing: 10) {
                            Eyebrow("WHAT IS NOT HERE", color: Ink.paper)
                            Text("No cloud backup. No account. No price feed. No address book synced " +
                                 "from anywhere. No notifications. Each of those would need a network, " +
                                 "and this build has no code that could open one.")
                                .font(Type.body(13))
                                .lineSpacing(4)
                                .foregroundStyle(Ink.paperDim)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(18)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay { Rectangle().strokeBorder(Ink.rule, lineWidth: 1) }
                        .padding(.top, 28)
                        .padding(.bottom, 28)
                    }
                    .padding(.horizontal, 24)
                }
                VaultTabs(current: "SETTINGS")
            }
        }
    }

    private func section(_ heading: String, _ entries: [Entry]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow(heading, color: Ink.paperDim)
                .padding(.top, 26)
                .padding(.bottom, 6)
            ForEach(entries, id: \.title) { entry in
                row(entry)
            }
        }
    }

    private func row(_ entry: Entry) -> some View {
        Button {
            Haptic.tick()
            vault.go(entry.route)
        } label: {
            VStack(spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 8) {
                            Text(entry.title)
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(Ink.paper)
                            /* Rows that start a procedure are marked, because
                             * an arrow that sometimes opens a page and
                             * sometimes begins a walkthrough teaches nothing.
                             * The chevron says "forward"; this says which
                             * kind of forward. */
                            if entry.acts {
                                Text("RUNS")
                                    .font(Type.mono(8))
                                    .kerning(1.2)
                                    .foregroundStyle(Ink.attention)
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 2)
                                    .overlay { Rectangle().strokeBorder(Ink.attention.opacity(0.5), lineWidth: 1) }
                            }
                        }
                        Text(entry.inside)
                            .font(Type.body(12))
                            .lineSpacing(3)
                            .foregroundStyle(Ink.paperFaint)
                            .fixedSize(horizontal: false, vertical: true)
                            .multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: 8)
                    VStack(alignment: .trailing, spacing: 4) {
                        Text("→")
                            .font(Type.mono(13))
                            .foregroundStyle(Ink.paperDim)
                        Text(entry.fact)
                            .font(Type.mono(9))
                            .kerning(1.1)
                            .foregroundStyle(Ink.paperGhost)
                            .multilineTextAlignment(.trailing)
                    }
                }
                .padding(.vertical, 15)
                Hairline()
            }
        }
        .buttonStyle(.plain)
    }
}

struct RecoveryView: View {
    @EnvironmentObject private var vault: Vault
    @State private var revealed = false
    /// Armed by the first tap on ERASE; the second tap is the one that acts.
    @State private var eraseArmed = false

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                VaultBar(airgap: .hidden)
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Eyebrow("RECOVERY").padding(.top, 16)
                        Statement("TWO PHRASES", "ON PAPER", size: 34).padding(.top, 12)
                        Text("The Bitcoin words and the Monero seed. They are the only backup " +
                             "that exists. Write them by hand. Do not photograph them. The " +
                             "camera roll is on a phone that has a network.")
                            .font(Type.body())
                            .lineSpacing(5)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.top, 14)
                            .padding(.bottom, 22)

                        if let problem {
                            Text(problem)
                                .font(Type.body(13))
                                .lineSpacing(4)
                                .foregroundStyle(Ink.refused)
                                .padding(.bottom, 18)
                        }

                        // Concealed until held; concealed again on release.
                        VStack(alignment: .leading, spacing: 0) {
                            Eyebrow("BITCOIN · BIP39", color: Ink.paperFaint).padding(.bottom, 8)
                            grid(bitcoinWords)
                            Eyebrow("MONERO · SEED WORDS", color: Ink.paperFaint)
                                .padding(.top, 18)
                                .padding(.bottom, 8)
                            grid(moneroWords)
                        }
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
                        FieldRow(label: "ENCRYPTION", value: "ARGON2ID + XCHACHA20", tone: .verified)
                        FieldRow(label: "PASSPHRASE", value: "REQUIRED TO OPEN")
                        FieldRow(label: "KEYCHAIN CLASS", value: "PASSCODE-BOUND · THIS DEVICE ONLY")
                        FieldRow(label: "EXPORTABLE", value: "NO")

                        /* Turning it off needs nothing. Turning it on needs the
                         * passphrase, which only the unlock screen has, so the
                         * offer lives there and only the withdrawal lives here.
                         * A convenience you cannot revoke without producing the
                         * credential it replaced is not one you control. */
                        if vault.biometricsEnrolled {
                            FieldRow(label: "UNLOCK", value: "\(vault.biometricKind.name) OR PASSPHRASE")
                            Lever(title: "STOP USING \(vault.biometricKind.name)",
                                  hint: "PASSPHRASE ONLY",
                                  style: .quiet) {
                                vault.forgetPassphrase()
                            }
                            .padding(.top, 14)
                            Text("The stored passphrase is deleted from this device. The vault " +
                                 "itself does not change: it is sealed under the same passphrase " +
                                 "either way.")
                                .font(Type.body(12))
                                .lineSpacing(3)
                                .foregroundStyle(Ink.paperFaint)
                                .padding(.top, 10)
                        } else {
                            FieldRow(label: "UNLOCK", value: "PASSPHRASE ONLY")
                        }

                        /* Two taps, and the first one says so. A single tap on
                         * an irreversible action is an accident waiting for a
                         * pocket; a system alert would be another product's
                         * voice in this one's most serious moment. */
                        Lever(title: eraseArmed ? "TAP AGAIN TO ERASE EVERYTHING" : "ERASE VAULT",
                              hint: "IRREVERSIBLE",
                              style: .quiet) {
                            if eraseArmed {
                                vault.eraseVault()
                            } else {
                                Haptic.refuse()
                                withAnimation(.easeOut(duration: 0.25)) { eraseArmed = true }
                            }
                        }
                        .padding(.top, 24)

                        Text("Erasing removes the sealed keys from this device's keychain. " +
                             "Without the phrases above there is no way back, and no service " +
                             "to ask.")
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
        .onAppear { load() }
        .onDisappear {
            /* Held in @State for as long as the screen is up and no longer.
             * A String cannot be wiped, but it can stop being referenced. */
            bitcoinWords = []
            moneroWords = []
        }
    }

    /// The words, fetched only when this screen asks for them.
    ///
    /// `revealBackup` is the one call that turns a secret into text, and it is
    /// named that way on both sides of the bridge. It answers only while the
    /// vault is unlocked, which the route to this screen already guarantees.
    @State private var bitcoinWords: [String] = []
    @State private var moneroWords: [String] = []
    @State private var problem: String?

    private func load() {
        do {
            let backup = try vault.revealBackup()
            bitcoinWords = backup.bitcoin
            moneroWords = backup.monero
        } catch {
            problem = error.localizedDescription
        }
    }

    private func grid(_ words: [String]) -> some View {
        let columns = [GridItem(.flexible(), spacing: 1), GridItem(.flexible(), spacing: 1)]
        return LazyVGrid(columns: columns, spacing: 1) {
            ForEach(words.indices, id: \.self) { i in
                HStack(spacing: 10) {
                    Text("\(i + 1)")
                        .font(Type.mono(10))
                        .foregroundStyle(Ink.paperGhost)
                        .frame(width: 16, alignment: .leading)
                    Text(words[i])
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
