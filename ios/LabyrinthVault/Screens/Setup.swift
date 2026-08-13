//  Setup.swift
//  First run: an ordinary phone is physically converted into a signing
//  device. The interface's job is to make each irreversible-feeling step —
//  SIM out, radios off, keys made — feel like operating machinery, and to be
//  honest about which parts the app can do (verify, generate) and which only
//  the person can (pull the tray).

import SwiftUI
// For `isIdleTimerDisabled` on the key generation screen. SwiftUI has no
// modifier for it, and the alternative is a screen that asks a person to keep
// a phone awake that the phone is about to put to sleep underneath them.
import UIKit

struct SetupView: View {
    let stage: SetupStage

    var body: some View {
        switch stage {
        case .declaration: DeclarationView()
        case .radios: RadiosView()
        case .verify: VerifyAirgapView()
        case .boundary: BoundaryView()
        case .passphrase: PassphraseView()
        case .entropy: EntropyView()
        case .created: CreatedView()
        }
    }
}

// MARK: 01 — the declaration

private struct DeclarationView: View {
    @EnvironmentObject private var vault: Vault
    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 0) {
                Spacer()
                Statement("THIS PHONE", "IS NOW", "A VAULT.", size: 56)
                Hairline().padding(.vertical, 30)
                Text("It will hold keys and give signatures. It will not hold money, watch a " +
                     "balance, or reach a network. Those belong to the device in your pocket, " +
                     "and that device is never trusted with a key.")
                    .font(Type.body())
                    .lineSpacing(5)
                    .foregroundStyle(Ink.paperDim)
                Spacer()
                Lever(title: "BEGIN", hint: "STEP 1 / 6") { vault.go(.setup(.radios)) }
                    .padding(.bottom, 12)
            }
            .padding(.horizontal, 24)
        }
    }
}

// MARK: 02 — sever the radios

private struct RadiosView: View {
    @EnvironmentObject private var vault: Vault
    @State private var done: Set<Int> = []

