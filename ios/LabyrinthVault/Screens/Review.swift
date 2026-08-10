//  Review.swift
//  The confirmation screen. The rest of the product exists so that this
//  screen can exist; see src/keys/psbt.ts for the reader it fronts.
//
//  Three design decisions carry the security:
//
//  1. The scroll gate. STOP / VERIFY / SIGN across the top are not a progress
//     bar with labels — the route to approval does not open until the whole
//     document has physically passed the reader's eyes, because a person who
//     looked is the only defence this product has.
//
//  2. The destination zone. The destination is the one thing an attacker must
//     change to steal, so it is the one thing given a zone of its own:
//     full-width, full-string, never truncated, never behind a disclosure.
//
//  3. The digest. What continues to approval is the summary plus its digest,
//     so the thing that gets signed is provably the thing that was read.

import SwiftUI

struct ReviewView: View {
    @EnvironmentObject private var vault: Vault
    let tx: TxSummary

    @State private var progress: CGFloat = 0
    @State private var armed = false

    private var stage: Int { progress >= 0.985 ? 2 : progress > 0.05 ? 1 : 0 }

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                gate
                GeometryReader { viewport in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            header
                            sending
                            DestinationZone(tx: tx) { vault.go(.destination(tx)) }
                            feeSection
                            changeSection
                            structureSection
                            checksSection

                            Text("The vault has checked everything a machine can check. It cannot " +
                                 "check whether this is the person you meant to pay. Only you can do " +
                                 "that, and only by reading the destination above.")
                                .font(Type.body())
                                .lineSpacing(5)
                                .foregroundStyle(Ink.paper)
                                .padding(.top, 28)
                                .padding(.bottom, 40)
                        }
                        .padding(.horizontal, 24)
                        .scrollProgress($progress, viewport: viewport.size.height)
                    }
                    .coordinateSpace(name: "reviewScroll")
                }

                Lever(title: "I HAVE READ THIS",
                      hint: armed ? "CONTINUE" : "SCROLL",
                      enabled: armed) {
                    vault.go(.approve(tx, reviewedDigest: tx.digest))
                }
                .padding(.horizontal, 24)
                .padding(.top, 12)
                .padding(.bottom, 12)
                .overlay(alignment: .top) { Hairline() }
            }
        }
        .onChange(of: stage) {
            if stage == 2 && !armed {
                armed = true
                Haptic.verify()
            }
        }
    }

    // MARK: pieces

    private var gate: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            gateWord("STOP", index: 0)
            slash; gateWord("VERIFY", index: 1)
            slash; gateWord("SIGN", index: 2)
            Spacer()
            Text("\(Int(progress * 100))%")
                .font(Type.mono(10))
                .foregroundStyle(Ink.paperFaint)
        }
        .padding(.horizontal, 24)
        .padding(.top, 16)
        .padding(.bottom, 12)
        .overlay(alignment: .bottom) { Hairline() }
    }

    private var slash: some View {
        Text("/").font(.system(size: 10)).foregroundStyle(Ink.paperGhost)
    }

    private func gateWord(_ word: String, index: Int) -> some View {
        Text(word)
            .font(.system(size: 13, weight: .semibold))
            .kerning(1.8)
            .foregroundStyle(index == stage ? Ink.attention
                             : index < stage ? Ink.paper : Ink.paperGhost)
            .animation(.easeOut(duration: 0.4), value: stage)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 16) {
            Statement("READ BEFORE", "SIGNING", size: 34)
            Text("This came from a device the vault does not trust. Everything below was " +
                 "decoded here, on this phone, from the bytes themselves.")
                .font(Type.body())
                .lineSpacing(5)
                .foregroundStyle(Ink.paperDim)
        }
        .padding(.top, 28)
        .padding(.bottom, 26)
    }

    private var sending: some View {
        VStack(alignment: .leading, spacing: 0) {
            Hairline(weight: 2, color: Ink.ruleHeavy)
            Eyebrow("SENDING").padding(.top, 28)
            Text(tx.sendAmount)
                .font(Type.readout(58))
                .foregroundStyle(Ink.paper)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
                .padding(.top, 14)
            Text(tx.asset.rawValue)
                .font(.system(size: 20, weight: .semibold))
                .kerning(2)
                .foregroundStyle(tx.asset.color)
                .padding(.top, 10)
            // No fiat figure: the vault has no network, so it cannot know a
            // rate, and a number it cannot verify has no business sitting
            // beside one it can. Say so rather than leave a suspicious gap.
            Text("NO PRICE SHOWN · THIS DEVICE\nHAS NO NETWORK TO ASK")
                .font(Type.mono(9))
                .kerning(1.6)
                .lineSpacing(4)
                .foregroundStyle(Ink.paperFaint)
                .padding(.top, 14)
                .padding(.bottom, 30)
        }
    }

    private var feeSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow("FEE").padding(.top, 32)
            amountLine(tx.fee, unit: tx.asset.rawValue)
            FieldRow(label: "SHARE OF AMOUNT", value: tx.feeShare).padding(.top, 12)
            FieldRow(label: "RATE", value: tx.feeRate)
            FieldRow(label: "VIRTUAL SIZE", value: tx.vsize)
            FieldRow(label: "INPUT VALUES", value: "ALL KNOWN", tone: .verified)
            Text("The fee is not written in a transaction — it is what is left over. The " +
                 "vault can only state it because every input value was supplied and checked. " +
                 "Had one been missing, this screen would not exist.")
                .font(Type.body(13.5))
                .lineSpacing(4)
                .foregroundStyle(Ink.paperDim)
                .padding(.top, 14)
        }
    }

    private var changeSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow("CHANGE RETURNING TO YOU").padding(.top, 32)
            amountLine(tx.change, unit: tx.asset.rawValue)
            Text(tx.changeAddress)
                .font(Type.mono(12.5))
                .kerning(0.4)
                .lineSpacing(5)
                .foregroundStyle(Ink.paperDim)
                .padding(.top, 12)
            FieldRow(label: "DERIVED AT", value: tx.changePath).padding(.top, 10)
            FieldRow(label: "SCRIPT RE-DERIVED HERE", value: "MATCHES", tone: .verified)
            Text("The transaction claims this output is yours. The vault ignored that claim " +
                 "and rebuilt the address from its own key. The two agree, so it is yours.")
                .font(Type.body(13.5))
                .lineSpacing(4)
                .foregroundStyle(Ink.paperDim)
                .padding(.top, 14)
        }
    }

    private var structureSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow("STRUCTURE").padding(.top, 32).padding(.bottom, 8)
            FieldRow(label: "INPUTS", value: "\(tx.inputs)")
            FieldRow(label: "OUTPUTS", value: "\(tx.outputs)")
            FieldRow(label: "TOTAL IN", value: "\(tx.totalIn) \(tx.asset.rawValue)")
            FieldRow(label: "LOCKTIME", value: "NONE")
            FieldRow(label: "RBF SIGNALLED", value: tx.rbf ? "YES" : "NO")
        }
    }

    private var checksSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow("WHAT THE VAULT CHECKED").padding(.top, 32).padding(.bottom, 8)
            Attestation(text: "CHANGE OUTPUT IDENTIFIED BY OWN DERIVATION")
            Attestation(text: "EVERY INPUT VALUE KNOWN")
            Attestation(text: "FEE CALCULATED, NOT ASSERTED")
            Attestation(text: "TRANSACTION DIGEST MATCHED")
        }
    }

    private func amountLine(_ value: String, unit: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(value).font(Type.readout(34)).foregroundStyle(Ink.paper)
            Text(unit).font(Type.mono(15)).foregroundStyle(Ink.paperFaint)
        }
        .padding(.top, 12)
    }
}

