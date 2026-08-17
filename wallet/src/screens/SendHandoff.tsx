/**
 * The faces of the send flow that are about the *other* device.
 *
 * ## Why these four moved out of Send.tsx
 *
 * The split was asked for by the signing step rather than by the line count.
 * `Send.tsx` was 930 lines and nine faces, and the tidy-looking seam was one
 * face per file, which would have been nine files that each know the whole
 * flow. The seam that pays for itself is the one the new step revealed: with
 * keys on this phone, a payment can now reach a signature two entirely
 * different ways, and *these* four faces are the ones that only exist on the
 * way that crosses a room.
 *
 *   TRANSMIT    frames on the glass, for the vault's camera
 *   AWAITING    nothing. Deliberately, visibly nothing.
 *   RECEIVE     our camera, reading a signature back
 *   MISMATCH    what came back is not what was approved
 *
 * `SendSigning.tsx` is the other way, and it is one face, because there is no
 * room to walk across.
 *
 * What stays in `Send.tsx` is the spine both paths share: compose, review,
 * ready, done, failed. If a change touches only the QR round trip it touches
 * only this file, which is the property the split was for.
 *
 * ## Mismatch has no way forward, and that is enforced upstream
 *
 * There is no disabled button here and no "I understand the risk". The state
 * cannot broadcast, which `canBroadcast` and the tests around it hold, so the
 * screen does not offer it. The only exits are discarding the payment and
 * looking at what came back.
 */

import { useEffect } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { Action, Datum, FactRow, Gap, Notice, Panel, Rule } from '../design/atoms';
import { Body, Label, LabelWide, Mono, Small, Strong, Title } from '../design/text';
import { Header } from '../components/chrome';
import { AddressBlock, Amount } from '../components/money';
import { Journey, Link } from '../labyrinth/glyphs';
import { QrCanvas } from '../qr/QrCanvas';
import { CrossIcon, ScanIcon } from '../components/icons';
import { color, space } from '../design/tokens';
import { elide } from '../core/units';
import { useFrames } from '../qr/useFrames';
import { standInVault, PUBLISHED_TEST_WORDS, DEMO } from '../demo/standin';
import { useStore } from '../state/store';

// --------------------------------------------------------------- 3. transmit

/**
 * The frames.
 *
 * The code is the largest thing on the screen and everything else is arranged
 * to stay out of a camera's way: no white surfaces beside it, no bright text
 * under it, nothing that moves within the frame. The counter and the labyrinth
 * are what animate, because the person holding this phone needs to know the
 * transfer is alive while they are looking at the *other* screen.
 */
export function Transmit({ onBack }: { onBack: () => void }) {
  const store = useStore();
  const transmission = store.session.transmission;
  const { frame, status } = useFrames(transmission);

  if (!transmission) return null;
  const draft = store.session.draft;

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Header onBack={onBack} overline="SHOW TO VAULT" title="Point the vault at this" />
      <Gap size={space.gap} />

      <View style={{ alignItems: 'center' }}>
        <QrCanvas value={frame} size={320} level="M" />
        <Gap size={space.gap} />

        <View style={{ flexDirection: 'row', gap: space.section }}>
          <Datum label="FRAME">
            <Strong>{`${status.frame} / ${status.total}`}</Strong>
          </Datum>
          <Datum label="PASSES">
            <Strong>{`${status.laps}`}</Strong>
          </Datum>
          <Datum label="PAYLOAD">
            <Strong>{transmission.kind === 'PSBT' ? 'UNSIGNED' : 'UNSIGNED SET'}</Strong>
          </Datum>
        </View>

        <Gap size={space.gap} />
        <Link direction="out" active width={280} />
        <Gap size={space.step} />
        <Small tone={color.slate}>
          The codes repeat. A scan that missed one will pick it up on the next pass.
        </Small>
      </View>

      <Gap size={space.section} />
      <View style={{ paddingHorizontal: space.gutter }}>
        {draft ? (
          <>
            <Rule />
            <FactRow label="DIGEST">
              <Mono size={13}>{elide(draft.digest, 8, 8)}</Mono>
            </FactRow>
            <FactRow label="TO" last>
              <Mono size={13}>{elide(draft.recipient, 8, 8)}</Mono>
            </FactRow>
            <Gap size={space.gap} />
            <Small tone={color.slate}>
              The vault will show the same digest. If the two do not match, you are not looking at the
              transaction you built.
            </Small>
          </>
        ) : null}

        <Gap size={space.section} />
        <Action label="THE VAULT HAS IT" onPress={store.handOver} />
      </View>
      <Gap size={space.chapter} />
    </ScrollView>
  );
}

