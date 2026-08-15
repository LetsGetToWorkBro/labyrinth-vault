//  KeyImages.swift
//  Answering the companion's Monero bookkeeping, and saying what was refused.
//
//  The companion scanned the chain with the view key and found this account's
//  payments. What it cannot see is which of them have been spent, because
//  spends are named by key images and computing one takes the spend secret,
//  which lives here and is not leaving. So the companion asked, the engine
//  re-proved every output belongs to this wallet before touching the spend
//  key, and this screen shows the answer going back the only way anything
//  leaves this device: as light.
//
//  The refused count is on the screen rather than in a log. An output the
//  engine would not answer for means the companion's scan and this vault's
//  keys disagree about something, and the person holding both devices is the
//  only one who can decide whether that is a stale request or a problem.
//
//  ## Two wires, because the answer has two audiences
//
//  `LABYRINTH` is this project's own format, which the companion reads and
//  nothing else does.
//
//  `MONERO FILE` is `Monero key image export`, byte for byte as
//  `wallet2::export_key_images` writes it, which Cake, Feather and
//  `monero-wallet-cli` all import. The vault has been able to write that file
//  since CryptoNight was vendored and nothing could ask it to: the writer was
//  built, checked against bytes Monero's own crypto produced, and reachable
//  from no screen. This picker is what makes thirty-four files of vendored C
//  something a person can use.
//
//  The second wire is offered only when the engine says it can be written.
//  `fileRandomBytes` is nil on a build with no CryptoNight, and a button that
//  can only answer "this build cannot do that" is chrome pretending to be a
//  feature — the same rule the stand-in vault controls follow.
//
//  ## Why the file wire can refuse after being offered
//
//  `import_key_images` pairs records with transfers *by position*. A file
//  missing one record pairs everything after the gap with the wrong output, so
//  the engine refuses to write one at all when any output failed to prove.
//  That is knowable only after the attempt, so the button exists and its
//  refusal is a sentence rather than a disabled control with no explanation.

import SwiftUI

struct KeyImagesView: View {
    let result: Engine.KeyImagesReply
    @EnvironmentObject private var vault: Vault

    /// Which wire is on the glass. Starts on this project's own, because the
    /// companion that just asked is the likeliest reader.
    @State private var wire: Wire = .labyrinth
    /// The file wire's frames, once drawn. Nil until asked for, because
    /// writing the file costs a CryptoNight pass and fresh randomness.
    @State private var file: Engine.KeyImageFileReply?
    @State private var fileProblem: String?

    enum Wire: String, CaseIterable {
        case labyrinth = "LABYRINTH"
        case moneroFile = "MONERO FILE"
    }

    /// Whether the engine says the second wire can be written at all.
    private var fileOffered: Bool { result.fileRandomBytes != nil }

    private var frames: [String] {
        switch wire {
        case .labyrinth: result.frames
        case .moneroFile: file?.frames ?? []
        }
    }

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                VaultBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Eyebrow("MONERO BOOKKEEPING").padding(.top, 12)
                        Statement("SHOW THIS TO YOUR", "COMPANION DEVICE", size: 30)
                            .padding(.top, 10)
                            .padding(.bottom, 20)

                        if fileOffered { picker }

                        if frames.isEmpty {
                            emptyWire
                        } else {
                            QRAperture(frames: frames, interval: 0.7)
                        }

                        FieldRow(label: "KIND", value: wire == .labyrinth ? "XMRKEYIMAGES" : "XMRFILE")
                            .padding(.top, 18)
                        FieldRow(label: "ANSWERED", value: "\(result.answered)")
                        FieldRow(label: "REFUSED", value: "\(result.refused)",
                                 tone: result.refused > 0 ? .attention : .plain)
                        if wire == .moneroFile, let file {
                            FieldRow(label: "TRANSFER OFFSET", value: "\(file.offset)")
                        }

                        if result.refused > 0 { refusedNote }

