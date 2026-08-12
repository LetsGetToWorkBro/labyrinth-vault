//  Review.swift
//  The confirmation screen. The rest of the product exists so that this
//  screen can exist; see src/keys/psbt.ts for the reader it fronts.
//
//  Three design decisions carry the security:
//
//  1. The scroll gate. STOP / VERIFY / SIGN across the top are not a progress
//     bar with labels — the route to approval does not open until the whole
//     document has physically passed the reader's eyes, because a person who
//     looked is the only defense this product has.
//
//  2. The destination zone. The destination is the one thing an attacker must
//     change to steal, so it is the one thing given a zone of its own:
//     full-width, full-string, never truncated, never behind a disclosure. A
//     transaction can pay several people, and every one of them gets its own
//     zone rather than a summary, because a summary is where the payee nobody
//     approved goes to hide.
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
    private var unit: String { tx.asset.rawValue }

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                gate
                GeometryReader { viewport in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            header
                            sending
                            destinations
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

    /// The amount leaving to other people. `leaving` is the sum paid to every
    /// payee, which is the number this screen is about; the fee sits in its own
    /// section and the change comes back, so neither belongs in this figure.
    private var sending: some View {
        VStack(alignment: .leading, spacing: 0) {
            Hairline(weight: 2, color: Ink.ruleHeavy)
            Eyebrow(tx.paysSeveral ? "SENDING TO \(tx.payees.count) RECIPIENTS" : "SENDING")
                .padding(.top, 28)
            Text(tx.leaving)
                .font(Type.readout(58))
                .foregroundStyle(Ink.paper)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
                .padding(.top, 14)
            Text(unit)
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

    /// One destination zone per payee. A single-payee spend reads exactly as it
    /// did before; a multi-payee one lists every recipient rather than folding
    /// them into a count, because the recipient that is not shown is the one
    /// that gets stolen to.
    @ViewBuilder private var destinations: some View {
        let payees = tx.payees
        if payees.isEmpty {
            // A spend with no external output: everything returns to the wallet
            // (a consolidation or a self-send). Say so plainly.
            VStack(alignment: .leading, spacing: 8) {
                Hairline(weight: 2, color: Ink.ruleHeavy)
                Eyebrow("NO EXTERNAL RECIPIENT").padding(.top, 24)
                Text("Every output of this transaction returns to your own wallet. " +
                     "Nothing leaves to anyone else.")
                    .font(Type.body(13.5))
                    .lineSpacing(4)
                    .foregroundStyle(Ink.paperDim)
                    .padding(.top, 8)
                    .padding(.bottom, 26)
            }
        } else {
            ForEach(payees.indices, id: \.self) { i in
                DestinationZone(
                    payee: payees[i],
                    unit: unit,
                    label: payees.count > 1 ? "RECIPIENT \(i + 1)" : "DESTINATION"
                ) {
                    vault.go(.destination(tx, payees[i]))
                }
            }
        }
    }

    private var feeSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow("FEE").padding(.top, 32)
            amountLine(tx.fee ?? "0", unit: unit)
            FieldRow(label: "SHARE OF AMOUNT", value: tx.feeShare ?? "N/A").padding(.top, 12)
            FieldRow(label: "RATE", value: tx.feeRate ?? "N/A")
            FieldRow(label: "VIRTUAL SIZE", value: tx.vsize)
            FieldRow(label: "INPUT VALUES", value: "ALL KNOWN", tone: .verified)
            Text("The fee is not written in a transaction. It is what is left over. The " +
                 "vault can only state it because every input value was supplied and checked. " +
                 "Had one been missing, this screen would not exist.")
                .font(Type.body(13.5))
                .lineSpacing(4)
                .foregroundStyle(Ink.paperDim)
                .padding(.top, 14)
        }
    }

    /// Change can be more than one output too. List each: the amount, the
    /// address the vault re-derived, and where it derived it from.
    @ViewBuilder private var changeSection: some View {
        let change = tx.change
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow(change.count > 1 ? "CHANGE RETURNING TO YOU (\(change.count))"
                                     : "CHANGE RETURNING TO YOU").padding(.top, 32)
            if change.isEmpty {
                Text("None. The entire input value leaves as payment and fee, with " +
                     "nothing returning to this wallet.")
                    .font(Type.body(13.5))
                    .lineSpacing(4)
                    .foregroundStyle(Ink.paperDim)
                    .padding(.top, 12)
            } else {
                ForEach(change.indices, id: \.self) { i in
                    let out = change[i]
                    amountLine(out.amount, unit: unit)
                    Text(out.address ?? "(no readable address)")
                        .font(Type.mono(12.5))
                        .kerning(0.4)
                        .lineSpacing(5)
                        .foregroundStyle(Ink.paperDim)
                        .padding(.top, 12)
                    FieldRow(label: "DERIVED AT", value: out.path ?? "UNKNOWN").padding(.top, 10)
                    FieldRow(label: "SCRIPT RE-DERIVED HERE", value: "MATCHES", tone: .verified)
                    if i < change.count - 1 {
                        Hairline().padding(.vertical, 16)
                    }
                }
                Text("The transaction claims these outputs are yours. The vault ignored that " +
                     "claim and rebuilt each address from its own key. They agree, so they are yours.")
                    .font(Type.body(13.5))
                    .lineSpacing(4)
                    .foregroundStyle(Ink.paperDim)
                    .padding(.top, 14)
            }
        }
    }

    private var structureSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow("STRUCTURE").padding(.top, 32).padding(.bottom, 8)
            FieldRow(label: "INPUTS", value: "\(tx.inputs.count)")
            FieldRow(label: "OUTPUTS", value: "\(tx.outputs.count)")
            FieldRow(label: "TOTAL IN", value: "\(tx.spending) \(unit)")
            FieldRow(label: "RETURNING TO YOU", value: "\(tx.returning) \(unit)")
        }
    }

    private var checksSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow("WHAT THE VAULT CHECKED").padding(.top, 32).padding(.bottom, 8)
            Attestation(text: "CHANGE OUTPUTS IDENTIFIED BY OWN DERIVATION")
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
/// One payee per zone; the amount going to it sits under the address.
struct DestinationZone: View {
    let payee: TxOutput
    let unit: String
    var label: String = "DESTINATION"
    var onInspect: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            AddressText(address: payee.address ?? "(no readable address)")
                .foregroundStyle(Ink.paper)
                .padding(.top, 30)
            Hairline().padding(.top, 22).padding(.bottom, 16)
            HStack {
                Eyebrow("AMOUNT")
                Spacer()
                Text("\(payee.amount) \(unit)")
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
            Eyebrow(label, color: Ink.paper)
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
    let output: TxOutput

    /// The address being inspected, or an empty string when the output has
    /// none. A payee with no readable address is fatal upstream; here it just
    /// means nothing to chunk.
    private var address: String { output.address ?? "" }

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
                            Text(address)
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
        stride(from: 0, to: address.count, by: 4).map { i in
            let s = address.index(address.startIndex, offsetBy: i)
            let e = address.index(s, offsetBy: min(4, address.count - i))
            return String(address[s..<e])
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

    /// A one-line answer to "to whom": the single payee's tail, or a count when
    /// there is more than one and no single tail can stand for all of them.
    private var toLine: String {
        let payees = tx.payees
        if payees.count == 1, let address = payees[0].address {
            return "…" + address.suffix(10)
        }
        if payees.isEmpty { return "SELF" }
        return "\(payees.count) RECIPIENTS"
    }

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

                        FieldRow(label: "AMOUNT", value: "\(tx.leaving) \(tx.asset.rawValue)").padding(.top, 22)
                        FieldRow(label: "TO", value: toLine)
                        FieldRow(label: "FEE", value: "\(tx.fee ?? "0") \(tx.asset.rawValue)")
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