// --------------------------------------------------------------- 4. awaiting

export function Awaiting({ onBack }: { onBack: () => void }) {
  const store = useStore();
  const draft = store.session.draft;

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Header onBack={onBack} overline="WAITING FOR THE VAULT" title="Read the vault's screen" />
      <Gap size={space.section} />

      <View style={{ alignItems: 'center' }}>
        <Journey reached={3} size={210} waiting />
        <Gap size={space.gap} />
        <LabelWide tone={color.warn}>VERIFY ON THE VAULT</LabelWide>
      </View>

      <Gap size={space.section} />
      <View style={{ paddingHorizontal: space.gutter }}>
        <Rule />
        <FactRow label="AMOUNT">
          {draft ? <Amount atoms={draft.amount} asset={draft.asset} size="strong" /> : <Strong>not yet</Strong>}
        </FactRow>
        <FactRow label="DESTINATION">
          <Mono size={13}>{draft ? elide(draft.recipient, 10, 8) : 'not yet'}</Mono>
        </FactRow>
        <FactRow label="FEE">
          {draft ? <Amount atoms={draft.fee} asset={draft.asset} size="strong" /> : <Strong>not yet</Strong>}
        </FactRow>
        <FactRow label="CHANGE" last>
          <Mono size={13}>
            {draft && draft.changeAddresses[0] ? elide(draft.changeAddresses[0], 8, 6) : 'none'}
          </Mono>
        </FactRow>

        <Gap size={space.gap} />
        <Notice title="THIS DEVICE IS NOT PART OF THIS STEP">
          The vault is offline and has no way to tell this wallet what it is showing you. Compare those
          four things against its screen yourself. If any of them differ, refuse it there. Nothing has
          been signed and nothing can be spent.
        </Notice>

        <Gap size={space.section} />
        <Action label="RECEIVE SIGNATURE" onPress={store.readBack} />
      </View>
      <Gap size={space.chapter} />
    </ScrollView>
  );
}

// -------------------------------------------------------------- 5. receiving

/**
 * Reading the signature back.
 *
 * In a build with a vault this is the camera, and the frames arrive the same
 * way they left. There is no vault in this build, so the camera is still
 * offered and a labeled stand-in sits under it — see `demo/standin.ts` for
 * why that exists and what keeps it from becoming the thing this product is
 * against.
 */
export function Receiving({ onBack }: { onBack: () => void }) {
  const store = useStore();
  const draft = store.session.draft;
  const sweep = useSharedValue(0);

  useEffect(() => {
    sweep.value = withRepeat(withTiming(1, { duration: 2200 }), -1, true);
  }, [sweep]);

  const scanline = useAnimatedStyle(() => ({ top: 20 + sweep.value * 200 }));

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Header onBack={onBack} overline="RECEIVE SIGNATURE" title="Point this at the vault" />
      <Gap size={space.gap} />

      <View style={{ paddingHorizontal: space.gutter }}>
        <Panel tone={color.well} style={{ height: 260, alignItems: 'center', justifyContent: 'center' }}>
          <Animated.View
            style={[
              { position: 'absolute', left: 24, right: 24, height: 1, backgroundColor: color.good, opacity: 0.5 },
              scanline,
            ]}
          />
          <ScanIcon size={40} tone={color.slate} />
          <Gap size={space.step} />
          <Label tone={color.slate}>CAMERA</Label>
          <Small tone={color.dim} style={{ marginTop: 6 }}>
            {store.session.capture ? `${store.session.capture.have} frames` : 'Waiting for frames'}
          </Small>
        </Panel>

        <Gap size={space.gap} />
        <Link direction="in" active width={280} />

        <Gap size={space.section} />
        <Notice title="WHAT HAPPENS WHEN IT ARRIVES">
          The signed transaction is checked against the one you approved: the same coins, the same
          destination, the same amount, the same fee. If any of that has changed it will not be
          broadcast, and this device will say so.
        </Notice>

        {/* The stand-in, and it renders only where it can act.
         *
         * `standInVault` already refuses in a release build — it checks `DEMO`
         * and returns null — but a button that silently does nothing is its own
         * kind of lie: a reviewer who taps "RETURN A SIGNATURE" and watches the
         * screen sit there reads a broken app, not a build without a second
         * device. So the controls are gated on the same flag the signer is, and
         * a release build shows only the camera above: the flow stops at the
         * handoff, which is the true thing to show when there is no vault and
         * exactly what `store/wallet/review-notes.md` says happens. */}
        {DEMO && (
          <>
            <Gap size={space.section} />
            <LabelWide tone={color.warn}>STAND-IN VAULT · THIS BUILD HAS NO SECOND DEVICE</LabelWide>
            <Gap size={space.step} />
            <Body tone={color.slate}>
              There is no vault to scan here, so this phone can sign for itself with the seed phrase
              published in BIP84, the one every wallet tests against, which controls nothing. It is the
              only way these last screens can be walked rather than imagined.
            </Body>
            <Gap size={space.step} />
            <Action
              label="RETURN A SIGNATURE"
              onPress={() => draft && store.offerSignature(standInVault(draft, PUBLISHED_TEST_WORDS, 'sign'))}
            />
            <Gap size={space.snug} />
            <Action
              label="RETURN AN ALTERED TRANSACTION"
              quiet
              onPress={() => draft && store.offerSignature(standInVault(draft, PUBLISHED_TEST_WORDS, 'tamper'))}
            />
            <Gap size={space.snug} />
            <Action
              label="RETURN NOTHING"
              quiet
              onPress={() => store.offerSignature(null)}
            />
          </>
        )}
      </View>
      <Gap size={space.chapter} />
    </ScrollView>
  );
}


