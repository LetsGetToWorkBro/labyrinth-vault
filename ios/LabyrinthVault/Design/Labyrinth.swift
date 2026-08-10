//  Labyrinth.swift
//  The brand geometry: a right-angle involute drawn as one continuous path
//  from a single centre outward. It is never an illustration of a maze; it is
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
