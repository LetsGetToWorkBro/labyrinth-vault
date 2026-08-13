//  Labyrinth.swift
//  The brand geometry: a right-angle involute drawn as one continuous path
//  from a single center outward. It is never an illustration of a maze; it is
//  architecture, and above all it is a motion system:
//
//    uncertain -> verified : the path draws itself to completion
//    valid     -> refused  : the drawing stops dead where it was
//
//  Used for the launch sequence, the entropy visualisation, verification
//  states, and (at 4-5% opacity) as a watermark behind static screens.

import SwiftUI

struct LabyrinthShape: Shape {
    var turns: Int = 8

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let side = min(rect.width, rect.height)
        let step = side / CGFloat(turns * 4 + 2)
        var pt = CGPoint(x: rect.midX, y: rect.midY)
        var d = step
        p.move(to: pt)
        for _ in 0..<turns {
            pt.x += d; p.addLine(to: pt)
            pt.y -= d; p.addLine(to: pt)
            d += step
            pt.x -= d; p.addLine(to: pt)
            pt.y += d; p.addLine(to: pt)
            d += step
        }
        return p
    }

    /// The polyline as points, resampled roughly evenly — targets for the
    /// entropy particles to resolve onto.
    static func points(in size: CGFloat, turns: Int = 10, spacing: CGFloat = 5) -> [CGPoint] {
        let path = LabyrinthShape(turns: turns)
            .path(in: CGRect(x: 0, y: 0, width: size, height: size))
        var corners: [CGPoint] = []
        path.forEach { element in
            switch element {
            case .move(let to), .line(let to): corners.append(to)
            default: break
            }
        }
        var out: [CGPoint] = []
        for i in 0..<max(0, corners.count - 1) {
            let a = corners[i], b = corners[i + 1]
            let len = hypot(b.x - a.x, b.y - a.y)
            let n = max(1, Int(len / spacing))
            for s in 0..<n {
                let t = CGFloat(s) / CGFloat(n)
                out.append(CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
            }
        }
        return out
    }
}

/// The resolving mark. `progress` draws the path; `broken` freezes it and
/// lets the unfinished remainder ghost in refused red. Refusal is a hard
/// stop, so the freeze is instant — the one transition in the app that is
/// deliberately not eased.
struct LabyrinthMark: View {
    var progress: CGFloat = 1
    var broken: Bool = false
    var lineWidth: CGFloat = 1.2
    var color: Color = Ink.paper

    var body: some View {
        ZStack {
            if broken {
                LabyrinthShape()
                    .trim(from: min(progress, 0.999), to: 1)
                    .stroke(Ink.refused.opacity(0.35), lineWidth: lineWidth)
            }
            LabyrinthShape()
                .trim(from: 0, to: progress)
                .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineJoin: .miter))
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

/// Watermark variant for static screens: bottom-trailing, below noticing.
struct LabyrinthWatermark: View {
    var body: some View {
        GeometryReader { geo in
            LabyrinthShape(turns: 9)
                .stroke(Ink.paper.opacity(0.045), lineWidth: 1)
                .frame(width: geo.size.width * 1.2, height: geo.size.width * 1.2)
                .position(x: geo.size.width * 0.85, y: geo.size.height * 0.92)
        }
        .allowsHitTesting(false)
        .ignoresSafeArea()
    }
}

/// The key-generation visualisation: ~1400 points that begin scattered and
/// resolve, each on its own schedule, onto the labyrinth. A metaphor for the
/// entropy pool becoming a deterministic structure — the real entropy is the
/// platform CSPRNG, and the caption on the screen says so.
struct EntropyField: View {
    let duration: Double
    var onFinished: (() -> Void)? = nil

    private struct Particle {
        let start: CGPoint
        let target: CGPoint
        let delay: Double
    }

    @State private var particles: [Particle] = []
    @State private var begun: Date? = nil
    @State private var finished = false

