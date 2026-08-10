//  Launch.swift
//  The instrument powering on. Black; the labyrinth draws itself; the
//  wordmark; a hairline; the airgap statement. No welcome, no marketing —
//  the first thing this product ever says is what it has verified.

import SwiftUI

struct LaunchView: View {
    @EnvironmentObject private var vault: Vault
    @State private var pathProgress: CGFloat = 0
    @State private var showMark = false
    @State private var showRule = false
    @State private var showAirgap = false

    var body: some View {
        Screen {
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
                    Text("AIRGAP VERIFIED")
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
        .onAppear { run() }
    }

    private func run() {
        withAnimation(.timingCurve(0.16, 0.84, 0.24, 1, duration: 1.6)) { pathProgress = 1 }
        withAnimation(.easeOut(duration: 0.6).delay(0.9)) { showMark = true }
        withAnimation(.timingCurve(0.16, 0.84, 0.24, 1, duration: 0.7).delay(1.5)) { showRule = true }
        withAnimation(.easeOut(duration: 0.5).delay(1.9)) { showAirgap = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.8) {
            Haptic.verify()
            vault.go(vault.setupComplete ? .home : .setup(.declaration))
        }
    }
}
