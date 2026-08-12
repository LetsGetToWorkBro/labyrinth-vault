//  Theme.swift
//  The whole visual system in one file, so there is exactly one place where a
//  color or a size can be decided.
//
//  The rules, restated as code:
//    - One surface, one ink, and three state colors that each mean one thing:
//      green is a verification that passed, amber is attention in progress,
//      red exists only on the refusal screens. If a color is on screen, it is
//      information. Everything else is monochrome.
//    - Two typefaces by role. The grotesk (SF Pro) talks to the person; the
//      monospace (SF Mono) shows cryptographic material, where characters are
//      compared one at a time and tabular figures are not a nicety.
//    - Hairlines instead of cards. Structure comes from rules and spacing.
//    - Nothing glows, nothing bounces, nothing is a pill.

import SwiftUI

// MARK: - Color

enum Ink {
    /// Not pure black: pure black flares against OLED smear and kills the grain.
    static let void      = Color(red: 0.031, green: 0.031, blue: 0.039)  // #08080A
    static let surface   = Color(red: 0.047, green: 0.047, blue: 0.055)  // #0C0C0E
    static let surface2  = Color(red: 0.071, green: 0.071, blue: 0.082)  // #121215

    /// Warm off-white. A cold white on near-black reads clinical and cheap.
    static let paper     = Color(red: 0.937, green: 0.918, blue: 0.886)  // #EFEAE2
    static let paperDim  = paper.opacity(0.58)
    static let paperFaint = paper.opacity(0.34)
    static let paperGhost = paper.opacity(0.16)

    static let rule       = paper.opacity(0.13)
    static let ruleStrong = paper.opacity(0.30)
    static let ruleHeavy  = paper.opacity(0.72)

    /// Verification that passed. Held well off full saturation.
    static let verified  = Color(red: 0.263, green: 0.580, blue: 0.416)  // #43946A
    /// Attention in progress: a scan running, a hold ramping, a value to read.
    static let attention = Color(red: 0.878, green: 0.541, blue: 0.180)  // #E08A2E
    /// Refusal, and nothing else. Never used as an alarm inside a live flow.
    static let refused   = Color(red: 0.761, green: 0.298, blue: 0.247)  // #C24C3F

    /// Protocols, not brands. One step off saturation so the interface stays
    /// monochrome first.
    static let btc = Color(red: 0.847, green: 0.518, blue: 0.173)        // #D8842C
    static let xmr = Color(red: 0.722, green: 0.451, blue: 0.290)        // #B8734A
}

// MARK: - Type

enum Type {
    /// The vault says few things; it says them very large.
    static func statement(_ size: CGFloat = 44) -> Font {
        .system(size: size, weight: .semibold)
    }
    static func mega(_ size: CGFloat = 64) -> Font {
        .system(size: size, weight: .bold)
    }
    /// The instrument readout. An amount is a measurement, so it is set like one.
    static func readout(_ size: CGFloat = 52) -> Font {
        .system(size: size, weight: .medium, design: .monospaced)
    }
    static func mono(_ size: CGFloat = 13) -> Font {
        .system(size: size, weight: .regular, design: .monospaced)
    }
    static func body(_ size: CGFloat = 15) -> Font {
        .system(size: size, weight: .regular)
    }
}

/// The interface's smallest voice: field labels, states, system lines.
struct Eyebrow: View {
    let text: String
    var color: Color = Ink.paperFaint
    init(_ text: String, color: Color = Ink.paperFaint) {
        self.text = text; self.color = color
    }
    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .kerning(2.2)
            .textCase(.uppercase)
            .foregroundStyle(color)
    }
}

/// A statement headline with the tight negative tracking the system uses.
struct Statement: View {
    let lines: [String]
    var size: CGFloat = 44
    init(_ lines: String..., size: CGFloat = 44) { self.lines = lines; self.size = size }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(lines, id: \.self) { line in
                Text(line)
                    .font(Type.statement(size))
                    .kerning(size * -0.035)
                    .lineSpacing(-size * 0.06)
            }
        }
        .foregroundStyle(Ink.paper)
    }
}

// MARK: - Structure

struct Hairline: View {
    var weight: CGFloat = 1
    var color: Color = Ink.rule
    var body: some View {
        Rectangle().fill(color).frame(height: weight)
    }
}

/// The atom of every diagnostic and every transaction detail: label left,
/// value right, hairline under. Nothing else.
struct FieldRow: View {
    enum Tone { case plain, dim, verified, attention, refused }
    let label: String
    let value: String
    var tone: Tone = .plain

    var valueColor: Color {
        switch tone {
        case .plain: Ink.paper
        case .dim: Ink.paperDim
        case .verified: Ink.verified
        case .attention: Ink.attention
        case .refused: Ink.refused
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Eyebrow(label)
                Spacer(minLength: 16)
                Text(value)
                    .font(Type.mono(13.5))
                    .foregroundStyle(valueColor)
                    .multilineTextAlignment(.trailing)
            }
            .padding(.vertical, 15)
            Hairline()
        }
    }
}