    var body: some View {
        GeometryReader { geo in
            let side = min(geo.size.width, geo.size.height)
            TimelineView(.animation) { timeline in
                Canvas { context, _ in
                    guard let begun else { return }
                    let t = timeline.date.timeIntervalSince(begun) / duration
                    for p in particles {
                        // Ease each particle's own window with a cubic in-out.
                        let raw = max(0, min(1, (t - p.delay) / (1 - p.delay)))
                        let e = raw < 0.5 ? 4 * raw * raw * raw
                                          : 1 - pow(-2 * raw + 2, 3) / 2
                        let x = p.start.x + (p.target.x - p.start.x) * e
                        let y = p.start.y + (p.target.y - p.start.y) * e
                        let r = CGRect(x: x, y: y, width: 1.6, height: 1.6)
                        context.fill(Path(r), with: .color(Ink.paper.opacity(0.2 + 0.65 * e)))
                    }
                    if t >= 1, !finished {
                        // Flip state outside the draw pass.
                        DispatchQueue.main.async {
                            guard !finished else { return }
                            finished = true
                            onFinished?()
                        }
                    }
                }
            }
            .onAppear {
                var rng = SystemRandomNumberGenerator()
                let targets = LabyrinthShape.points(in: side)
                particles = (0..<1400).map { i in
                    Particle(
                        start: CGPoint(x: .random(in: 0...side, using: &rng),
                                       y: .random(in: 0...side, using: &rng)),
                        target: targets[i % targets.count],
                        delay: .random(in: 0...0.35, using: &rng))
                }
                begun = Date()
            }
            .frame(width: side, height: side)
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

/// The wait for a key derivation, drawn at the length the wait actually is.
///
/// Measured on an iPhone 17 Pro Max: one Argon2id pass takes about 67 seconds,
/// and making a vault runs two. That is the design constraint. A seven-second
/// loop played ten times is not a long animation, it is a short one you are
/// forced to watch repeatedly, and it reads as a stuck app for the same reason
/// a frozen frame does: nothing about it changes.
///
/// So the indeterminate case is one composition roughly as long as a pass, in
/// movements that do not repeat within it.
///
///   gather   particles adrift find the path and settle onto it
///   settle   the labyrinth inks in as the dust hands over to it
///   descend  the bright path travels from the outermost run inward
///   arrive   it reaches the middle and what is down there answers
///   dissolve the whole figure breaks back into dust and scatters
///
/// Each turn of the cycle is rotated a quarter, so a second viewing is not the
/// same viewing. `LabyrinthShape` is built from the center outward, so the
/// descent is `trimmedPath(from: 1 - depth, to: 1)` — the outer run first,
/// growing inward — and the center of the box is the path's own first point,
/// which is why the mark waiting there needs no arithmetic to stay put. A
/// quarter turn about that point leaves it exactly where it was.
///
/// The determinate case ignores all of it. Once the first pass has timed
/// itself the second one has a real proportion to show, so the descent simply
/// *is* that proportion and arrives at the middle as the work finishes. That
/// is the version worth having, and it is the reason the other one must not
/// imitate it: a bar creeping toward an arrival nobody measured is a lie told
/// slowly.
struct KeyMaking: View {
    /// Real progress through the derivation, or nil while none is knowable.
    var reach: Double?
    var turns: Int = 7

    @State private var targets: [CGPoint] = []
    @State private var builtFor: CGFloat = 0

    private let gather = 13.0
    private let settle = 3.0
    private let descend = 24.0
    private let arrive = 5.0
    private let dissolve = 14.0
    private let rest = 4.0
    private var cycle: Double { gather + settle + descend + arrive + dissolve + rest }

    var body: some View {
        GeometryReader { geo in
            let side = min(geo.size.width * 0.86, geo.size.height * 0.52)
            let box = CGRect(x: (geo.size.width - side) / 2,
                             y: (geo.size.height - side) / 2,
                             width: side, height: side)
            TimelineView(.animation) { timeline in
                Canvas { ctx, size in
                    render(&ctx,
                           box: box,
                           canvas: size,
                           clock: timeline.date.timeIntervalSinceReferenceDate)
                }
            }
            .onAppear { rebuild(side) }
            .onChange(of: side) { rebuild($0) }
        }
        .allowsHitTesting(false)
    }

    private func rebuild(_ side: CGFloat) {
        guard side > 1, side != builtFor else { return }
        builtFor = side
        targets = LabyrinthShape.points(in: side, turns: turns, spacing: 5)
    }

    /// Deterministic per-particle noise. Not security randomness and never
    /// mistakable for it: the entropy on this screen came from the platform
    /// CSPRNG long before the first frame drew, and the caption says so.
    private func noise(_ i: Int, _ salt: Double) -> Double {
        let v = sin(Double(i) * 12.9898 + salt * 78.233) * 43758.5453
        return v - v.rounded(.down)
    }

    private func render(_ ctx: inout GraphicsContext, box: CGRect, canvas: CGSize, clock: Double) {
        if let reach {
            let depth = min(1, max(0, reach))
            let path = LabyrinthShape(turns: turns).path(in: box)
            ctx.stroke(path, with: .color(Ink.paper.opacity(0.10)), lineWidth: 1)
            ctx.stroke(path.trimmedPath(from: 1 - depth, to: 1),
                       with: .color(Ink.paper.opacity(0.9)),
                       style: StrokeStyle(lineWidth: 1.6, lineJoin: .miter))
            if depth > 0, depth < 1,
               let tip = path.trimmedPath(from: 0, to: 1 - depth).currentPoint {
                ctx.fill(Path(CGRect(x: tip.x - 2, y: tip.y - 2, width: 4, height: 4)),
                         with: .color(Ink.paper))
            }
            center(&ctx, box: box, clock: clock, glow: 0.25 + 0.7 * depth)
            return
        }

        let t = clock.truncatingRemainder(dividingBy: cycle)
        let round = Double(Int(clock / cycle))
        let g1 = gather, g2 = g1 + settle, g3 = g2 + descend
        let g4 = g3 + arrive, g5 = g4 + dissolve

        // A quarter turn per cycle, about the point the descent is heading for.
        let spin = CGAffineTransform(translationX: box.midX, y: box.midY)
            .rotated(by: CGFloat(Int(round) % 4) * .pi / 2)
            .translatedBy(x: -box.midX, y: -box.midY)
        let path = LabyrinthShape(turns: turns).path(in: box).applying(spin)

        let ink: Double
        if t < g1 { ink = 0 }
        else if t < g2 { ink = (t - g1) / settle }
        else if t < g4 { ink = 1 }
        else if t < g5 { ink = max(0, 1 - (t - g4) / dissolve) }
        else { ink = 0 }

        let depth: Double
        if t < g2 { depth = 0 }
        else if t < g3 { depth = 1 - pow(1 - (t - g2) / descend, 3) }
        else { depth = 1 }

        let dust: Double
        if t < g1 { dust = 1 }
        else if t < g2 { dust = max(0, 1 - (t - g1) / settle) }
        else if t < g4 { dust = 0 }
        else if t < g5 { dust = max(0, 1 - pow((t - g4) / dissolve, 2)) }
        else { dust = 0 }

        if ink > 0 {
            ctx.stroke(path, with: .color(Ink.paper.opacity(0.10 * ink)), lineWidth: 1)
            if depth > 0 {
                ctx.stroke(path.trimmedPath(from: 1 - depth, to: 1),
                           with: .color(Ink.paper.opacity(0.85 * ink)),
                           style: StrokeStyle(lineWidth: 1.6, lineJoin: .miter))
            }
            if depth > 0, depth < 1,
               let tip = path.trimmedPath(from: 0, to: 1 - depth).currentPoint {
                ctx.fill(Path(CGRect(x: tip.x - 2, y: tip.y - 2, width: 4, height: 4)),
                         with: .color(Ink.paper.opacity(ink)))
            }
        }

        if dust > 0, !targets.isEmpty {
            let gathering = t < g2
            let phase = gathering ? min(1, t / g1) : min(1, (t - g4) / dissolve)
            let reach = max(canvas.width, canvas.height)
            var speck = Path()
            for i in targets.indices {
                let home = targets[i]
                    .applying(CGAffineTransform(translationX: box.minX, y: box.minY))
                    .applying(spin)
                let lead = noise(i, 3.1 + round) * 0.7
                let step = max(0, min(1, (phase - lead) / (1 - lead)))
                let eased = step < 0.5 ? 4 * step * step * step
                                       : 1 - pow(-2 * step + 2, 3) / 2
                // Adrift somewhere on the whole screen when gathering; thrown
                // outward from where it sat when dissolving.
                let angle = noise(i, 7.7 + round) * 2 * .pi
                let far = gathering
                    ? CGPoint(x: noise(i, 1.7 + round) * canvas.width,
                              y: noise(i, 5.3 + round) * canvas.height)
                    : CGPoint(x: home.x + cos(angle) * reach * (0.3 + 0.5 * noise(i, 9.1)),
                              y: home.y + sin(angle) * reach * (0.3 + 0.5 * noise(i, 9.1)))
                let from = gathering ? far : home
                let to = gathering ? home : far
                let at = CGPoint(x: from.x + (to.x - from.x) * eased,
                                 y: from.y + (to.y - from.y) * eased)
                speck.addRect(CGRect(x: at.x - 0.8, y: at.y - 0.8, width: 1.6, height: 1.6))
            }
            ctx.fill(speck, with: .color(Ink.paper.opacity(0.55 * dust)))
        }

        center(&ctx, box: box, clock: clock, glow: (0.2 + 0.8 * depth) * max(ink, dust))
    }

    /// What is down there. It brightens as the descent closes on it and never
    /// quite settles, because it has not been reached yet.
    private func center(_ ctx: inout GraphicsContext, box: CGRect, clock: Double, glow: Double) {
        let pulse = 0.6 + 0.4 * sin(clock * 2.2)
        let s: CGFloat = 6
        ctx.fill(Path(CGRect(x: box.midX - s / 2, y: box.midY - s / 2, width: s, height: s)),
                 with: .color(Ink.attention.opacity(max(0, glow * pulse))))
    }
}
