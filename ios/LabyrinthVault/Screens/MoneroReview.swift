//  MoneroReview.swift
//  The Monero confirmation flow: the same architecture as Review.swift —
//  read, verify, attest, hold — with the claims changed to what a Monero
//  transaction set actually supports.
//
//  The differences are facts, not styling. The fee is stated in the set
//  rather than left over, and the balance it claims is closed on the curve at
//  signing, so the screen says "stated and checked" instead of "calculated".
//  An output marked as change has already been checked by the engine against
//  this vault's own address — a mismatch refused before this screen could
//  exist. And the ring is listed under PRIVACY, not among the safety checks,
//  because decoy choice can harm anonymity but cannot move money.
//
//  Everything here renders `MoneroSummary`, which is real engine output from
//  `moneroDescribe`, and signing calls `moneroSign` with the digest of what
//  was on screen. No fixtures, no stand-ins: the screens the send-path doc
//  called "what is not built" are these.

import SwiftUI

// MARK: - Review

struct XmrReviewView: View {
    @EnvironmentObject private var vault: Vault
    let tx: MoneroSummary

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
                            destinations
                            feeSection
                            changeSection
                            privacySection
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
                    vault.go(.xmrApprove(tx, reviewedDigest: tx.digest))
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
                 "decoded here, on this phone, from the set itself.")
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
            Eyebrow(tx.paid.count > 1 ? "SENDING TO \(tx.paid.count) RECIPIENTS" : "SENDING")
                .padding(.top, 28)
            // Twelve decimals need more room than eight: a slightly smaller
            // readout, the same instrument treatment, one unbroken line.
            Text(tx.payingFormatted)
                .font(Type.readout(46))
                .foregroundStyle(Ink.paper)
                .minimumScaleFactor(0.55)
                .lineLimit(1)
                .padding(.top, 14)
            Text("XMR")
                .font(.system(size: 20, weight: .semibold))
                .kerning(2)
                .foregroundStyle(Ink.xmr)
                .padding(.top, 10)
            Text("NO PRICE SHOWN · THIS DEVICE\nHAS NO NETWORK TO ASK")
                .font(Type.mono(9))
                .kerning(1.6)
                .lineSpacing(4)
                .foregroundStyle(Ink.paperFaint)
                .padding(.top, 14)
                .padding(.bottom, 30)
        }
    }

    /// One zone per payee, same rule as the Bitcoin screen: the recipient
    /// that is not shown is the one that gets stolen to.
    @ViewBuilder private var destinations: some View {
        let payees = tx.paid
        if payees.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Hairline(weight: 2, color: Ink.ruleHeavy)
                Eyebrow("NO EXTERNAL RECIPIENT").padding(.top, 24)
                Text("Every output of this set returns to your own wallet. Nothing leaves " +
                     "to anyone else.")
                    .font(Type.body(13.5))
                    .lineSpacing(4)
                    .foregroundStyle(Ink.paperDim)
                    .padding(.top, 8)
                    .padding(.bottom, 26)
            }
        } else {
            ForEach(payees, id: \.position) { payee in
                MoneroDestinationZone(
                    payee: payee,
                    label: payees.count > 1 ? "RECIPIENT \(payee.position)" : "DESTINATION"
                ) {
                    vault.go(.xmrDestination(tx, payee))
                }
            }
        }
    }

    private var feeSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow("FEE").padding(.top, 32)
            amountLine(tx.feeFormatted)
            FieldRow(label: "STATED IN THE SET", value: "YES", tone: .verified).padding(.top, 12)
            FieldRow(label: "BALANCE CLOSES", value: "IN + FEE = OUT", tone: .verified)
            Text("A Monero fee is written into the set rather than left over. Before any " +
                 "signature exists, the signer checks that inputs equal outputs plus exactly " +
                 "this fee. A set that does not balance fails instead of signing.")
                .font(Type.body(13.5))
                .lineSpacing(4)
                .foregroundStyle(Ink.paperDim)
                .padding(.top, 14)
        }
    }

    @ViewBuilder private var changeSection: some View {
        let change = tx.returning
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow(change.count > 1 ? "CHANGE RETURNING TO YOU (\(change.count))"
                                     : "CHANGE RETURNING TO YOU").padding(.top, 32)
            if change.isEmpty {
                Text("None. The entire input value leaves as payment and fee, with nothing " +
                     "returning to this wallet.")
                    .font(Type.body(13.5))
                    .lineSpacing(4)
                    .foregroundStyle(Ink.paperDim)
                    .padding(.top, 12)
            } else {
                ForEach(change, id: \.position) { out in
                    amountLine(out.amountFormatted)
                    Text(out.address)
                        .font(Type.mono(12))
                        .kerning(0.4)
                        .lineSpacing(5)
                        .foregroundStyle(Ink.paperDim)
                        .padding(.top, 12)
                    FieldRow(label: "CHECKED AGAINST OWN ADDRESS", value: "MATCHES", tone: .verified)
                        .padding(.top, 10)
                }
                Text("The set claims these outputs return to you. The vault checked each " +
                     "against its own address before this screen existed; a claim that pointed " +
                     "anywhere else would have been refused, not displayed.")
                    .font(Type.body(13.5))
                    .lineSpacing(4)
                    .foregroundStyle(Ink.paperDim)
                    .padding(.top, 14)
            }
        }
    }

    private var privacySection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow("PRIVACY").padding(.top, 32).padding(.bottom, 8)
            FieldRow(label: "RING SIZE", value: "\(tx.ringSize)")
            FieldRow(label: "DECOYS PER INPUT", value: "\(tx.ringSize - 1)")
            Text("Your inputs hide among decoys the companion chose. Decoy choice affects " +
                 "privacy, never custody (a bad ring cannot move money), which is why it is " +
                 "listed here and not among the safety checks.")
                .font(Type.body(13.5))
                .lineSpacing(4)
                .foregroundStyle(Ink.paperDim)
                .padding(.top, 14)
        }
    }

    private var structureSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow("STRUCTURE").padding(.top, 32).padding(.bottom, 8)
            FieldRow(label: "INPUTS", value: "\(tx.inputCount)")
            FieldRow(label: "OUTPUTS", value: "\(tx.outputs.count)")
            if tx.outputs.contains(where: \.dummy) {
                FieldRow(label: "CONSENSUS PADDING", value: "1 ZERO-AMOUNT SELF-OUTPUT", tone: .dim)
            }
            FieldRow(label: "NETWORK", value: tx.network.uppercased())
        }
    }

    private var checksSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow("WHAT THE VAULT CHECKED").padding(.top, 32).padding(.bottom, 8)
            Attestation(text: "CHANGE CHECKED AGAINST OWN ADDRESS")
            Attestation(text: "FEE STATED, BALANCE CLOSES ON THE CURVE")
            Attestation(text: "EVERY ADDRESS VALID FOR \(tx.network.uppercased())")
            Attestation(text: "SET DIGEST RECORDED FOR APPROVAL")
        }
    }

    private func amountLine(_ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(value)
                .font(Type.readout(30))
                .foregroundStyle(Ink.paper)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            Text("XMR").font(Type.mono(15)).foregroundStyle(Ink.paperFaint)
        }
        .padding(.top, 12)
    }
}

