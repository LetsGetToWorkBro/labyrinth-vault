//  MoneroFile.swift
//  One of Monero's own wallet files, opened and described. Nothing more.
//
//  ## What this screen replaced
//
//  A blanket refusal. For several builds, a `wallet2` file of any kind hit a
//  screen that said "MONERO NOT YET" and meant it: the container's body is
//  encrypted under a key `cn_slow_hash` derives from the view secret, and the
//  vault had no CryptoNight. That is no longer true for one of the six files.
//  `Monero unsigned tx set` opens, and the reader that opens it was written
//  against bytes Monero's own `binary_archive` produced.
//
//  So a person holding a file the vault can read should be shown what is in
//  it. Refusing a question you can answer is its own kind of dishonesty.
//
//  ## What this screen must never become
//
//  A confirmation screen. It looks at first glance like one and it is the
//  opposite of one, and every design decision below is about keeping the two
//  apart:
//
//    - **No gate, no hold, no lever that signs.** `XmrReviewView` makes you
//      scroll to the end before its lever arms, because a person is about to
//      commit. There is nothing to commit to here. The only control returns
//      to the vault.
//    - **No green.** `Ink.verified` appears nowhere on this screen. On the
//      confirmation screens it means "the vault re-derived this and it
//      matched". Nothing on this screen has been re-derived, so the color
//      that says so would be a lie told in a color.
//    - **The caveat is above the numbers, not under them.** It is the frame
//      the figures are read through, not a footnote to be scrolled past.
//
//  The distinction is not pedantry about provenance. A `tx_construction_data`
//  is the *sending* wallet describing its own transaction: amounts, ring
//  members, destinations, and the claim that one output is change. Nothing in
//  the file is evidence for anything else in it. A watch-only wallet that
//  lies about where the money goes writes a file that opens cleanly, parses
//  perfectly, and reads exactly like this one. Checking a destination means
//  rebuilding it from this vault's own keys, which needs a request shaped for
//  that, which is what the Labyrinth wallet sends and what
//  `moneroDescribe` reads.
//
//  So the screen says what the file says, says whose word that is, and says
//  where to go to get a payment the vault will actually check. That last part
//  is what keeps it from being a dead end.

import SwiftUI

struct MoneroFileView: View {
    @EnvironmentObject private var vault: Vault
    let file: MoneroFile

