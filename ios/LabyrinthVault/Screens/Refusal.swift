//  Refusal.swift
//  Fail closed, composed like a title card rather than an alert.
//
//  This screen has exactly one control, SCAN AGAIN, and that is the entire
//  design. There is no second button of any wording — the conditions that
//  reach this screen are ones where the confirmation screen would necessarily
//  be lying (see src/keys/psbt.ts), and a lying screen with a warning on it
//  is worse than no signature. Refusal is the product working, so it is set
//  with the same care as success. (test/ios-no-network.test.ts greps for the
//  usual escape-hatch phrasings and fails the build if one ever appears.)

import SwiftUI

struct RefusalView: View {
    @EnvironmentObject private var vault: Vault
    let refusal: Refusal

    @State private var barShown = false

    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 0) {
                // The structural interruption: a solid bar across the top,
                // arriving with the hard-stop haptic. Red's only appearance.
                Rectangle()
                    .fill(Ink.refused)
                    .frame(height: 3)
                    .scaleEffect(x: barShown ? 1 : 0, anchor: .leading)

                HStack {
                    Eyebrow("SIGNING REFUSED", color: Ink.paper)
                    Spacer()
                    Eyebrow("VAULT · FAIL CLOSED")
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 16)

                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        // Frozen, unfinished: the labyrinth stopped where it was.
                        LabyrinthMark(progress: 0.62, broken: true, lineWidth: 1,
                                      color: Ink.paper.opacity(0.25))
                            .frame(width: 84, height: 84)
                            .padding(.top, 18)
                            .padding(.bottom, 26)

                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(refusal.headline, id: \.self) { line in
                                Text(line)
                                    .font(Type.mega(56))
                                    .kerning(-2.4)
                                    .foregroundStyle(Ink.paper)
                            }
                        }
                        .padding(.bottom, 26)

                        Hairline(weight: 2, color: Ink.ruleHeavy)

                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(refusal.why, id: \.self) { line in
                                Text(line)
                                    .font(Type.mono(15))
                                    .kerning(0.4)
                                    .foregroundStyle(Ink.paper)
                            }
                        }
                        .padding(.top, 24)
                        .padding(.bottom, 18)

                        Text(refusal.detail)
                            .font(Type.body())
                            .lineSpacing(5)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.bottom, 24)

                        ForEach(refusal.findings, id: \.0) { finding in
                            Attestation(text: finding.0, state: finding.1 ? .passed : .failed)
                        }
                        Spacer(minLength: 24)
                    }
                    .padding(.horizontal, 24)
                }

                // The only way out.
                Lever(title: "SCAN AGAIN") { vault.scanAgain() }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
            }
        }
        .onAppear {
            Haptic.refuse()
            // The bar is the one element that animates; everything else is
            // already still. Refusal is a hard stop, not a sequence.
            withAnimation(.timingCurve(0.7, 0, 0.2, 1, duration: 0.35)) { barShown = true }
        }
    }
}