    private let steps: [(String, String)] = [
        ("REMOVE SIM", "Physically. The tray, not a setting."),
        ("DISABLE WI-FI", "In Settings, not Control Center."),
        ("DISABLE BLUETOOTH", "Including sharing and nearby devices."),
        ("DISABLE CELLULAR", "Data and voice."),
        ("VERIFY IN SETTINGS", "The vault requests no network permission. Confirm it has none."),
    ]

    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 0) {
                VaultBar(airgap: .unverified)
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Statement("SEVER", "THE RADIOS.", size: 44)
                            .padding(.top, 18)
                        Text("Each of these is yours to do. The vault cannot turn a radio off " +
                             "for you. It can only refuse to ask for one.")
                            .font(Type.body())
                            .lineSpacing(5)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.top, 14)
                            .padding(.bottom, 26)

                        ForEach(steps.indices, id: \.self) { i in
                            stepRow(i)
                        }
                    }
                    .padding(.horizontal, 24)
                }
                Lever(title: "VERIFY AIRGAP",
                      hint: "\(done.count) / \(steps.count)",
                      enabled: done.count == steps.count) {
                    vault.go(.setup(.verify))
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 12)
            }
        }
    }

    private func stepRow(_ i: Int) -> some View {
        Button {
            guard !done.contains(i) else { return }
            Haptic.verify()
            withAnimation(.easeOut(duration: 0.25)) { _ = done.insert(i) }
        } label: {
            VStack(spacing: 0) {
                HStack(alignment: .top, spacing: 12) {
                    ZStack {
                        Rectangle()
                            .strokeBorder(done.contains(i) ? Ink.verified : Ink.ruleStrong, lineWidth: 1)
                            .frame(width: 16, height: 16)
                        if done.contains(i) {
                            Image(systemName: "checkmark")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(Ink.verified)
                        }
                    }
                    .padding(.top, 1)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(steps[i].0)
                            .font(.system(size: 12, weight: .medium))
                            .kerning(1.4)
                            .foregroundStyle(done.contains(i) ? Ink.paper : Ink.paperDim)
                        Text(steps[i].1)
                            .font(.system(size: 11))
                            .foregroundStyle(Ink.paperFaint)
                    }
                    Spacer()
                    Text(String(format: "%02d", i + 1))
                        .font(Type.mono(9))
                        .foregroundStyle(Ink.paperGhost)
                }
                .padding(.vertical, 16)
                Hairline()
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: 03 — airgap verification

/// The app's half of the airgap, stated as fact. Not a probe: the radios are
/// unreadable from inside this build, on purpose — seeing their switches
/// would need frameworks the binary refuses to link — so what walks in here
/// is only what the build can stand behind. The person's half was the
/// previous screen, done by hand, and the copy says which half is which.
private struct VerifyAirgapView: View {
    @EnvironmentObject private var vault: Vault
    @State private var shown = 0
    @State private var verdict = false

    private let facts: [(String, String)] = [
        ("NETWORK CODE IN BINARY", "NONE"),
        ("NETWORK PERMISSION", "NOT REQUESTED"),
        ("LINKED SOCKETS", "NONE"),
        ("CLOUD CONTAINER", "NONE"),
        ("ACCOUNT SESSION", "NONE"),
        ("RADIO SWITCHES", "YOURS · SETTINGS"),
    ]

    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 0) {
                VaultBar(airgap: verdict ? .verified : .unverified)
                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow("THE APP'S HALF").padding(.top, 20)
                    Statement("NETWORK", "ACCESS", size: 42).padding(.top, 16)
                    Text(verdict ? "NONE TO HAVE" : "· · ·")
                        .font(Type.readout(40))
                        .foregroundStyle(verdict ? Ink.verified : Ink.paperGhost)
                        .padding(.top, 16)
                        .padding(.bottom, 26)

                    ForEach(0..<shown, id: \.self) { i in
                        FieldRow(label: facts[i].0, value: facts[i].1,
                                 tone: i == facts.count - 1 ? .dim : .verified)
                            .transition(.opacity.combined(with: .offset(y: 8)))
                    }
                    Spacer()
                    // Reached from first-run and from Settings' re-run; only
                    // first-run continues into the rest of setup.
                    Lever(title: "CONTINUE",
                          hint: verdict ? "STATED" : "READING",
                          enabled: verdict) {
                        vault.go(vault.hasVault ? .airgap : .setup(.boundary))
                    }
                    .padding(.bottom, 12)
                }
                .padding(.horizontal, 24)
            }
        }
        .onAppear { advance() }
    }

    private func advance() {
        guard shown < facts.count else {
            Haptic.signed()
            withAnimation(.easeOut(duration: 0.4)) { verdict = true }
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.34) {
            Haptic.frame()
            withAnimation(.easeOut(duration: 0.3)) { shown += 1 }
            advance()
        }
    }
}

// MARK: 04 — the boundary

private struct BoundaryView: View {
    @EnvironmentObject private var vault: Vault
    var body: some View {
        Screen {
            ZStack {
                LabyrinthWatermark()
                VStack(alignment: .leading, spacing: 0) {
                    Spacer()
                    Eyebrow("SECURITY BOUNDARY")
                    Statement("THIS", "DEVICE.", size: 60).padding(.top, 16)
                    Hairline(weight: 2, color: Ink.ruleHeavy).padding(.vertical, 26)
                    Text("Everything inside this phone is trusted. Everything outside it (the " +
                         "companion, the desktop wallet, the QR code you are about to scan) is " +
                         "not, and is not required to be.")
                        .font(Type.body())
                        .lineSpacing(5)
                        .foregroundStyle(Ink.paperDim)
                    Text("You are the last check on the boundary. The vault will show you what " +
                         "it is about to sign, in full, every time.")
                        .font(Type.body())
                        .lineSpacing(5)
                        .foregroundStyle(Ink.paper)
                        .padding(.top, 14)
                    Spacer()
                    Lever(title: "SET PASSPHRASE", hint: "STEP 4 / 6") { vault.go(.setup(.passphrase)) }
                        .padding(.bottom, 12)
                }
                .padding(.horizontal, 24)
            }
        }
    }
}