// --------------------------------------------------------------- 8. mismatch

/**
 * The screen this whole application is arranged around.
 *
 * No amount at the top, because the amount is not the point and reading it
 * first invites the thought "well, it is about right". The point is that these
 * bytes are not the ones that were approved, and the two lists below say
 * exactly what differs.
 *
 * There is no button that broadcasts. Not disabled — absent. The state cannot
 * reach `ready` and the tests say so, so there is nothing here to wire up.
 */
export function Mismatch({ onDiscard }: { onDiscard: () => void }) {
  const store = useStore();
  const verified = store.session.verified;
  const draft = store.session.draft;
  const reasons = verified && !verified.ok ? verified.reasons : [];

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Header overline="STOP" />
      <Gap size={space.gap} />

      <View style={{ paddingHorizontal: space.gutter }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.step }}>
          <CrossIcon size={22} tone={color.alarm} />
          <Title tone={color.alarm}>This is not your transaction</Title>
        </View>

        <Gap size={space.gap} />
        <Body tone={color.bone}>
          What came back from the camera does not match what you approved. It has not been broadcast,
          and this device will not broadcast it.
        </Body>

        <Gap size={space.section} />
        <Label style={{ marginBottom: space.step }}>WHAT DIFFERS</Label>
        {reasons.map((reason, index) => (
          <View key={index} style={{ flexDirection: 'row', gap: space.step, paddingVertical: space.snug }}>
            <View style={{ width: 2, backgroundColor: color.alarm, borderRadius: 1 }} />
            <Body tone={color.bone} style={{ flex: 1 }}>
              {reason}
            </Body>
          </View>
        ))}

        {draft ? (
          <>
            <Gap size={space.section} />
            <Label style={{ marginBottom: space.snug }}>YOU APPROVED</Label>
            <Amount atoms={draft.amount} asset={draft.asset} size="strong" />
            <Gap size={space.snug} />
            <AddressBlock address={draft.recipient} size={13} tone={color.ash} />
          </>
        ) : null}

        {verified && !verified.ok && verified.outputs.length > 0 ? (
          <>
            <Gap size={space.gap} />
            <Label style={{ marginBottom: space.snug }}>WHAT CAME BACK PAYS</Label>
            {verified.outputs.map((output, index) => (
              <View key={index} style={{ paddingVertical: 6 }}>
                <Mono size={13} tone={color.alarm}>
                  {output.address ? elide(output.address, 12, 10) : 'an output with no address'}
                </Mono>
                <Small tone={color.slate}>{output.value.toString()} in the smallest unit</Small>
              </View>
            ))}
          </>
        ) : null}

        <Gap size={space.section} />
        <Notice tone="alarm" title="WHAT TO DO">
          Start again. Build the payment fresh, and watch the vault's screen while it renders the
          transaction. If this happens twice with a transaction you built carefully, stop using this
          wallet on this device until you know why.
        </Notice>

        <Gap size={space.section} />
        <Action label="DISCARD THIS PAYMENT" onPress={onDiscard} />
      </View>
      <Gap size={space.chapter} />
    </ScrollView>
  );
}
