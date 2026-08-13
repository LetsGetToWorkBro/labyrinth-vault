//  Unlock.swift
//  The passphrase, between a sealed vault and everything else.
//
//  This screen exists whenever a launch (or a return from the background)
//  finds ciphertext in the keychain. It asks for one thing and offers one
//  action. A failure is a sentence under the field, and by design the
//  sentence cannot say whether the passphrase was wrong or the blob is
//  damaged — src/keys/seal.ts refuses to know, so nothing up here can either.
//
//  The deliberate pause on the lever is the KDF running: Argon2id, tuned to
//  cost real time per guess. The screen names it rather than hiding it,
//  because a person who knows why the second is being spent trusts it more
//  than one shown a spinner.
//
//  ## Face ID is offered here and never assumed
//
//  When a passphrase has been stored behind biometry, the button for it sits
//  above the field and the field stays exactly where it was. It is a shortcut
//  past the typing, not a replacement for the vault's lock, and if it fails
//  for any reason a person is left on the screen they already know.
//
//  Storing it is an unticked box on this screen rather than a prompt after the
//  fact. A prompt would have to appear as this view is being torn down —
//  `openVault` routes home the moment it succeeds — and the box has the
//  further virtue of being a decision made before the convenience is felt
//  rather than in the glow of it. `Support/BiometricUnlock.swift` carries the
//  argument about what it costs.

import SwiftUI
// For `isIdleTimerDisabled`. See the comment on `.onChange(of: vault.opening)`.
import UIKit

struct UnlockView: View {
    @EnvironmentObject private var vault: Vault
    @State private var passphrase = ""
    @State private var problem: String?
    @State private var remember = false
    @FocusState private var field: PassphraseFocus?
    /// When the current derivation started, so the screen can show that it is
    /// still going rather than only that it began.
    @State private var openedAt: Date?

