//  QRCode.swift
//  QR generation and presentation. CoreImage's generator runs entirely on
//  device — the codes here are real and never touch anything with a socket.
//
//  Presentation rule: a QR on this device is an instrument aperture, not a
//  payment sticker. Paper field, generous quiet zone, hairline perimeter, and
//  a perimeter trace that moves only while frames are actually being emitted.

import SwiftUI
import CoreImage.CIFilterBuiltins

enum QRCode {
    /// Render a payload at exact module scale so edges stay crisp.
    static func image(_ payload: String, scale: CGFloat = 12) -> UIImage {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        filter.correctionLevel = "M"   // matches the wire's choice: large modules over redundancy
        guard let output = filter.outputImage else { return UIImage() }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let context = CIContext()
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return UIImage() }
        return UIImage(cgImage: cg)
    }
}

/// The aperture: shows a (possibly multi-frame) payload stream. The frame
/// counter is the honest signal that this is a stream, not a still image.
struct QRAperture: View {
    /// One string per LV1/UR frame; single-element array for a static code.
    let frames: [String]
    var interval: Double = 0.8

    @State private var index = 0
    private var timer: Timer.TimerPublisher { Timer.publish(every: interval, on: .main, in: .common) }

    var body: some View {
        VStack(spacing: 10) {
            ZStack {
                Rectangle().fill(Ink.paper)
                Image(uiImage: QRCode.image(frames[index]))
                    .resizable()
                    .interpolation(.none)
                    .aspectRatio(1, contentMode: .fit)
                    .padding(18)
            }
            .aspectRatio(1, contentMode: .fit)
            .overlay { PerimeterTrace(active: frames.count > 1) }

            if frames.count > 1 {
                HStack {
                    Eyebrow("FRAME")
                    Spacer()
                    Text("\(index + 1) / \(frames.count)")
                        .font(Type.mono(12))
                        .foregroundStyle(Ink.paper)
                }
            }
        }
        .onReceive(timer.autoconnect()) { _ in
            guard frames.count > 1 else { return }
            index = (index + 1) % frames.count
        }
    }
}

/// A short amber segment travelling the aperture's outline: transmission is
/// live. Static when the code is static.
struct PerimeterTrace: View {
    var active: Bool
    @State private var phase: CGFloat = 0

    var body: some View {
        Rectangle()
            .inset(by: -8)
            .trim(from: phase, to: min(phase + 0.09, 1))
            .stroke(Ink.attention, lineWidth: 1)
            .opacity(active ? 1 : 0.4)
            .onAppear {
                guard active else { return }
                withAnimation(.linear(duration: 4.2).repeatForever(autoreverses: false)) {
                    phase = 0.91
                }
            }
    }
}

/// A destination address set for comparison rather than reading: grouped in
/// fours, head and tail weighted, because a substitution attack changes the
/// middle and keeps the ends familiar.
struct AddressText: View {
    let address: String
    var size: CGFloat = 19

    var body: some View {
        let groups = stride(from: 0, to: address.count, by: 4).map { i -> String in
            let s = address.index(address.startIndex, offsetBy: i)
            let e = address.index(s, offsetBy: min(4, address.count - i))
            return String(address[s..<e])
        }
        return Text(attributed(groups))
            .font(.system(size: size, weight: .regular, design: .monospaced))
            .kerning(0.8)
            .lineSpacing(size * 0.55)
    }

    private func attributed(_ groups: [String]) -> AttributedString {
        var out = AttributedString()
        for (i, g) in groups.enumerated() {
            var part = AttributedString(g)
            if i < 2 || i >= groups.count - 2 {
                part.font = .system(size: size, weight: .semibold, design: .monospaced)
                part.backgroundColor = Ink.attention.opacity(0.14)
            }
            out += part
            if i < groups.count - 1 { out += AttributedString(" ") }
        }
        return out
    }
}