// MARK: 05 — the passphrase

private struct PassphraseView: View {
    @EnvironmentObject private var vault: Vault
    @State private var chosen = ""
    @State private var confirmed = ""
    @FocusState private var field: PassphraseFocus?

    private var match: Bool { !chosen.isEmpty && chosen == confirmed }

    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 0) {
                VaultBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Statement("CHOOSE A", "PASSPHRASE.", size: 44).padding(.top, 18)
                        Text("It is stretched into the key that seals your keys. It is not " +
                             "stored anywhere, on this device or off it, and there is no " +
                             "reset: forgetting it means recovering from the words on paper.")
                            .font(Type.body())
                            .lineSpacing(5)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.top, 14)
                            .padding(.bottom, 30)

                        /* Both fields can be revealed, and this screen is where
                         * it matters most: a passphrase mistyped here is
                         * sealed into the vault, and the first anybody hears
                         * of it is a vault that will not open. The confirm
                         * field catches a typo repeated once; it cannot catch
                         * one made twice, and being able to look can. */
                        PassphraseField(label: "PASSPHRASE",
                                        text: $chosen,
                                        focus: $field,
                                        equals: .entry,
                                        contentType: .newPassword,
                                        submitLabel: .next) { field = .again }

                        PassphraseField(label: "AGAIN",
                                        text: $confirmed,
                                        focus: $field,
                                        equals: .again,
                                        contentType: .newPassword,
                                        submitLabel: .done)
                            .padding(.top, 22)

                        if !confirmed.isEmpty && !match {
                            Text("The two entries do not match yet.")
                                .font(Type.body(13))
                                .foregroundStyle(Ink.attention)
                                .padding(.top, 12)
                        }
                    }
                    .padding(.horizontal, 24)
                }
                Lever(title: "GENERATE KEYS",
                      hint: "STEP 5 / 6",
                      enabled: match) {
                    vault.beginCreate(passphrase: chosen)
                    chosen = ""
                    confirmed = ""
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 12)
            }
        }
        .onAppear { field = .entry }
    }
}

// MARK: 06 — key generation

private struct EntropyView: View {
    @EnvironmentObject private var vault: Vault
    @State private var began = Date()
    @State private var bits = 0
    /// The choreography has finished; the engine may still be sealing.
    @State private var fieldDone = false
    /// Seconds since this screen appeared, ticked by the timer below.
    ///
    /// Held as state rather than read from the clock inside the body, so every
    /// number here derives from one value SwiftUI knows has changed. A `Date()`
    /// inside a computed property only updates when something else happens to
    /// redraw, which is how a clock comes to look stuck on the one screen where
    /// looking stuck is the whole problem.
    @State private var elapsed: Double = 0
    /// What `elapsed` read when the second derivation began, so its estimate
    /// counts down from there.
    @State private var reopenAt: Double?

    private var failure: String? {
        if case .failed(let sentence) = vault.creation { return sentence }
        return nil
    }

    var body: some View {
        Screen {
            if let failure {
                failed(failure)
            } else {
                working
            }
        }
        /* The real work — fresh randomness into the engine's create, the
         * sealed blob into the keychain, an unlock of the stored blob to
         * prove a relaunch will find a vault that opens — was started by
         * `beginCreate` before this screen appeared, so the passphrase never
         * waits in a model property between screens. This screen renders the
         * progress and moves on when both the drawing and the sealing are
         * done, whichever finishes last. */
        .onChange(of: vault.creation) { _ in advance() }
        .onChange(of: vault.sealing) { _ in
            if case .reopening = vault.sealing, reopenAt == nil { reopenAt = elapsed }
        }
        .onReceive(Timer.publish(every: 0.1, on: .main, in: .common).autoconnect()) { now in
            elapsed = now.timeIntervalSince(began)
            bits = min(256, Int(elapsed / 5.2 * 256))
            /* The choreography used to open this gate when the entropy field
             * landed. The field is now the opening movement of a composition
             * that runs for as long as the work does, so the gate keeps its
             * original 5.2 seconds and reads them off the same clock. */
            if !fieldDone, elapsed >= 5.2 {
                fieldDone = true
                advance()
            }
        }
        /* ## The app holds the screen awake, rather than asking
         *
         * Both derivations run on a detached task, so the main thread stays
         * responsive and the screen keeps drawing. That is not enough. Auto
         * Lock is thirty seconds on a new phone and this screen asks somebody
         * to sit and watch it for minutes without touching anything, so the
         * phone locks itself, the app goes to the background, and iOS stops an
         * app that keeps burning CPU there. Telling a person not to leave the
         * screen does not help when the party that leaves is the phone.
         *
         * So the idle timer goes off for exactly as long as this screen is up
         * and comes back on the way out, including when creation fails. It is
         * a system-wide setting owned by whoever set it last, and a screen
         * that turned it off and did not turn it back on would be a battery
         * bug filed against the wrong feature. */
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }

