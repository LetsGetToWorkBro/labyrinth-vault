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

import SwiftUI

struct UnlockView: View {
    @EnvironmentObject private var vault: Vault
    @State private var passphrase = ""
    @State private var problem: String?
    @FocusState private var focused: Bool

    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 0) {
                VaultBar()
                Spacer()
                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow("LOCKED")
                    Statement("ENTER", "PASSPHRASE.", size: 44).padding(.top, 16)
                    Text("The keys on this device are sealed. The passphrase is stretched " +
                         "into the decryption key; it is not stored anywhere, and there is " +
                         "no way to recover it.")
                        .font(Type.body())
                        .lineSpacing(5)
                        .foregroundStyle(Ink.paperDim)
                        .padding(.top, 14)
                        .padding(.bottom, 30)

                    Eyebrow("PASSPHRASE", color: Ink.paperFaint)
                    SecureField("", text: $passphrase)
                        .font(Type.mono(18))
                        .foregroundStyle(Ink.paper)
                        .tint(Ink.paper)
                        .textContentType(.password)
                        .focused($focused)
                        .submitLabel(.go)
                        .onSubmit { attempt() }
                        .padding(.vertical, 12)
                        .disabled(vault.opening)
                    Hairline(weight: 1, color: focused ? Ink.ruleHeavy : Ink.rule)

                    if let problem {
                        Text(problem)
                            .font(Type.body(13))
                            .lineSpacing(4)
                            .foregroundStyle(Ink.refused)
                            .padding(.top, 12)
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
        .onAppear { focused = true }
    }

    private func attempt() {
        guard !vault.opening, !passphrase.isEmpty else { return }
        problem = nil
        Task {
            let failure = await vault.openVault(passphrase: passphrase)
            if let failure {
                problem = failure
            } else {
                /* Unlocked and routed home. Drop what the field is holding —
                 * the String itself cannot be wiped, but nothing should keep
                 * showing it either. */
                passphrase = ""
            }
        }
    }
}