    var body: some View {
        Screen {
            VStack(spacing: 0) {
                VaultBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        header
                        if file.readable {
                            claimNotice
                            if file.transactions.count > 1 { fileTotals }
                            ForEach(file.transactions) { tx in
                                transactionSection(tx, of: file.transactions.count)
                            }
                        } else {
                            notOpened
                        }
                        cannotSign
                        Spacer(minLength: 28)
                    }
                    .padding(.horizontal, 24)
                }
                Lever(title: "DONE", hint: "RETURN TO VAULT", style: .quiet) { vault.go(.home) }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
            }
        }
        .onAppear { Haptic.tick() }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow(file.readable ? "MONERO FILE · READ ONLY" : "MONERO FILE · NOT OPENED")
                .padding(.top, 12)
            if file.readable {
                Statement("WHAT THIS FILE", "SAYS IT WILL DO", size: 30)
                    .padding(.top, 10)
            } else {
                Statement("THE VAULT", "COULD NOT", "OPEN THIS", size: 30)
                    .padding(.top, 10)
            }
            /* `what` is written as a noun phrase with its article, because it
             * belongs in a sentence: "a Monero unsigned transaction set".
             * Squeezed into a right-aligned field-row value it would read as a
             * label with a stray "A" on the front, and wrap to two lines doing
             * it. The engine wrote it for prose, so it goes in prose. */
            Text("The vault recognized this as \(file.what).")
                .font(Type.body(13.5))
                .lineSpacing(4)
                .foregroundStyle(Ink.paperDim)
                .padding(.top, 14)
        }
    }

    // MARK: - The frame the numbers are read through

    /// Deliberately the first thing under the title. Everything below it is
    /// the sending wallet talking about itself, and a person who reads the
    /// amounts before reading this has already formed an impression the rest
    /// of the screen has to undo.
    private var claimNotice: some View {
        Panel(title: "THESE ARE THE SENDER'S OWN FIGURES") {
            Text("The vault opened this file with your view key and added the numbers up. "
                 + "It has not checked any of them, and from a file alone it cannot: every "
                 + "figure below is what the wallet that wrote the file says about itself. "
                 + "A wallet that lied about where the money goes would produce a file that "
                 + "reads exactly like this one.\n\n"
                 /* Opening it feels like proof of origin and is not, so the
                  * screen says the smaller true thing rather than letting the
                  * larger false one stand. Monero puts a 64-byte signature on
                  * these files; this build does not check it. What opening one
                  * shows is that whoever wrote it held your view key. */
                 + "Nor is opening it proof of where it came from. These files carry a "
                 + "signature and the vault does not check it. All that opening one shows "
                 + "is that whoever wrote it had your view key.")
        }
        .padding(.top, 24)
    }

    // MARK: - Totals, when the file holds more than one transaction

    private var fileTotals: some View {
        VStack(alignment: .leading, spacing: 0) {
            Hairline(weight: 2, color: Ink.ruleHeavy).padding(.top, 30)
            Eyebrow("ALL \(file.transactions.count) TRANSACTIONS TOGETHER").padding(.top, 24)
            amount(file.payingFormatted)
            FieldRow(label: "FEES TOGETHER", value: "\(file.feeFormatted) XMR").padding(.top, 14)
        }
    }

    // MARK: - One transaction

    @ViewBuilder private func transactionSection(_ tx: MoneroFileTx, of count: Int) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Hairline(weight: 2, color: Ink.ruleHeavy).padding(.top, 30)
            Eyebrow(count > 1 ? "TRANSACTION \(tx.position) OF \(count)" : "THE PAYMENT")
                .padding(.top, 24)

            /* The paying figure appears once. As the instrument line when this
             * is the only transaction in the file, and as an ordinary row when
             * it is one of several and the file's own total is already set
             * large above. Printing it both ways in the same block reads as
             * two numbers that happen to agree. */
            if count == 1 {
                amount(tx.payingFormatted)
            } else {
                FieldRow(label: "PAYING", value: "\(tx.payingFormatted) XMR").padding(.top, 12)
            }

            FieldRow(label: "FEE", value: "\(tx.feeFormatted) XMR")
                .padding(.top, count == 1 ? 14 : 0)
            FieldRow(label: "COMING BACK TO YOU", value: "\(tx.changeFormatted) XMR")
            FieldRow(label: "TAKEN FROM YOUR COINS", value: "\(tx.spendingFormatted) XMR")

            payees(tx)

            Eyebrow("HOW IT IS BUILT").padding(.top, 28)
            FieldRow(label: "COINS SPENT", value: "\(tx.inputCount)").padding(.top, 12)
            FieldRow(label: "OUTPUTS CREATED", value: "\(tx.outputCount)")
            FieldRow(label: "RING SIZE", value: "\(tx.ringSize)")
            /* The comparison is against a sentence the engine owns, which is a
             * seam that can drift. It drifts safely: anything the engine
             * rewords reads as a lock rather than as no lock, which is the
             * direction that makes somebody look rather than the direction
             * that makes them relax. */
            FieldRow(label: "SPENDABLE", value: tx.spendableNote.uppercased(),
                     tone: tx.spendableNote == "Immediately" ? .plain : .attention)
            Text("The ring size is how many decoy coins each of your own is hidden among. "
                 + "It is a privacy number, not a safety one: a small ring cannot move your "
                 + "money, it can only make a spend easier to pick out later.")
                .font(Type.body(13))
                .lineSpacing(4)
                .foregroundStyle(Ink.paperDim)
                .padding(.top, 14)
        }
    }

    /// Who the file says gets paid.
    ///
    /// The one part of the screen worth the most care, for the same reason the
    /// confirmation screens list every output: the recipient that is not shown
    /// is the one that gets stolen to. The difference is that here the address
    /// is being reported rather than vouched for.
    @ViewBuilder private func payees(_ tx: MoneroFileTx) -> some View {
        Eyebrow(tx.payments.count > 1 ? "IT SAYS IT PAYS \(tx.payments.count) PEOPLE"
                                      : "IT SAYS IT PAYS").padding(.top, 28)
        if tx.payments.isEmpty {
            Text("The file names nobody outside this wallet. Every output comes back to "
                 + "you, so it moves your own money and pays only the fee. That is what a "
                 + "consolidation looks like.")
                .font(Type.body(13.5))
                .lineSpacing(4)
                .foregroundStyle(Ink.paperDim)
                .padding(.top, 12)
        } else {
            ForEach(tx.payments) { payment in
                VStack(alignment: .leading, spacing: 0) {
                    Text("\(payment.amountFormatted) XMR")
                        .font(Type.mono(16))
                        .foregroundStyle(Ink.paper)
                        .padding(.top, 16)
                    if let address = payment.address {
                        Text(address)
                            .font(Type.mono(12))
                            .kerning(0.4)
                            .lineSpacing(5)
                            .foregroundStyle(Ink.paperDim)
                            .padding(.top, 10)
                        Eyebrow(payment.kind).padding(.top, 10)
                    } else {
                        Text("The file did not record an address for this payment. It carries "
                             + "the recipient's keys but not which Monero network they belong "
                             + "to, and the vault will not print an address it had to guess at.")
                            .font(Type.body(13))
                            .lineSpacing(4)
                            .foregroundStyle(Ink.attention)
                            .padding(.top, 10)
                    }
                }
            }
        }
    }

    // MARK: - The file that would not open

    private var notOpened: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(file.problem ?? "The vault gave no reason, which is itself a fault.")
                .font(Type.body())
                .lineSpacing(5)
                .foregroundStyle(Ink.paper)
                .padding(.top, 24)
            Text("Nothing about your vault changed, and the file on the other device is "
                 + "untouched. If it belongs to a different wallet, that is the expected "
                 + "answer rather than a fault in either of them.")
                .font(Type.body(13))
                .lineSpacing(4)
                .foregroundStyle(Ink.paperDim)
                .padding(.top, 16)
        }
    }

    // MARK: - The ceiling, stated plainly

    private var cannotSign: some View {
        Panel(title: "THE VAULT WILL NOT SIGN THIS") {
            Text("Signing a Monero payment here means the vault rebuilding every destination "
                 + "from its own keys and checking them before you are asked to approve "
                 + "anything. A file like this one cannot be checked that way, so reading it "
                 + "is where the vault stops.\n\n"
                 + "To send a payment the vault will check, start it in the Labyrinth wallet "
                 + "and show the vault the code it produces. Nothing was signed here and "
                 + "nothing was changed.")
        }
        .padding(.top, 30)
    }

    // MARK: - Pieces

    /// The one large figure on the screen, set smaller than the confirmation
    /// screens' readout on purpose. That instrument face means "the vault
    /// measured this"; this one is quoting somebody.
    private func amount(_ value: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(value)
                .font(Type.readout(38))
                .foregroundStyle(Ink.paper)
                .minimumScaleFactor(0.5)
                .lineLimit(1)
                .padding(.top, 14)
            Text("XMR · AS THE FILE STATES IT")
                .font(Type.mono(9))
                .kerning(1.6)
                .foregroundStyle(Ink.paperFaint)
                .padding(.top, 10)
        }
    }
}

/// A bordered aside. The same treatment the key image screen gives its
/// refused-count explanation: a box, because the words inside it are a
/// condition on everything around them rather than another row of data.
private struct Panel<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 14, weight: .medium))
                .kerning(0.3)
                .foregroundStyle(Ink.paper)
            content
                .font(Type.body(13))
                .lineSpacing(4)
                .foregroundStyle(Ink.paperDim)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay { Rectangle().strokeBorder(Ink.ruleStrong, lineWidth: 1) }
    }
}