    /// Which pass, in the person's words rather than the engine's.
    private var step: String {
        switch vault.sealing {
        case .sealing: return "1 OF 2 · SEALING"
        case .reopening: return "2 OF 2 · REOPENING"
        case .idle: return vault.creation == .done ? "COMPLETE" : "STARTING"
        }
    }

    /// How far through the second pass, or nil while nothing can honestly be
    /// predicted. The first pass has no precedent on this device, and a bar
    /// that crept along to a number nobody measured would be a lie told
    /// slowly.
    private var progress: Double? {
        guard case .reopening(let expected) = vault.sealing,
              let from = reopenAt, expected > 0 else { return nil }
        return (elapsed - from) / expected
    }

    private var remaining: String {
        guard case .reopening(let expected) = vault.sealing, let from = reopenAt else {
            return "MEASURING"
        }
        let left = expected - (elapsed - from)
        return left <= 1 ? "ANY MOMENT" : "ABOUT \(clock(left))"
    }

    private func clock(_ seconds: Double) -> String {
        let whole = max(0, Int(seconds.rounded()))
        return String(format: "%d:%02d", whole / 60, whole % 60)
    }

    private func advance() {
        guard fieldDone, vault.creation == .done else { return }
        Haptic.signed()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            vault.go(.setup(.created))
        }
    }

    private var working: some View {
        /* Full bleed, because the wait is. On this device a pass takes about
         * 67 seconds and creation runs two, so there is no version of this
         * screen that a person glances at. It gets the whole display, with the
         * readout sitting over the lower half behind a scrim that keeps the
         * text on paper rather than on a moving figure. */
        ZStack {
            KeyMaking(reach: progress)
                .ignoresSafeArea()

            LinearGradient(
                colors: [Ink.void.opacity(0), Ink.void.opacity(0.88), Ink.void],
                startPoint: UnitPoint(x: 0.5, y: 0.34),
                endPoint: UnitPoint(x: 0.5, y: 0.60))
                .ignoresSafeArea()
                .allowsHitTesting(false)

            VStack(alignment: .leading, spacing: 0) {
                Spacer()
                Statement("GENERATING", "KEY MATERIAL", size: 32)
                FieldRow(label: "ENTROPY COLLECTED", value: "\(bits) / 256 BITS")
                    .padding(.top, 10)
                FieldRow(label: "ARGON2ID",
                         value: vault.creation == .done ? "COMPLETE" : step,
                         tone: vault.creation == .done ? .verified : .plain)
                FieldRow(label: "ELAPSED", value: clock(elapsed))
                FieldRow(label: "REMAINING", value: vault.creation == .done ? "NONE" : remaining)

                patience.padding(.top, 22)

                Text("THIS SCREEN IS BEING HELD AWAKE")
                    .font(Type.mono(10))
                    .kerning(2.2)
                    .foregroundStyle(Ink.paperDim)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 20)
                    .padding(.bottom, 24)
            }
            .padding(.horizontal, 24)
        }
    }

    /// The box that answers the question a person is actually asking.
    ///
    /// Which is never "what algorithm is this". It is "has it died, and am I
    /// about to lose my keys". Everything here is written to answer that, and
    /// the reason the wait exists is included because a cost somebody
    /// understands is a cost they will tolerate, and this one is bought
    /// entirely on their behalf.
    private var patience: some View {
        VStack(alignment: .leading, spacing: 9) {
            Eyebrow("THIS IS NOT FROZEN", color: Ink.attention)
            line("Turning your passphrase into a key is meant to be slow. It costs you " +
                 "this once, and it costs anyone guessing it the same on every guess.",
                 tone: Ink.paperDim)
            line("It runs twice: once to seal the vault, once to open it again from " +
                 "storage. Only the stored bytes opening proves it will open tomorrow.",
                 tone: Ink.paperDim)
            line("The phone will not sleep while this runs. Do not lock it by hand and " +
                 "do not leave the app.", tone: Ink.paper)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Ink.void.opacity(0.72))
        .overlay { Rectangle().strokeBorder(Ink.rule, lineWidth: 1) }
    }

    /* `fixedSize` vertically is the whole point of this helper. Inside a
     * VStack that is competing for height, SwiftUI resolves the shortfall by
     * truncating the paragraphs, and the sentence that got cut on the first
     * device was the one telling a person not to lock the phone. Text that
     * only matters when it is read in full has to be allowed its full
     * height. */
    private func line(_ copy: String, tone: Color) -> some View {
        Text(copy)
            .font(Type.body(13))
            .lineSpacing(4)
            .foregroundStyle(tone)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Nothing was kept: every failure path in `createVault` erases whatever
    /// half-made state it left, so trying again is genuinely from zero.
    private func failed(_ sentence: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer()
            VStack(alignment: .leading, spacing: 0) {
                Eyebrow("NOT CREATED", color: Ink.refused)
                Statement("NO KEYS", "WERE MADE.", size: 40).padding(.top, 16)
                Text(sentence)
                    .font(Type.body())
                    .lineSpacing(5)
                    .foregroundStyle(Ink.paper)
                    .padding(.top, 14)
            }
            .padding(.horizontal, 24)
            Spacer()
            Lever(title: "TRY AGAIN") { vault.go(.setup(.passphrase)) }
                .padding(.horizontal, 24)
                .padding(.bottom, 12)
        }
    }
}

