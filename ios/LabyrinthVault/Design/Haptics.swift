//  Haptics.swift
//  The tactile vocabulary. Six words, used consistently, none of them loud:
//
//    tick     a control was operated / a QR frame landed
//    frame    every Nth acquisition frame (a tick would be noise at 10 Hz)
//    verify   a verification step completed
//    signed   the single restrained confirmation after a signature
//    refuse   the hard stop
//    hold     the continuous ramp under hold-to-sign (CoreHaptics)

import UIKit
import CoreHaptics

enum Haptic {
    private static let light = UIImpactFeedbackGenerator(style: .light)
    private static let rigid = UIImpactFeedbackGenerator(style: .rigid)
    private static let note = UINotificationFeedbackGenerator()

    static func tick() { light.impactOccurred(intensity: 0.55) }
    static func frame() { light.impactOccurred(intensity: 0.35) }
    static func verify() { rigid.impactOccurred(intensity: 0.6) }
    static func signed() { note.notificationOccurred(.success) }
    static func refuse() { note.notificationOccurred(.error) }
}

/// The progressive ramp under the signing hold: a continuous texture whose
/// intensity follows the finger, like a mechanism taking up load. Falls back
/// to silence on devices without CoreHaptics; the visual fill carries alone.
final class HoldHaptics {
    private var engine: CHHapticEngine?
    private var player: CHHapticAdvancedPatternPlayer?

    func begin() {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
        do {
            let engine = try CHHapticEngine()
            try engine.start()
            let event = CHHapticEvent(
                eventType: .hapticContinuous,
                parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.1),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.35),
                ],
                relativeTime: 0, duration: 10)
            let player = try engine.makeAdvancedPlayer(with: CHHapticPattern(events: [event], parameters: []))
            try player.start(atTime: 0)
            self.engine = engine
            self.player = player
        } catch {
            engine = nil; player = nil
        }
    }

    /// intensity follows hold progress: barely-there to firm, never harsh.
    func update(progress: Float) {
        let curve = CHHapticDynamicParameter(
            parameterID: .hapticIntensityControl,
            value: 0.1 + 0.6 * progress, relativeTime: 0)
        try? player?.sendParameters([curve], atTime: 0)
    }

    func end() {
        try? player?.stop(atTime: 0)
        engine?.stop()
        player = nil; engine = nil
    }
}
