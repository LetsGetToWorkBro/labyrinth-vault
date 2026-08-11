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

import SwiftUI

struct KeyImagesView: View {
    let result: Engine.KeyImagesReply
    @EnvironmentObject private var vault: Vault

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

                        QRAperture(frames: result.frames, interval: 0.7)

                        FieldRow(label: "KIND", value: "XMRKEYIMAGES").padding(.top, 18)
                        FieldRow(label: "ANSWERED", value: "\(result.answered)")
                        FieldRow(label: "REFUSED", value: "\(result.refused)",
                                 tone: result.refused > 0 ? .attention : .plain)

                        if result.refused > 0 {
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

                        Text("A key image lets your companion see when an output it found has " +
                             "been spent, which is what turns a received total into a balance. " +
                             "It reveals nothing to the network that the network did not " +
                             "already publish.")
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
}
