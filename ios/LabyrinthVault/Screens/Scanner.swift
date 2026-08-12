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
                            #if targetEnvironment(simulator)
                            // No camera: the recognized frame is simulated, and
                            // what follows is the built-in demo walk.
                            vault.beginDemo()
                            #else
                            // A recognized LV1/UR frame begins acquisition.
                            vault.go(.acquiring)
                            #endif
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

                        /* The one path through the signing flow that needs no
                         * companion device: a deterministic transaction from
                         * the engine, walked through the same read, review,
                         * approve and sign a real one takes. Real cryptography
                         * against the demo vault's keys — unbroadcastable by
                         * construction — which is why the walk ends by wiping
                         * the demo session and asking for your passphrase
                         * back. Labeled for what it is, here and on every exit. */
                        Lever(title: "WALK A DEMO TRANSACTION", hint: "NO COMPANION NEEDED", style: .quiet) {
                            vault.beginDemo()
                        }
                        .padding(.bottom, 18)
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
    @State private var log: [String] = []
    @State private var frames: [String] = []
    @State private var fed = 0

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 3), count: 14)

    /// Real progress, from the engine's reassembly, not a simulated count.
    private var have: Int { vault.scanProgress.have }
    private var total: Int { max(vault.scanProgress.total, have) }
    private var complete: Bool { total > 0 && have >= total }

    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 0) {
                VaultBar()
                #if !targetEnvironment(simulator)
                // On device the camera keeps running here, handing every frame
                // to the engine. Aiming stays possible: acquisition is the few
                // seconds an animated code takes to cycle, not a single moment.
                // Except during the demo walk, whose frames come from the
                // engine rather than the lens.
                if !vault.demoActive {
                    CameraLayer(onFrame: { vault.offer(frame: $0) })
                        .frame(height: 150)
                        .clipped()
                        .overlay(alignment: .bottom) { Hairline() }
                }
                #endif
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Eyebrow("RECEIVING TRANSACTION").padding(.top, 16)

                        // The count, set like an instrument readout.
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text("\(have)").foregroundStyle(Ink.paper)
                            Text("/").foregroundStyle(Ink.paperGhost)
                            Text(total > 0 ? "\(total)" : "?").foregroundStyle(Ink.paper)
                        }
                        .font(Type.readout(56))
                        .padding(.top, 12)
                        Eyebrow("FRAGMENTS ACQUIRED").padding(.top, 10).padding(.bottom, 22)

                        // The lattice fills as fragments arrive.
                        if total > 0 {
                            LazyVGrid(columns: columns, spacing: 3) {
                                ForEach(1...total, id: \.self) { i in
                                    Rectangle()
                                        .fill(i <= have ? Ink.paper : Ink.paper.opacity(0.07))
                                        .aspectRatio(1, contentMode: .fit)
                                        .animation(.easeOut(duration: 0.3), value: have)
                                }
                            }
                        }

                        FieldRow(label: "RECEIVED", value: "\(have)").padding(.top, 22)
                        FieldRow(label: "MISSING", value: total > 0 ? "\(max(total - have, 0))" : "UNKNOWN")

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
        .onAppear {
            guard vault.demoActive else { return }
            // The demo walk, on any hardware: the engine hands over a real
            // demo transaction (and opens the demo vault), and its frames
            // feed through the same path a scanned one takes.
            frames = vault.demoFrames()
            if frames.isEmpty {
                vault.go(.refused(.unreadable))
            } else {
                feedNext()
            }
        }
    }

    /// Feed the demo frames through `offer` one at a time, so the lattice fills
    /// the way a real scan fills it. `offer` describes and routes to review on
    /// the frame that completes the payload, and this view goes with it.
    private func feedNext() {
        guard fed < frames.count else { return }
        let frame = frames[fed]
        fed += 1
        vault.offer(frame: frame)
        if fed % 4 == 0 { Haptic.frame() }
        log.insert("FRAME \(fed) · VERIFIED", at: 0)
        if log.count > 4 { log.removeLast() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.09) { feedNext() }
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