/// A verification line. Not a generic checkmark: the mark is a box that a
/// specific check either earned or did not, and a failed one stays on screen.
struct Attestation: View {
    enum State { case pending, passed, failed }
    let text: String
    var state: State = .passed

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                ZStack {
                    Rectangle()
                        .strokeBorder(borderColor, lineWidth: 1)
                        .frame(width: 15, height: 15)
                    if state == .passed {
                        Image(systemName: "checkmark")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(Ink.verified)
                    } else if state == .failed {
                        Image(systemName: "xmark")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(Ink.refused)
                    }
                }
                Text(text)
                    .font(Type.mono(11.5))
                    .kerning(0.7)
                    .foregroundStyle(state == .pending ? Ink.paperFaint : Ink.paper.opacity(0.9))
                Spacer()
            }
            .padding(.vertical, 13)
            Hairline()
        }
    }

    private var borderColor: Color {
        switch state {
        case .pending: Ink.ruleStrong
        case .passed: Ink.verified
        case .failed: Ink.refused
        }
    }
}

// MARK: - Controls

/// A control on this device is a lever, so it is sized like one and does not
/// pretend to float. Large, flat, rectangular; sharp corners.
struct Lever: View {
    enum Style { case primary, quiet }
    let title: String
    var hint: String = ""
    var style: Style = .primary
    var enabled: Bool = true
    let action: () -> Void

    var body: some View {
        Button {
            Haptic.tick()
            action()
        } label: {
            HStack {
                Text(title)
                    .font(.system(size: 15, weight: .semibold))
                    .kerning(0.4)
                Spacer()
                if !hint.isEmpty {
                    Text(hint)
                        .font(.system(size: 9.5, weight: .medium, design: .monospaced))
                        .kerning(1.4)
                        .textCase(.uppercase)
                        .opacity(0.55)
                }
            }
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity)
            .frame(height: style == .primary ? 66 : 56)
            .foregroundStyle(style == .primary ? Ink.void : Ink.paperDim)
            .background(style == .primary ? Ink.paper : .clear)
            .overlay {
                if style == .quiet {
                    Rectangle().strokeBorder(Ink.ruleStrong, lineWidth: 1)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.3)
        .animation(.easeOut(duration: 0.18), value: enabled)
    }
}

// MARK: - Texture

/// Physical texture, held below the threshold of noticing. A flat dark
/// rectangle looks like a slide; a very slightly noisy one looks like a
/// surface. Deterministic, cheap, and static — grain does not swim.
struct Grain: View {
    var body: some View {
        Canvas { context, size in
            var seed: UInt64 = 0x9E3779B97F4A7C15
            func next() -> CGFloat {
                seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17
                return CGFloat(seed % 1000) / 1000
            }
            let count = Int(size.width * size.height / 160)
            for _ in 0..<count {
                let r = CGRect(x: next() * size.width, y: next() * size.height,
                               width: 1, height: 1)
                context.fill(Path(r), with: .color(.white.opacity(0.028 + 0.03 * next())))
            }
        }
        .allowsHitTesting(false)
        .ignoresSafeArea()
    }
}

// MARK: - Screen scaffold

/// Every screen: void background, grain on top, content between the safe areas.
struct Screen<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        ZStack {
            Ink.void.ignoresSafeArea()
            content
            Grain()
        }
        .preferredColorScheme(.dark)
    }
}

/// The vault's status bar: the wordmark and the standing claim. No clock, no
/// battery theatre, no carrier — there is no carrier.
///
/// The claim is about the build, not the radios: NO NETWORK CODE is true on
/// any device and checkable against the binary, where "airgap verified" would
/// be a reading this app has no instrument for. The radios are the person's
/// half, and the one screen that talks about them says exactly that. During
/// setup, before the radios walk is even offered, the bar shows the airgap as
/// the unfinished work it is.
struct VaultBar: View {
    @EnvironmentObject private var vault: Vault
    enum Airgap { case verified, unverified, hidden }
    var airgap: Airgap = .verified

    var body: some View {
        HStack {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text("LABYRINTH")
                    .font(.system(size: 11, weight: .semibold))
                    .kerning(2.2)
                    .foregroundStyle(Ink.paper)
                Text("VAULT")
                    .font(.system(size: 11, weight: .regular))
                    .kerning(2.2)
                    .foregroundStyle(Ink.paperFaint)
            }

            /* The demo walk is real cryptography against demo keys, and no
             * screen it crosses is allowed to look like ordinary use. */
            if vault.demoActive {
                Text("DEMO")
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .kerning(1.8)
                    .foregroundStyle(Ink.attention)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .overlay { Rectangle().strokeBorder(Ink.attention.opacity(0.6), lineWidth: 1) }
                    .padding(.leading, 12)
            }

            Spacer()
            if airgap != .hidden {
                HStack(spacing: 7) {
                    PulseDot(active: airgap == .verified)
                    Text(airgap == .verified ? "NO NETWORK CODE" : "AIRGAP  NOT YET MADE")
                        .font(.system(size: 9.5, weight: .medium, design: .monospaced))
                        .kerning(1.6)
                        .foregroundStyle(Ink.paperDim)
                }
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 14)
        .padding(.bottom, 12)
    }
}

struct PulseDot: View {
    var active: Bool
    @State private var dim = false
    var body: some View {
        Rectangle()
            .fill(active ? Ink.verified : Ink.paperGhost)
            .frame(width: 5, height: 5)
            .opacity(dim ? 0.35 : 1)
            .onAppear {
                guard active else { return }
                withAnimation(.easeInOut(duration: 1.7).repeatForever(autoreverses: true)) {
                    dim = true
                }
            }
    }
}
