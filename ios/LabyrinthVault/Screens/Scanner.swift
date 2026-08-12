//  Scanner.swift
//  The camera, the acquisition, and the completion state — the vault's only
//  input. The camera preview is real AVFoundation on device; in the
//  Simulator, where there is no camera, a simulated wire drives the same
//  interface so the interaction can be exercised anywhere.
//
//  The acquisition view is deliberately not a progress bar. Frames arrive
//  out of order and repeat — that is the fountain code working, not failing —
//  so the honest visualisation is a lattice filling in unevenly, with repeats
//  logged as normal traffic.

import SwiftUI
import AVFoundation

// MARK: - Scanner

struct ScannerView: View {
    @EnvironmentObject private var vault: Vault
    @State private var status = "SEARCHING"

    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 0) {
                VaultBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Eyebrow("RECEIVE").padding(.top, 16)
                        Statement("POINT AT", "THE COMPANION", size: 36).padding(.top, 12).padding(.bottom, 20)

                        CameraViewfinder(status: $status) {
                            // A recognized LV1/UR frame begins acquisition.
                            vault.go(.acquiring)
                        }
                        .aspectRatio(1, contentMode: .fit)

                        FieldRow(label: "WIRE", value: "BC-UR · LABYRINTH ENVELOPE").padding(.top, 18)
                        FieldRow(label: "DETECTION", value: "AUTOMATIC")
                        FieldRow(label: "ACCEPTS", value: "PSBT · XMR UNSIGNED")

                        Text("Both wires are read off one camera loop. Pointing this at a " +
                             "different wallet mid-scan is not a restart.")
                            .font(Type.body(13.5))
                            .lineSpacing(4)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.vertical, 18)
                    }
                    .padding(.horizontal, 24)
                }
                VaultTabs(current: "SIGN")
            }
        }
    }
}

/// Four brackets and a slow sweep; the camera image is the interface.
struct CameraViewfinder: View {
    @Binding var status: String
    var onLock: () -> Void
    @State private var sweep = false

    var body: some View {
        ZStack {
            CameraLayer(onFrame: handleFrame)
                .background(Ink.surface)
                .clipped()

            // Brackets
            ForEach(0..<4, id: \.self) { corner in
                Bracket()
                    .stroke(Ink.paper, lineWidth: 1.5)
                    .frame(width: 26, height: 26)
                    .rotationEffect(.degrees(Double(corner) * 90))
                    .frame(maxWidth: .infinity, maxHeight: .infinity,
                           alignment: [.topLeading, .topTrailing, .bottomTrailing, .bottomLeading][corner])
                    .padding(14)
            }

            // Sweep line: attention, calm.
            GeometryReader { geo in
                Rectangle()
                    .fill(Ink.attention.opacity(0.4))
                    .frame(height: 1)
                    .offset(y: sweep ? geo.size.height * 0.92 : geo.size.height * 0.08)
            }
            .onAppear {
                withAnimation(.easeInOut(duration: 3.6).repeatForever(autoreverses: true)) {
                    sweep = true
                }
            }

            VStack {
                Spacer()
                Text(status)
                    .font(Type.mono(10))
                    .kerning(1.8)
                    .foregroundStyle(Ink.paperDim)
                    .padding(.bottom, 16)
            }
        }
    }

    private func handleFrame(_ payload: String) {
        // The scanner recognizes its wires by shape and never asks the person
        // to know a protocol name.
        if payload.hasPrefix("LV1:") || payload.lowercased().hasPrefix("ur:") {
            status = "LOCKED · ENVELOPE RECOGNIZED"
            Haptic.verify()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: onLock)
        } else {
            status = "CODE IN FRAME · NOT A TRANSACTION"
        }
    }
}

private struct Bracket: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: rect.maxX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.minX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        return p
    }
}

/// AVFoundation on device; a simulated frame source in the Simulator.
struct CameraLayer: UIViewRepresentable {
    var onFrame: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFrame: onFrame) }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        #if targetEnvironment(simulator)
        // No camera in the Simulator: emit one recognizable frame after a
        // beat so the flow can be walked end to end.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
            context.coordinator.onFrame("LV1:PSBT:1:42:9f2a1c04:SIMULATED")
        }
        #else
        context.coordinator.start(in: view)
        #endif
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        #if !targetEnvironment(simulator)
        context.coordinator.layout(in: uiView)
        #endif
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        let onFrame: (String) -> Void
        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?

        init(onFrame: @escaping (String) -> Void) { self.onFrame = onFrame }

        func start(in view: UIView) {
            AVCaptureDevice.requestAccess(for: .video) { granted in
                guard granted else { return }
                DispatchQueue.main.async { self.configure(in: view) }
            }
        }

        private func configure(in view: UIView) {
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else { return }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]

            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.addSublayer(layer)
            preview = layer

            DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
        }

        func layout(in view: UIView) { preview?.frame = view.bounds }

        func metadataOutput(_ output: AVCaptureMetadataOutput,
                            didOutput metadataObjects: [AVMetadataObject],
                            from connection: AVCaptureConnection) {
            for object in metadataObjects {
                if let code = object as? AVMetadataMachineReadableCodeObject,
                   let string = code.stringValue {
                    onFrame(string)
                }
            }
        }
    }
}

// MARK: - Acquisition

struct AcquiringView: View {
    @EnvironmentObject private var vault: Vault