                        Text(explanation)
                            .font(Type.body(13))
                            .lineSpacing(4)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.top, 22)
                            .padding(.bottom, 24)
                    }
                    .padding(.horizontal, 24)
                }
                Lever(title: "DONE", hint: "RETURN TO VAULT", style: .quiet) { vault.go(.home) }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
            }
        }
    }

    // MARK: - The picker

    private var picker: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                ForEach(Wire.allCases, id: \.self) { one in
                    Button {
                        Haptic.tick()
                        wire = one
                        if one == .moneroFile { writeFile() }
                    } label: {
                        Text(one.rawValue)
                            .font(Type.mono(10))
                            .kerning(1.4)
                            .foregroundStyle(one == wire ? Ink.void : Ink.paperDim)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(one == wire ? Ink.paper : Color.clear)
                            .overlay { Rectangle().strokeBorder(Ink.ruleStrong, lineWidth: 1) }
                    }
                    .buttonStyle(.plain)
                }
            }
            Text(wire == .labyrinth
                 ? "The Labyrinth wallet reads this one."
                 : "Cake, Feather and monero-wallet-cli import this one.")
                .font(Type.body(12.5))
                .foregroundStyle(Ink.paperFaint)
                .padding(.top, 10)
                .padding(.bottom, 18)
        }
    }

    /// Draw the file. Fresh randomness in exactly the amount the engine asked
    /// for, drawn here at the call site the way `moneroSign`'s is: the engine
    /// owns the formula and the platform CSPRNG owns the bytes.
    private func writeFile() {
        guard file == nil, fileProblem == nil else { return }
        let outcome = vault.moneroKeyImageFile()
        switch outcome {
        case .success(let reply):
            file = reply
            Haptic.tick()
        case .failure(let sentence):
            fileProblem = sentence
            Haptic.refuse()
        }
    }

    // MARK: - The states that are not a code

    @ViewBuilder private var emptyWire: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(fileProblem == nil ? "WRITING THE FILE…" : "NO FILE WAS WRITTEN")
                .font(.system(size: 14, weight: .medium))
                .kerning(0.3)
                .foregroundStyle(Ink.paper)
            if let fileProblem {
                Text(fileProblem)
                    .font(Type.body(13))
                    .lineSpacing(4)
                    .foregroundStyle(Ink.paperDim)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay { Rectangle().strokeBorder(Ink.ruleStrong, lineWidth: 1) }
    }

    private var refusedNote: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(result.refused) OUTPUTS DID NOT PROVE AS THIS WALLET'S.")
                .font(.system(size: 14, weight: .medium))
                .kerning(0.3)
                .foregroundStyle(Ink.paper)
            Text("This vault re-derives every requested output from its own keys " +
                 "before computing anything, and those did not derive. A stale " +
                 "request from a different pairing looks like this; so does a " +
                 "tampered one. The refused outputs got no answer.")
                .font(Type.body(13))
                .lineSpacing(4)
                .foregroundStyle(Ink.paperDim)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay { Rectangle().strokeBorder(Ink.ruleStrong, lineWidth: 1) }
        .padding(.top, 22)
    }

    private var explanation: String {
        switch wire {
        case .labyrinth:
            "A key image lets your companion see when an output it found has " +
            "been spent, which is what turns a received total into a balance. " +
            "It reveals nothing to the network that the network did not " +
            "already publish."
        case .moneroFile:
            "This is the file monero-wallet-cli calls a key image export, and it is " +
            "the same answer in the format other wallets read. Your companion has to " +
            "catch these codes and save the file, because Cake and Feather import a " +
            "file and cannot read a code.\n\n" +
            "The wallet that imports it pairs each record with one of its own outputs " +
            "by position, so the list has to be in that wallet's order, starting at the " +
            "transfer offset above. Get it wrong and the import refuses: every record " +
            "carries a signature over the output it belongs to, so a mismatch fails " +
            "loudly rather than quietly reporting a wrong balance."
        }
    }
}