    /// Offer to store it only where there is a sensor and nothing stored yet.
    private var canOfferToRemember: Bool {
        vault.biometricKind.isAvailable && !vault.biometricsEnrolled
    }

    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 0) {
                VaultBar()
                Spacer()
                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow("LOCKED")
                    Statement("ENTER", "PASSPHRASE.", size: 44).padding(.top, 16)
                    if let notice = vault.notice {
                        /* Why this screen appeared, when the reason is not
                         * obvious — the demo walk ending, mainly. */
                        Text(notice)
                            .font(Type.body(13))
                            .lineSpacing(4)
                            .foregroundStyle(Ink.attention)
                            .padding(.top, 12)
                    }
                    Text("The keys on this device are sealed. The passphrase is stretched " +
                         "into the decryption key; it is not stored anywhere, and there is " +
                         "no way to recover it.")
                        .font(Type.body())
                        .lineSpacing(5)
                        .foregroundStyle(Ink.paperDim)
                        .padding(.top, 14)
                        .padding(.bottom, 30)

                    if vault.biometricsEnrolled {
                        Lever(title: "UNLOCK WITH \(vault.biometricKind.name)",
                              style: .quiet,
                              enabled: !vault.opening) {
                            attemptBiometric()
                        }
                        .padding(.bottom, 22)
                    }

                    PassphraseField(label: "PASSPHRASE",
                                    text: $passphrase,
                                    focus: $field,
                                    equals: .entry,
                                    contentType: .password,
                                    submitLabel: .go,
                                    disabled: vault.opening) { attempt() }

                    if let problem {
                        Text(problem)
                            .font(Type.body(13))
                            .lineSpacing(4)
                            .foregroundStyle(Ink.refused)
                            .padding(.top, 12)
                    }

                    if vault.opening {
                        working.padding(.top, 14)
                    } else if canOfferToRemember {
                        rememberOffer.padding(.top, 8)
                    }
                }
                .padding(.horizontal, 24)
                Spacer()
                Lever(title: vault.opening ? "DERIVING KEY" : "UNLOCK",
                      hint: vault.opening ? "ARGON2ID" : "",
                      enabled: !vault.opening && !passphrase.isEmpty) {
                    attempt()
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 12)
            }
        }
        .onAppear {
            vault.refreshBiometricState()
            /* The keyboard is not raised when there is a face to offer: doing
             * both puts a system sheet over a keyboard that is animating in,
             * and a person has to dismiss furniture before they can act. */
            if !vault.biometricsEnrolled { field = .entry }
        }
        /* ## The phone must not sleep in the middle of a derivation
         *
         * Argon2id here takes as long as it takes on the setup screen, and a
         * person waiting on it is by definition not touching the phone. Auto
         * Lock fires, the app goes to the background, `sleep()` wipes the
         * session, and iOS may stop an app still burning CPU there. The unlock
         * a person was waiting for then either never lands or lands on a
         * screen that has thrown it away.
         *
         * Scoped to the derivation rather than the screen. A passphrase screen
         * can sit up for as long as somebody leaves it up, and holding a phone
         * awake for that is a battery complaint with no security to show for
         * it. Off again on the way out, because whoever turned it on owns
         * turning it off. */
        .onChange(of: vault.opening) { opening in
            openedAt = opening ? Date() : nil
            UIApplication.shared.isIdleTimerDisabled = opening
        }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }

    /// Shown only while the key is being derived: a clock that moves, and the
    /// two sentences a person waiting on a blank-looking screen needs.
    private var working: some View {
        VStack(alignment: .leading, spacing: 9) {
            TimelineView(.periodic(from: .now, by: 1)) { timeline in
                let seconds = max(0, timeline.date.timeIntervalSince(openedAt ?? timeline.date))
                Text("WORKING · \(Int(seconds) / 60):\(String(format: "%02d", Int(seconds) % 60))")
                    .font(Type.mono(11))
                    .kerning(1.6)
                    .foregroundStyle(Ink.attention)
            }
            Text("Not frozen. Stretching the passphrase into the key is the work that " +
                 "makes guessing it expensive, and it costs you once what it costs an " +
                 "attacker every attempt. The phone is being held awake until it " +
                 "finishes; do not leave the app.")
                .font(Type.body(12))
                .lineSpacing(3)
                .foregroundStyle(Ink.paperFaint)
        }
    }

    /// The unticked box, and the sentence about who it is worse against.
    ///
    /// The cost line is not hidden behind a disclosure. Somebody who ticks
    /// this without reading it has still had it in front of them, which is the
    /// most a screen can honestly do.
    private var rememberOffer: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                Haptic.tick()
                remember.toggle()
            } label: {
                Attestation(text: "REMEMBER WITH \(vault.biometricKind.name)",
                            state: remember ? .passed : .pending)
            }
            .buttonStyle(.plain)

            Text("Kept on this phone, released only to \(vault.biometricKind.name.capitalized). " +
                 "Opening the vault would then need this phone and your face rather " +
                 "than something only you know.")
                .font(Type.body(12))
                .lineSpacing(3)
                .foregroundStyle(Ink.paperFaint)
                .padding(.top, 10)
        }
    }

    private func attempt() {
        guard !vault.opening, !passphrase.isEmpty else { return }
        problem = nil
        let typed = passphrase
        let shouldRemember = remember && canOfferToRemember
        Task {
            let failure = await vault.openVault(passphrase: typed)
            if let failure {
                problem = failure
                return
            }
            /* Stored only after the seal has actually opened under it. A
             * passphrase that merely got typed would give a face a shortcut to
             * a vault it cannot open, which is a button that fails forever. */
            if shouldRemember {
                if let refused = vault.rememberPassphrase(typed) {
                    problem = refused
                }
            }
            /* The String itself cannot be wiped, but nothing should keep
             * showing it either. */
            passphrase = ""
        }
    }

    private func attemptBiometric() {
        guard !vault.opening else { return }
        problem = nil
        Task {
            if let failure = await vault.unlockWithBiometrics() {
                problem = failure
                field = .entry
            }
        }
    }
}