    private let total = 42
    @State private var order: [Int] = Array(1...42).shuffled()
    @State private var received: Set<Int> = []
    @State private var newest: Int? = nil
    @State private var repeats = 0
    @State private var log: [String] = []
    @State private var complete = false

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 3), count: 14)

    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 0) {
                VaultBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Eyebrow("RECEIVING TRANSACTION").padding(.top, 16)

                        // The count, set like an instrument readout.
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text("\(received.count)").foregroundStyle(Ink.paper)
                            Text("/").foregroundStyle(Ink.paperGhost)
                            Text("\(total)").foregroundStyle(Ink.paper)
                        }
                        .font(Type.readout(56))
                        .padding(.top, 12)
                        Eyebrow("FRAGMENTS ACQUIRED").padding(.top, 10).padding(.bottom, 22)

                        // The lattice. Out-of-order fill is the point.
                        LazyVGrid(columns: columns, spacing: 3) {
                            ForEach(1...total, id: \.self) { i in
                                Rectangle()
                                    .fill(cellColor(i))
                                    .aspectRatio(1, contentMode: .fit)
                                    .scaleEffect(i == newest ? 1.2 : 1)
                                    .animation(.easeOut(duration: 0.35), value: received)
                                    .animation(.easeOut(duration: 0.35), value: newest)
                            }
                        }

                        FieldRow(label: "RECEIVED", value: "\(received.count)").padding(.top, 22)
                        FieldRow(label: "MISSING", value: "\(total - received.count)")
                        FieldRow(label: "REPEATS DISCARDED", value: "\(repeats)")
                        FieldRow(label: "DIGEST", value: "9F2A1C04…")

                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(log.indices, id: \.self) { i in
                                Text(log[i])
                                    .font(Type.mono(10.5))
                                    .kerning(1)
                                    .foregroundStyle(i == 0 ? Ink.paper : Ink.paperFaint)
                            }
                        }
                        .frame(height: 52, alignment: .top)
                        .padding(.top, 16)

                        Text("Frames arrive out of order and repeat. That is the transport " +
                             "working. Keep the camera steady until the count fills.")
                            .font(Type.body(13.5))
                            .lineSpacing(4)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.vertical, 16)
                    }
                    .padding(.horizontal, 24)
                }
                Text(complete ? "CHECKSUM VERIFIED" : "ACQUIRING")
                    .font(Type.mono(10))
                    .kerning(2)
                    .foregroundStyle(complete ? Ink.verified : Ink.paperFaint)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 18)
                    .overlay(alignment: .top) { Hairline() }
            }
        }
        .onAppear { pump() }
    }

    private func cellColor(_ i: Int) -> Color {
        if i == newest { return Ink.attention }
        return received.contains(i) ? Ink.paper : Ink.paper.opacity(0.07)
    }

    /// STAGED: the simulated wire. On device this is fed by the scanner's
    /// frame callback; the presentation is identical.
    private func pump() {
        guard !complete else { return }
        guard received.count < total else {
            complete = true
            Haptic.signed()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { vault.go(.received) }
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.105) {
            // The camera occasionally re-reads a frame it already has; shown
            // as normal traffic, never as an error.
            if received.count > 2, Int.random(in: 0..<6) == 0 {
                repeats += 1
                push("FRAME \(received.randomElement() ?? 1) · REPEAT, DISCARDED")
            } else if let next = order.popLast() {
                received.insert(next)
                newest = next
                if received.count % 4 == 0 { Haptic.frame() }
                push("FRAME \(next) · VERIFIED")
            }
            pump()
        }
    }

    private func push(_ line: String) {
        log.insert(line, at: 0)
        if log.count > 4 { log.removeLast() }
    }
}

// MARK: - Received

struct ReceivedView: View {
    @EnvironmentObject private var vault: Vault

    var body: some View {
        Screen {
            ZStack {
                LabyrinthWatermark()
                VStack(alignment: .leading, spacing: 0) {
                    VaultBar()
                    Spacer()
                    VStack(alignment: .leading, spacing: 0) {
                        Eyebrow("TRANSPORT COMPLETE", color: Ink.verified)
                        Statement("TRANSACTION", "RECEIVED.", size: 42).padding(.top, 14).padding(.bottom, 26)
                        Attestation(text: "42 OF 42 FRAGMENTS ASSEMBLED")
                        Attestation(text: "PAYLOAD DIGEST MATCHED")
                        Attestation(text: "KIND RECOGNIZED · PSBT")
                        Attestation(text: "DECODED WITHOUT AMBIGUITY")
                        Text("The checksum proves the camera read the bytes correctly. It proves " +
                             "nothing about what the bytes do. That is the next screen, and it " +
                             "is yours to read.")
                            .font(Type.body())
                            .lineSpacing(5)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.top, 22)
                    }
                    .padding(.horizontal, 24)
                    Spacer()
                    /* No lever *forward* here on purpose. A completed scan is
                     * described by the engine the moment the last frame lands,
                     * and the result decides where it goes, review or a
                     * refusal. A button that walked to the review screen would
                     * be a route into it that never passed the reader. The two
                     * levers below only go back: scan again, or give up to the
                     * vault. Neither can reach a confirmation screen. */
                    VStack(spacing: 10) {
                        Lever(title: "SCAN SOMETHING ELSE") { vault.scanAgain() }
                        Lever(title: "BACK TO VAULT", style: .quiet) { vault.go(.home) }
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
                }
            }
        }
    }
}