// MARK: - Destination zone

/// The human verification zone, Monero edition. Same composition as the
/// Bitcoin `DestinationZone` — heavier top rule, its own surface, the tag
/// breaking the rule — with the address at a size a 95-character string can
/// hold while staying countable.
struct MoneroDestinationZone: View {
    let payee: MoneroOutput
    var label: String = "DESTINATION"
    var onInspect: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            AddressText(address: payee.address, size: 15)
                .foregroundStyle(Ink.paper)
                .padding(.top, 30)
            Hairline().padding(.top, 22).padding(.bottom, 16)
            HStack {
                Eyebrow("AMOUNT")
                Spacer()
                Text("\(payee.amountFormatted) XMR")
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
        .padding(.horizontal, -24)
        .padding(.top, 4)
    }
}

// MARK: - Destination inspector

struct XmrDestinationView: View {
    @EnvironmentObject private var vault: Vault
    let tx: MoneroSummary
    let output: MoneroOutput

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                HStack {
                    Eyebrow("DESTINATION", color: Ink.paper)
                    Spacer()
                    Button { vault.go(.xmrReview(tx)) } label: {
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
                             "the middle. All ninety-five characters are here.")
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
                            Text(output.address)
                                .font(Type.mono(12))
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

                Lever(title: "BACK TO TRANSACTION") { vault.go(.xmrReview(tx)) }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
            }
        }
    }

    private var chunks: [String] {
        let address = output.address
        return stride(from: 0, to: address.count, by: 4).map { i in
            let s = address.index(address.startIndex, offsetBy: i)
            let e = address.index(s, offsetBy: min(4, address.count - i))
            return String(address[s..<e])
        }
    }
}

// MARK: - Approval

struct XmrApproveView: View {
    @EnvironmentObject private var vault: Vault
    let tx: MoneroSummary
    let reviewedDigest: String