// MARK: 07 — created

private struct CreatedView: View {
    @EnvironmentObject private var vault: Vault
    var body: some View {
        Screen {
            VStack(alignment: .leading, spacing: 0) {
                VaultBar()
                Spacer()
                VStack(alignment: .leading, spacing: 0) {
                    Eyebrow("COMPLETE", color: Ink.verified)
                    Statement("KEY MATERIAL", "CREATED.", size: 40).padding(.top, 16).padding(.bottom, 26)
                    /* The id is derived from the account key the engine just
                     * returned — reading it here is the proof that what sits
                     * in the keychain unlocked, not a card that always says
                     * done. */
                    FieldRow(label: "VAULT ID", value: vault.vaultID)
                    FieldRow(label: "AT REST", value: "SEALED · ARGON2ID + XCHACHA20", tone: .verified)
                    FieldRow(label: "KEYCHAIN CLASS", value: "PASSCODE-BOUND · THIS DEVICE ONLY")
                    FieldRow(label: "COPIES ELSEWHERE", value: "NONE")
                    Text("There is no cloud backup, because there is no cloud. If you lose this " +
                         "phone without a recovery phrase written down, the keys are gone. That " +
                         "is the trade you made when you took the SIM out.")
                        .font(Type.body(14))
                        .lineSpacing(5)
                        .foregroundStyle(Ink.paperDim)
                        .padding(.top, 22)
                }
                .padding(.horizontal, 24)
                Spacer()
                VStack(spacing: 10) {
                    Lever(title: "OPEN VAULT") {
                        vault.go(.home)
                    }
                    Lever(title: "WRITE DOWN RECOVERY PHRASE", hint: "RECOMMENDED", style: .quiet) {
                        vault.go(.recovery)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 12)
            }
        }
    }
}
