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

/// The descent: the wait for a key derivation, drawn as travel inward.
///
/// `LabyrinthShape` is built from the center outward, so trimming it backwards
/// — `from: 1 - reach, to: 1` — reveals the outermost run first and grows
/// toward the middle. That is the figure this screen wants: the whole
/// labyrinth is there from the first frame, faint and unentered, and the
/// bright path is how far in the work has got. The passphrase is not being
/// looked up somewhere. It is being carried down.
///
/// The center of the frame is the path's own first point, so the mark sitting
/// there is exactly the place the descent is heading, without any arithmetic
/// to keep the two agreeing.
///
/// ## Two behaviors, because there are two honest states
///
/// With `reach` supplied the descent *is* the progress: it arrives at the
/// center when the derivation finishes, and nothing about it is decorative.
///
/// Without one, nothing is known and the descent loops instead: down over five
/// and a half seconds, a moment held at the center, then a fade and again from
/// the top. A loop says "still working" without claiming to know how far
/// through it is, and it is also true to the shape of the work, since Argon2id
/// makes repeated passes over the same memory. What it must never do is creep
/// toward an arrival nobody measured, which is a progress bar's way of lying.
struct Descent: View {
    /// Real progress through the derivation, or nil while none is knowable.
    var reach: Double?
    var turns: Int = 7

    private let descend = 5.5
    private let hold = 0.9
    private let fade = 0.6
    private var cycleLength: Double { descend + hold + fade }

    var body: some View {
        TimelineView(.animation) { timeline in
            let clock = timeline.date.timeIntervalSinceReferenceDate
            let cycle = clock.truncatingRemainder(dividingBy: cycleLength)
            let looping = reach == nil
            // Cubic ease out, so the descent slows as it nears the middle.
            let raw = looping ? min(1, cycle / descend) : min(1, max(0, reach ?? 0))
            let depth = looping ? 1 - pow(1 - raw, 3) : raw
            let dimming = looping && cycle > descend + hold
                ? 1 - (cycle - descend - hold) / fade
                : 1

            GeometryReader { geo in
                let side = min(geo.size.width, geo.size.height)
                let square = CGRect(x: 0, y: 0, width: side, height: side)
                let full = LabyrinthShape(turns: turns).path(in: square)
                ZStack {
                    // Every level, none of them entered.
                    full.stroke(Ink.paper.opacity(0.10 * dimming), lineWidth: 1)

                    // How deep the work has got.
                    full.trimmedPath(from: 1 - depth, to: 1)
                        .stroke(Ink.paper.opacity(0.9 * dimming),
                                style: StrokeStyle(lineWidth: 1.4, lineJoin: .miter))

                    // The head of it, so there is always something moving even
                    // on the long straight runs of the outer levels.
                    if depth > 0, depth < 1,
                       let tip = full.trimmedPath(from: 0, to: 1 - depth).currentPoint {
                        Rectangle()
                            .fill(Ink.paper.opacity(dimming))
                            .frame(width: 3.5, height: 3.5)
                            .position(tip)
                    }

                    // What is down there. It brightens as the descent closes on
                    // it and never quite settles, because it has not been
                    // reached yet.
                    Rectangle()
                        .fill(Ink.attention)
                        .frame(width: 5, height: 5)
                        .opacity((0.25 + 0.7 * depth) * (0.6 + 0.4 * sin(clock * 2.2)) * dimming)
                        .position(x: side / 2, y: side / 2)
                }
                .frame(width: side, height: side)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }
}