    @State private var attested: Set<String> = []
    private let required = ["THE DESTINATION", "THE AMOUNT", "THE FEE", "THE CHANGE"]

    private var toLine: String {
        let payees = tx.paid
        if payees.count == 1 { return "…" + payees[0].address.suffix(10) }
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

                        FieldRow(label: "AMOUNT", value: "\(tx.payingFormatted) XMR").padding(.top, 22)
                        FieldRow(label: "TO", value: toLine)
                        FieldRow(label: "FEE", value: "\(tx.feeFormatted) XMR")
                        FieldRow(label: "SET DIGEST", value: String(reviewedDigest.prefix(16)).uppercased())

                        Text("The signatures will be taken over this set and no other. The engine " +
                             "compares this digest against the set it described; a stale or " +
                             "altered approval fails there rather than signing.")
                            .font(Type.body(13.5))
                            .lineSpacing(4)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.top, 18)
                            .padding(.bottom, 24)
                    }
                    .padding(.horizontal, 24)
                }

                HoldToSign(enabled: attested.count == required.count) {
                    vault.completeMoneroSigning(tx, reviewedDigest: reviewedDigest)
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

// MARK: - Signed

struct XmrSignedView: View {
    // Declaration order is the memberwise-init order; the router builds
    // `XmrSignedView(tx:result:)`. Same contract as SignedView.
    let tx: MoneroSummary
    let result: Engine.MoneroSignReply
    @EnvironmentObject private var vault: Vault

    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 0) {
                VaultBar()
                Spacer()
                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow("COMPLETE", color: Ink.verified)
                    Text("SIGNED")
                        .font(Type.mega(64))
                        .kerning(-2.8)
                        .foregroundStyle(Ink.paper)
                        .padding(.top, 12)
                    Text("NOT BROADCAST")
                        .font(Type.statement(28))
                        .kerning(-0.8)
                        .foregroundStyle(Ink.paperFaint)
                        .padding(.top, 2)

                    Hairline(weight: 2, color: Ink.ruleHeavy).padding(.top, 28)
                    FieldRow(label: "RING SIGNATURES", value: "\(result.keyImages.count) OF \(tx.inputCount) · CLSAG")
                    FieldRow(label: "TX HASH", value: String(result.txid.prefix(16)).uppercased() + "…")
                    FieldRow(label: "NETWORK", value: result.network.uppercased())
                    FieldRow(label: "SENT ANYWHERE", value: "NO", tone: .verified)

                    Text("Nothing has left this device and nothing will. The vault has no way " +
                         "to reach the network. Carrying this to the chain is the companion's " +
                         "job, and only if you show it the code.")
                        .font(Type.body())
                        .lineSpacing(5)
                        .foregroundStyle(Ink.paperDim)
                        .padding(.top, 22)
                }
                .padding(.horizontal, 24)
                Spacer()
                Lever(title: "SHOW TO COMPANION", hint: "QR") { vault.go(.xmrSignedQR(tx, result)) }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
            }
        }
    }
}

struct XmrSignedQRView: View {
    // Same order contract: the router builds `XmrSignedQRView(tx:result:)`.
    let tx: MoneroSummary
    let result: Engine.MoneroSignReply
    @EnvironmentObject private var vault: Vault

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                VaultBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Eyebrow("SIGNED TRANSACTION SET").padding(.top, 12)
                        Statement("SHOW THIS TO YOUR", "COMPANION DEVICE", size: 30)
                            .padding(.top, 10)
                            .padding(.bottom, 20)

                        // The real XMRSIGNED frames from the engine. A Monero
                        // set is larger than a Bitcoin transaction, so there
                        // are more of them; order does not matter on the wire.
                        QRAperture(frames: result.frames, interval: 0.7)

                        FieldRow(label: "KIND", value: "XMRSIGNED").padding(.top, 18)
                        FieldRow(label: "FRAMES", value: "\(result.frames.count)")
                        FieldRow(label: "DIGEST", value: String(tx.digest.prefix(8)).uppercased())

                        VStack(alignment: .leading, spacing: 8) {
                            Text("THE VAULT CANNOT BROADCAST THIS TRANSACTION.")
                                .font(.system(size: 14, weight: .medium))
                                .kerning(0.3)
                                .foregroundStyle(Ink.paper)
                            Text("It has no code that could. Until your companion sends it, this " +
                                 "payment does not exist anywhere but on this screen.")
                                .font(Type.body(13))
                                .lineSpacing(4)
                                .foregroundStyle(Ink.paperDim)
                        }
                        .padding(18)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay { Rectangle().strokeBorder(Ink.ruleStrong, lineWidth: 1) }
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
}
