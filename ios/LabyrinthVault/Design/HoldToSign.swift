//  HoldToSign.swift
//  A press is a keystroke; a hold is a decision.
//
//  The control fills from the left while the finger stays down, the label
//  inverting where the fill crosses it, and the haptic ramp takes up load
//  underneath — a mechanism being operated, not a button being clicked.
//  Releasing early does not sign, and says so in words. The progress lives on
//  the control itself so the commitment and its evidence are one object.

import SwiftUI

struct HoldToSign: View {
    var enabled: Bool
    var duration: Double = 2.4
    var onSigned: () -> Void

    private static let stages: [(Double, String)] = [
        (0.00, "VERIFYING APPROVED SUMMARY"),
        (0.36, "MATCHING TRANSACTION DIGEST"),
        (0.70, "GENERATING SIGNATURE"),
    ]

    @State private var pressedAt: Date? = nil
    @State private var progress: Double = 0
    @State private var stage: String = "READY"
    @State private var done = false
    @State private var haptics = HoldHaptics()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(enabled ? stage : " ")
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .kerning(1.6)
                .foregroundStyle(stage.hasSuffix("NOT SIGNED") ? Ink.attention : Ink.paperFaint)
                .frame(height: 14)

            ZStack(alignment: .leading) {
                Rectangle()
                    .strokeBorder(done ? Ink.verified : Ink.paper, lineWidth: 1)
                Rectangle()
                    .fill(done ? Ink.verified : Ink.paper)
                    .scaleEffect(x: progress, anchor: .leading)
                Text(done ? "SIGNED" : "HOLD TO SIGN")
                    .font(.system(size: 16, weight: .semibold))
                    .kerning(1.0)
                    .frame(maxWidth: .infinity)
                    .foregroundStyle(.white)
                    .blendMode(.difference)
            }
            .frame(height: 76)
            .contentShape(Rectangle())
            .opacity(enabled ? 1 : 0.3)
            .gesture(holdGesture, including: enabled && !done ? .all : .subviews)
            .overlay {
                // Drive progress off the clock while pressed. TimelineView is
                // paused when idle, so this costs nothing between holds.
                if pressedAt != nil {
                    TimelineView(.animation) { timeline in
                        Color.clear.onChange(of: timeline.date) {
                            advance(now: timeline.date)
                        }
                    }
                }
            }
        }
        .animation(.easeOut(duration: 0.18), value: enabled)
    }

    private var holdGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { _ in
                guard pressedAt == nil, !done else { return }
                pressedAt = Date()
                haptics.begin()
            }
            .onEnded { _ in
                guard !done else { return }
                // Released before the mechanism seated: nothing was signed,
                // and the interface says exactly that rather than resetting
                // silently.
                pressedAt = nil
                haptics.end()
                withAnimation(.easeOut(duration: 0.25)) { progress = 0 }
                stage = "RELEASED · NOT SIGNED"
            }
    }

    private func advance(now: Date) {
        guard let pressedAt, !done else { return }
        let p = min(1, now.timeIntervalSince(pressedAt) / duration)
        progress = p
        haptics.update(progress: Float(p))
        for (threshold, label) in Self.stages.reversed() where p >= threshold {
            stage = label
            break
        }
        if p >= 1 {
            done = true
            self.pressedAt = nil
            haptics.end()
            stage = "SIGNATURE COMPLETE"
            // A beat of stillness before the transition: quiet, not celebratory.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: onSigned)
        }
    }
}