// MARK: - Destination zone

/// The human verification zone: heavier top rule, its own surface, the tag
/// breaking the rule, and the address at inspection size with weighted ends.
struct DestinationZone: View {
    let tx: TxSummary
    var onInspect: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            AddressText(address: tx.destination)
                .foregroundStyle(Ink.paper)
                .padding(.top, 30)
            Hairline().padding(.top, 22).padding(.bottom, 16)
            HStack {
                Eyebrow("TYPE")
                Spacer()
                Text(tx.destinationType)
                    .font(Type.mono(12))
                    .foregroundStyle(Ink.paperDim)
            }
            Button {
                Haptic.tick()
                onInspect()
            } label: {
                HStack {
                    Text("COMPARE CHARACTER BY CHARACTER")
                        .font(.system(size: 12.5, weight: .medium))
                        .kerning(0.6)
                    Spacer()
                    Text("OPEN")
                        .font(Type.mono(9))
                        .kerning(1.4)
                        .opacity(0.55)
                }
                .foregroundStyle(Ink.paperDim)
                .padding(.horizontal, 16)
                .frame(height: 50)
                .overlay { Rectangle().strokeBorder(Ink.rule, lineWidth: 1) }
            }
            .buttonStyle(.plain)
            .padding(.top, 18)
            .padding(.bottom, 26)
        }
        .padding(.horizontal, 24)
        .background(Ink.surface)
        .overlay(alignment: .top) { Hairline(weight: 2, color: Ink.ruleHeavy) }
        .overlay(alignment: .topLeading) {
            Eyebrow("DESTINATION", color: Ink.paper)
                .padding(.trailing, 8)
                .background(Ink.void)
                .offset(x: 24, y: -6)
        }
        .padding(.horizontal, -24)   // full-bleed inside the padded column
        .padding(.top, 4)
    }
}

// MARK: - Destination inspector

