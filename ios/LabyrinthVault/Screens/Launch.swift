//  Launch.swift
//  The instrument powering on. Black; the labyrinth draws itself; the
//  wordmark; a hairline; the airgap statement. No welcome, no marketing —
//  the first thing this product ever says is what it has verified.
//
//  And it means it: `vault.boot()` starts as the drawing starts, loading the
//  engine and running the self-test vectors off the main thread. The screen
//  does not move on until both the animation and the verdict are in. A pass
//  routes to the passphrase screen if a sealed vault exists, or into setup if
//  none does. A failure stops here, with the checks on screen and one
//  action: run them again. There is no way past a failed check, because a
//  device that cannot prove its derivation has no business showing a key.

import SwiftUI

struct LaunchView: View {
    @EnvironmentObject private var vault: Vault
    @State private var pathProgress: CGFloat = 0
    @State private var showMark = false
    @State private var showRule = false
    @State private var showAirgap = false
    /// The power-on choreography has finished playing.
    @State private var settled = false

    private var failed: Bool { vault.booted && !vault.launchPassed }

    var body: some View {
        Screen {
            if failed {
                failure
            } else {
                powerOn
            }
        }
        .onAppear {
            vault.boot()
            run()
        }
        .onChange(of: settled) { _ in proceed() }
        .onChange(of: vault.booted) { _ in proceed() }
    }

    /// Move on only when there is somewhere true to move to: animation done,
    /// boot done, checks green. The failure face renders otherwise.
    private func proceed() {
        guard settled, vault.booted, vault.launchPassed else { return }
        Haptic.verify()
        vault.go(vault.hasVault ? .unlock : .setup(.declaration))
    }

    private var powerOn: some View {
        VStack(spacing: 0) {
            Spacer()

            LabyrinthMark(progress: pathProgress, lineWidth: 1, color: Ink.paper.opacity(0.5))
                .frame(width: 180, height: 180)
                .padding(.bottom, 44)

            VStack(spacing: 6) {
                Text("LABYRINTH")
                    .font(.system(size: 26, weight: .semibold))
                    .kerning(9)
                    .padding(.leading, 9)   // recentre the trailing kern
                Text("VAULT")
                    .font(.system(size: 12, weight: .regular))
                    .kerning(7)
                    .padding(.leading, 7)
                    .foregroundStyle(Ink.paperFaint)
            }
            .foregroundStyle(Ink.paper)
            .opacity(showMark ? 1 : 0)

            Rectangle()
                .fill(Ink.rule)
                .frame(width: showRule ? 120 : 0, height: 1)
                .padding(.vertical, 26)

            HStack(spacing: 8) {
                PulseDot(active: true)
                Text(vault.booted ? "SELF-TEST PASSED" : "RUNNING SELF-TEST")
                    .font(Type.mono(10))
                    .kerning(2)
                    .foregroundStyle(Ink.paperDim)
            }
            .opacity(showAirgap ? 1 : 0)

            Spacer()

            Text("NO NETWORK INTERFACE PRESENT")
                .font(Type.mono(9))
                .kerning(1.8)
                .foregroundStyle(Ink.paperGhost)
                .padding(.bottom, 24)
        }
    }

    /// The gate, shut. Every check by name with its verdict, the engine's
    /// sentence, and one lever. No other exit exists on this screen.
    private var failure: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow("SELF-TEST FAILED", color: Ink.refused).padding(.top, 28)
                    Statement("THIS DEVICE", "CANNOT START.", size: 40).padding(.top, 16)
                    Text(vault.engineProblem ?? "The vault failed its own checks.")
                        .font(Type.body())
                        .lineSpacing(5)
                        .foregroundStyle(Ink.paper)
                        .padding(.top, 14)
                    Text("No key was touched and no screen beyond this one will open. " +
                         "A vault that cannot prove its own derivation must not show a key.")
                        .font(Type.body(13))
                        .lineSpacing(5)
                        .foregroundStyle(Ink.paperDim)
                        .padding(.top, 10)
                        .padding(.bottom, 22)

                    ForEach(vault.checks.indices, id: \.self) { i in
                        FieldRow(label: vault.checks[i].name.uppercased(),
                                 value: vault.checks[i].ok ? "PASSED" : "FAILED",
                                 tone: vault.checks[i].ok ? .verified : .refused)
                    }
                }
                .padding(.horizontal, 24)
            }
            Lever(title: "RUN CHECKS AGAIN") {
                vault.boot()
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 12)
        }
    }

    private func run() {
        withAnimation(.timingCurve(0.16, 0.84, 0.24, 1, duration: 1.6)) { pathProgress = 1 }
        withAnimation(.easeOut(duration: 0.6).delay(0.9)) { showMark = true }
        withAnimation(.timingCurve(0.16, 0.84, 0.24, 1, duration: 0.7).delay(1.5)) { showRule = true }
        withAnimation(.easeOut(duration: 0.5).delay(1.9)) { showAirgap = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.8) { settled = true }
    }
}