struct DestinationView: View {
    @EnvironmentObject private var vault: Vault
    let tx: TxSummary

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                HStack {
                    Eyebrow("DESTINATION", color: Ink.paper)
                    Spacer()
                    Button { vault.go(.review(tx)) } label: {
                        Text("CLOSE").font(Type.mono(10)).kerning(1.6).foregroundStyle(Ink.paperFaint)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 16)
                .overlay(alignment: .bottom) { Hairline() }

                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Read it against the address on your companion. A substitution " +
                             "attack changes the middle and keeps the ends familiar, so read " +
                             "the middle.")
                            .font(Type.body())
                            .lineSpacing(5)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.vertical, 22)

                        ForEach(chunks.indices, id: \.self) { i in
                            VStack(spacing: 0) {
                                HStack {
                                    Text(String(format: "%02d", i * 4))
                                        .font(Type.mono(10))
                                        .foregroundStyle(Ink.paperFaint)
                                    Spacer()
                                    Text(chunks[i])
                                        .font(Type.mono(22))
                                        .kerning(5)
                                        .foregroundStyle(Ink.paper)
                                }
                                .padding(.vertical, 12)
                                Hairline()
                            }
                        }

                        VStack(alignment: .leading, spacing: 10) {
                            Eyebrow("FULL STRING")
                            Text(tx.destination)
                                .font(Type.mono(12.5))
                                .lineSpacing(5)
                                .foregroundStyle(Ink.paper)
                        }
                        .padding(18)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay { Rectangle().strokeBorder(Ink.rule, lineWidth: 1) }
                        .padding(.top, 24)
                        .padding(.bottom, 28)
                    }
                    .padding(.horizontal, 24)
                }

                Lever(title: "BACK TO TRANSACTION") { vault.go(.review(tx)) }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
            }
        }
    }

    private var chunks: [String] {
        stride(from: 0, to: tx.destination.count, by: 4).map { i in
            let s = tx.destination.index(tx.destination.startIndex, offsetBy: i)
            let e = tx.destination.index(s, offsetBy: min(4, tx.destination.count - i))
            return String(tx.destination[s..<e])
        }
    }
}

// MARK: - Approval

struct ApproveView: View {
    @EnvironmentObject private var vault: Vault
    let tx: TxSummary
    let reviewedDigest: String

    @State private var attested: Set<String> = []
    private let required = ["THE DESTINATION", "THE AMOUNT", "THE FEE", "THE CHANGE"]

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                VaultBar(airgap: .hidden)
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Eyebrow("TRANSACTION VERIFIED", color: Ink.verified).padding(.top, 16)
                        Statement("I HAVE", "VERIFIED", size: 36).padding(.top, 12).padding(.bottom, 22)

                        ForEach(required, id: \.self) { line in
                            attestRow(line)
                        }

                        FieldRow(label: "AMOUNT", value: "\(tx.sendAmount) \(tx.asset.rawValue)").padding(.top, 22)
                        FieldRow(label: "TO", value: "…" + tx.destination.suffix(10))
                        FieldRow(label: "FEE", value: "\(tx.fee) \(tx.asset.rawValue)")
                        FieldRow(label: "SUMMARY DIGEST", value: reviewedDigest)

                        Text("The signature will be taken over these bytes and no others. If " +
                             "anything below this screen differs from what you just read, " +
                             "signing fails rather than proceeds.")
                            .font(Type.body(13.5))
                            .lineSpacing(4)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.top, 18)
                            .padding(.bottom, 24)
                    }
                    .padding(.horizontal, 24)
                }

                HoldToSign(enabled: attested.count == required.count) {
                    vault.completeSigning(tx, reviewedDigest: reviewedDigest)
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 12)
            }
        }
    }

    private func attestRow(_ line: String) -> some View {
        Button {
            guard !attested.contains(line) else { return }
            Haptic.verify()
            withAnimation(.easeOut(duration: 0.2)) { _ = attested.insert(line) }
        } label: {
            Attestation(text: line, state: attested.contains(line) ? .passed : .pending)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Scroll progress plumbing

/// Reports how much of a ScrollView's content has passed the viewport as
/// 0...1. Preference-key based, so it works on iOS 17.
private struct ScrollProgressKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

extension View {
    /// Attach to a ScrollView's content; the ScrollView itself must carry
    /// `.coordinateSpace(name: "reviewScroll")` and pass its own height.
    func scrollProgress(_ binding: Binding<CGFloat>, viewport: CGFloat) -> some View {
        background {
            GeometryReader { inner in
                Color.clear.preference(
                    key: ScrollProgressKey.self,
                    // minY runs 0 -> -(contentHeight - viewport) as you scroll.
                    value: {
                        let total = inner.size.height - viewport
                        guard total > 0 else { return 1 }
                        return min(1, max(0, -inner.frame(in: .named("reviewScroll")).minY / total))
                    }())
            }
        }
        .onPreferenceChange(ScrollProgressKey.self) { binding.wrappedValue = $0 }
    }
}
