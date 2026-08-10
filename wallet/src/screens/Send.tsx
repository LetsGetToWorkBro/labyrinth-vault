/**
 * The send flow: one screen with eight faces, driven by the state machine.
 *
 * This is the signature interaction of the product and the only place a person
 * meets both halves of the system in one sitting. It is worth reading the
 * shape of it before the code:
 *
 *   COMPOSE     what, and to whom
 *   REVIEW      this device's summary — and a plain statement that this device
 *               cannot sign it
 *   TRANSMIT    frames on the glass, for the vault's camera
 *   AWAITING    nothing. Deliberately, visibly nothing. The vault is showing a
 *               person the transaction and this device is not part of that.
 *   RECEIVE     our camera, reading a signature back
 *   READY       checked, matched, still not broadcast
 *   DONE        broadcast by this device, with a txid
 *
 * and one face that is not on the path:
 *
 *   MISMATCH    what came back is not what was approved. No way forward.
 *
 * ## What each screen is careful about
 *
 * **Review says "this device cannot sign this".** Not "confirm and sign".
 * Every wallet in the world has trained people that the summary screen is the
 * last step, and this one is the *first* — the real approval happens on
 * another device, by reading, and the button therefore says SEND TO VAULT.
 *
 * **Awaiting has no spinner and no progress.** A spinner would be a claim
 * about something this device cannot observe. What it has instead is a list of
 * the four things to check on the vault's screen: amount, destination, fee,
 * change. That list is the security model, printed at the moment it is being
 * used.
 *
 * **Mismatch has no way forward, and that is enforced upstream.** There is no
 * disabled button here, no "I understand the risk". The state cannot broadcast
 * — see `canBroadcast` and the tests around it — so the screen does not offer
 * it. The only exits are discarding the payment and looking at what came back.
 */

import { useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import { Action, ActionRow, Chip, Datum, FactRow, Gap, Notice, Panel, Press, Rule, Screen } from '../design/atoms';
import { Body, Label, LabelWide, Mono, Small, Strong, Title } from '../design/text';
import { Header } from '../components/chrome';
import { AddressBlock, Amount } from '../components/money';
import { Timeline } from '../components/tx';
import { Journey, Link } from '../labyrinth/glyphs';
import { QrCanvas } from '../qr/QrCanvas';
import { CheckIcon, CrossIcon, ScanIcon } from '../components/icons';
import { assetColor, color, radius, space } from '../design/tokens';
import { elide, fiatCents, formatFeeRate, formatFiat, parseAmount } from '../core/units';
import { maxSendable } from '../core/build';
import { checkAddress, readPaymentUri } from '../core/addresses';
import { frameEstimate, FRAME_MS } from '../core/wire';
import { standInVault, PUBLISHED_TEST_WORDS } from '../demo/standin';
import { confirmed, tap } from '../design/haptics';
import { useStore } from '../state/store';
import type { Nav } from '../nav/routes';

export function SendScreen({ navigation }: Nav<'Send'>) {
  const store = useStore();
  const { session, asset } = store;

  const back = () => {
    if (session.step === 'compose') {
      store.send({ type: 'reset' });
      navigation.goBack();
      return;
    }
    store.send({ type: 'back' });
  };

  return (
    <Screen>
      <StatusBar style="light" />
      {session.step === 'compose' ? <Compose onBack={back} /> : null}
      {session.step === 'review' ? <Review onBack={back} /> : null}
      {session.step === 'transmit' ? <Transmit onBack={back} /> : null}
      {session.step === 'awaiting' ? <Awaiting onBack={back} /> : null}
      {session.step === 'receive' ? <Receiving onBack={back} /> : null}
      {session.step === 'ready' || session.step === 'broadcasting' ? <Ready /> : null}
      {session.step === 'done' ? <Done onClose={() => { store.send({ type: 'reset' }); navigation.popToTop(); }} /> : null}
      {session.step === 'mismatch' ? (
        <Mismatch onDiscard={() => { store.send({ type: 'reset' }); navigation.popToTop(); }} />
      ) : null}
      {session.step === 'failed' ? <Failed onBack={back} /> : null}

      {/* Monero's unsigned-set format is a stand-in in this build (see
          `prepareMonero`), and a person walking this flow should know that
          before they are standing in front of a vault with it. */}
      {asset === 'XMR' ? (
        <View style={{ paddingHorizontal: space.gutter, paddingBottom: space.snug }}>
          <Small tone={color.dim}>MONERO · UNSIGNED SET FORMAT IS PROVISIONAL</Small>
        </View>
      ) : null}
    </Screen>
  );
}

// ---------------------------------------------------------------- 1. compose

function Compose({ onBack }: { onBack: () => void }) {
  const store = useStore();
  const { session, asset, snapshot } = store;
  const view = snapshot.assets[asset];
  const [problem, setProblem] = useState<string | null>(null);

  const verdict = useMemo(
    () => (session.compose.recipient ? checkAddress(session.compose.recipient, asset) : null),
    [session.compose.recipient, asset],
  );

  const parsed = parseAmount(session.compose.amountText, asset);
  const fee = view.feeOptions.find((option) => option.key === session.compose.feeKey) ?? view.feeOptions[1]!;
  const ready = Boolean(verdict?.ok) && parsed.ok;

  const paste = async () => {
    const text = await Clipboard.getStringAsync();
    const read = readPaymentUri(text);
    store.send({ type: 'recipient', value: read.address, source: 'pasted' });
    if (read.amount) store.send({ type: 'amount', value: read.amount });
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <Header
        onBack={onBack}
        overline={`SEND ${asset === 'BTC' ? 'BITCOIN' : 'MONERO'}`}
        title="Where is it going?"
        right={
          <View style={{ flexDirection: 'row', gap: space.snug }}>
            {(['BTC', 'XMR'] as const).map((which) => (
              <Chip
                key={which}
                tone={which === asset ? color.void : color.slate}
                fill={which === asset ? assetColor(which) : 'transparent'}
                onPress={() => store.setAsset(which)}
              >
                {which}
              </Chip>
            ))}
          </View>
        }
      />

      <Gap size={space.gap} />

      <View style={{ paddingHorizontal: space.gutter }}>
        <Panel tone={color.well} style={{ padding: space.gap, gap: space.step }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Label>RECIPIENT</Label>
            <View style={{ flex: 1 }} />
            <Press onPress={paste}>
              <Label tone={color.ash}>PASTE</Label>
            </Press>
            <View style={{ width: space.gap }} />
            <Press onPress={() => store.send({ type: 'recipient', value: '', source: null })}>
              <Label tone={color.ash}>CLEAR</Label>
            </Press>
          </View>

          {session.compose.recipient ? (
            <AddressBlock address={session.compose.recipient} size={14} tone={verdict?.ok ? color.bone : color.alarm} />
          ) : (
            <Body tone={color.slate}>Paste an address, or scan one with the camera.</Body>
          )}

          {verdict?.problem ? <Small tone={color.alarm}>{verdict.problem}</Small> : null}
          {verdict?.ok ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <CheckIcon size={13} tone={color.good} />
              <Small tone={color.good}>{verdict.kind ?? 'Valid address'}</Small>
            </View>
          ) : null}
          {verdict?.note ? <Small tone={color.warn}>{verdict.note}</Small> : null}
        </Panel>
      </View>

      <Gap size={space.section} />

      {/* ------------------------------------------------------- the amount */}
      <View style={{ paddingHorizontal: space.gutter, alignItems: 'center' }}>
        <Label>AMOUNT</Label>
        <Gap size={space.step} />
        <Amount
          atoms={parsed.atoms ?? 0n}
          asset={asset}
          size="readout"
          align="center"
          tone={parsed.ok ? color.bone : color.dim}
        />
        <Gap size={space.snug} />
        <Small tone={color.slate}>
          {parsed.ok
            ? formatFiat(fiatCents(parsed.atoms!, asset, snapshot.centsPerUnit[asset]))
            : `Available ${view.spendable === view.balance ? '' : 'to spend '}${formatAvailable(view.spendable, asset)}`}
        </Small>
      </View>

      <Gap size={space.gap} />
      <Keypad
        value={session.compose.amountText}
        onChange={(value) => store.send({ type: 'amount', value })}
        onMax={() => {
          const most = asset === 'BTC' ? maxSendable(view.utxos, fee.rate) : view.balance;
          store.send({ type: 'amount', value: formatAvailable(most, asset, false) });
        }}
      />

      <Gap size={space.gap} />

      {/* ---------------------------------------------------------- the fee */}
      <View style={{ paddingHorizontal: space.gutter }}>
        <Label style={{ marginBottom: space.step }}>FEE</Label>
        <ActionRow>
          {view.feeOptions.map((option) => {
            const chosen = option.key === session.compose.feeKey;
            return (
              <View key={option.key} style={{ flex: 1 }}>
                <Press onPress={() => store.send({ type: 'fee', value: option.key })}>
                  <View
                    style={{
                      paddingVertical: space.step,
                      alignItems: 'center',
                      gap: 4,
                      borderRadius: radius.soft,
                      backgroundColor: chosen ? color.raised : 'transparent',
                      borderWidth: 1,
                      borderColor: chosen ? color.ruleStrong : color.rule,
                    }}
                  >
                    <Label tone={chosen ? color.bone : color.slate}>{option.label}</Label>
                    <Small tone={color.slate}>{about(option.etaMinutes)}</Small>
                    <Small tone={color.dim}>{formatFeeRate(option.rate, asset)}</Small>
                  </View>
                </Press>
              </View>
            );
          })}
        </ActionRow>
      </View>

      <Gap size={space.section} />

      <View style={{ paddingHorizontal: space.gutter }}>
        {problem ? (
          <>
            <Notice tone="warn" title="THIS CANNOT BE BUILT">
              {problem}
            </Notice>
            <Gap size={space.step} />
          </>
        ) : null}
        <Action
          label="REVIEW TRANSACTION"
          disabled={!ready}
          onPress={() => setProblem(store.prepareDraft())}
        />
        <Gap size={space.step} />
        <Body tone={color.slate} style={{ textAlign: 'center' }}>
          Nothing is signed here. This device builds the transaction; your vault approves it.
        </Body>
      </View>
      <Gap size={space.chapter} />
    </ScrollView>
  );
}

/**
 * The keypad.
 *
 * A bespoke pad rather than the system keyboard, for three reasons that are
 * about this application specifically: the amount is the only thing being
 * typed, so a keyboard's other 40 keys are surface area for mistakes; the
 * system keyboard slides a white-ish sheet over half of a screen designed to
 * be dark for a camera; and the pad can carry MAX, which is the control people
 * actually want and which no keyboard has.
 */
function Keypad({
  value,
  onChange,
  onMax,
}: {
  value: string;
  onChange: (value: string) => void;
  onMax: () => void;
}) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'];

  const press = (key: string) => {
    tap('light');
    if (key === '⌫') {
      onChange(value.slice(0, -1));
      return;
    }
    if (key === '.' && value.includes('.')) return;
    if (key === '.' && value === '') {
      onChange('0.');
      return;
    }
    onChange(value + key);
  };

  return (
    <View style={{ paddingHorizontal: space.gutter }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {keys.map((key) => (
          <View key={key} style={{ width: '33.33%' }}>
            <Press onPress={() => press(key)} weight="none">
              <View style={{ height: 58, alignItems: 'center', justifyContent: 'center' }}>
                <Strong tone={key === '⌫' ? color.slate : color.bone} style={{ fontSize: 24, fontWeight: '300' }}>
                  {key}
                </Strong>
              </View>
            </Press>
          </View>
        ))}
      </View>
      <Press onPress={onMax}>
        <View style={{ alignItems: 'center', paddingVertical: space.snug }}>
          <Label tone={color.ash}>SEND EVERYTHING</Label>
        </View>
      </Press>
    </View>
  );
}

// ----------------------------------------------------------------- 2. review

function Review({ onBack }: { onBack: () => void }) {
  const store = useStore();
  const draft = store.session.draft;
  if (!draft) return null;

  const estimate = frameEstimate(draft.unsigned.length);
  const total = draft.amount + draft.fee;

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Header onBack={onBack} overline="REVIEW" title="Before it goes to the vault" />
      <Gap size={space.gap} />

      <View style={{ paddingHorizontal: space.gutter }}>
        <Label>SENDING</Label>
        <Gap size={space.snug} />
        <Amount atoms={draft.amount} asset={draft.asset} size="readout" />
        <Small tone={color.ash} style={{ marginTop: 6 }}>
          {formatFiat(fiatCents(draft.amount, draft.asset, store.snapshot.centsPerUnit[draft.asset]))}
        </Small>

        <Gap size={space.section} />
        <Label style={{ marginBottom: space.snug }}>TO</Label>
        <AddressBlock address={draft.recipient} />

        <Gap size={space.section} />
        <Rule />
        <FactRow label="FEE">
          <Amount atoms={draft.fee} asset={draft.asset} size="strong" />
        </FactRow>
        <FactRow label="TOTAL">
          <Amount atoms={total} asset={draft.asset} size="strong" />
        </FactRow>
        <FactRow label="FEE RATE">{formatFeeRate(draft.feeRate, draft.asset)}</FactRow>
        <FactRow label="COINS SPENT">{`${draft.inputs.length}`}</FactRow>
        <FactRow label="TRANSFER" last>{`${estimate.frames} codes · about ${estimate.seconds}s`}</FactRow>

        <Gap size={space.section} />
        <Notice tone="warn" title="THIS TRANSACTION IS NOT SIGNED">
          This device built it and cannot sign it. Your vault holds the keys, and it will show you the
          amount, the destination, the fee and the change before anything happens. Read that screen — it
          is the one that matters, not this one.
        </Notice>

        <Gap size={space.gap} />
        <View style={{ alignItems: 'center' }}>
          <Link direction="still" active width={280} />
        </View>

        <Gap size={space.section} />
        <Action label="SEND TO VAULT" onPress={store.beginTransmit} />
        <Gap size={space.step} />
        <Action label="DISCARD" quiet onPress={onBack} />
      </View>
      <Gap size={space.chapter} />
    </ScrollView>
  );
}

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
function Transmit({ onBack }: { onBack: () => void }) {
  const store = useStore();
  const transmission = store.session.transmission;
  const [frame, setFrame] = useState(() => transmission?.current() ?? '');
  const [status, setStatus] = useState(() => transmission?.status() ?? { frame: 1, total: 1, laps: 0 });

  useEffect(() => {
    if (!transmission) return;
    const timer = setInterval(() => {
      setFrame(transmission.advance());
      setStatus(transmission.status());
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [transmission]);

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

function Awaiting({ onBack }: { onBack: () => void }) {
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
          {draft ? <Amount atoms={draft.amount} asset={draft.asset} size="strong" /> : <Strong>—</Strong>}
        </FactRow>
        <FactRow label="DESTINATION">
          <Mono size={13}>{draft ? elide(draft.recipient, 10, 8) : '—'}</Mono>
        </FactRow>
        <FactRow label="FEE">
          {draft ? <Amount atoms={draft.fee} asset={draft.asset} size="strong" /> : <Strong>—</Strong>}
        </FactRow>
        <FactRow label="CHANGE" last>
          <Mono size={13}>
            {draft && draft.changeAddresses[0] ? elide(draft.changeAddresses[0], 8, 6) : 'none'}
          </Mono>
        </FactRow>

        <Gap size={space.gap} />
        <Notice title="THIS DEVICE IS NOT PART OF THIS STEP">
          The vault is offline and has no way to tell this wallet what it is showing you. Compare those
          four things against its screen yourself. If any of them differ, refuse it there — nothing has
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
 * offered and a labelled stand-in sits under it — see `demo/standin.ts` for
 * why that exists and what keeps it from becoming the thing this product is
 * against.
 */
function Receiving({ onBack }: { onBack: () => void }) {
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

        <Gap size={space.section} />
        <LabelWide tone={color.warn}>STAND-IN VAULT · THIS BUILD HAS NO SECOND DEVICE</LabelWide>
        <Gap size={space.step} />
        <Body tone={color.slate}>
          There is no vault to scan here, so this phone can sign for itself with the seed phrase
          published in BIP84 — the one every wallet tests against, which controls nothing. It is the
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
      </View>
      <Gap size={space.chapter} />
    </ScrollView>
  );
}

// ------------------------------------------------------------------ 6. ready

function Ready() {
  const store = useStore();
  const { session } = store;
  const draft = session.draft;
  const publishing = session.step === 'broadcasting';
  if (!draft || !session.verified?.ok) return null;

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Header overline="SIGNATURE RECEIVED" title="Ready to broadcast" />
      <Gap size={space.gap} />

      <View style={{ paddingHorizontal: space.gutter }}>
        <Animated.View entering={FadeIn.duration(300)} style={{ gap: space.snug }}>
          {[
            'SIGNATURE RECEIVED',
            'CHECKSUM VERIFIED',
            'TRANSACTION MATCHED',
          ].map((line) => (
            <View key={line} style={{ flexDirection: 'row', alignItems: 'center', gap: space.snug }}>
              <CheckIcon size={14} tone={color.good} />
              <Label tone={color.good}>{line}</Label>
            </View>
          ))}
        </Animated.View>

        <Gap size={space.section} />
        <Amount atoms={draft.amount} asset={draft.asset} size="readout" />
        <Gap size={space.gap} />
        <Label style={{ marginBottom: space.snug }}>TO</Label>
        <AddressBlock address={draft.recipient} />

        <Gap size={space.section} />
        <Rule />
        <FactRow label="FEE">
          <Amount atoms={session.verified.fee} asset={draft.asset} size="strong" />
        </FactRow>
        <FactRow label="TRANSACTION" last>
          <Mono size={13}>{elide(session.verified.txid, 8, 8)}</Mono>
        </FactRow>

        <Gap size={space.gap} />
        <Notice tone="good" title="NOTHING HAS BEEN PUBLISHED YET">
          The vault signed this and handed it back. It has no network and did not send it anywhere. This
          device is the one that broadcasts, and it has not yet.
        </Notice>

        <Gap size={space.section} />
        <Action
          label={publishing ? 'BROADCASTING…' : 'BROADCAST'}
          disabled={publishing}
          onPress={store.broadcast}
        />
      </View>
      <Gap size={space.chapter} />
    </ScrollView>
  );
}

// ------------------------------------------------------------------- 7. done

function Done({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const { session } = store;
  const draft = session.draft;

  useEffect(() => {
    confirmed();
  }, []);

  if (!draft || !session.txid) return null;

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Header overline="BROADCAST COMPLETE" title="It is on the network" />
      <Gap size={space.gap} />

      <View style={{ alignItems: 'center' }}>
        <Journey reached={5} size={190} />
      </View>

      <Gap size={space.gap} />
      <View style={{ paddingHorizontal: space.gutter }}>
        <Amount atoms={draft.amount} asset={draft.asset} size="readout" />
        <Small tone={color.slate} style={{ marginTop: 6 }}>
          to {elide(draft.recipient, 10, 8)}
        </Small>

        <Gap size={space.section} />
        <Label style={{ marginBottom: space.snug }}>TXID</Label>
        <Mono size={13} tone={color.bone}>
          {session.txid.slice(0, 32)}
        </Mono>
        <Mono size={13} tone={color.bone}>
          {session.txid.slice(32)}
        </Mono>

        <Gap size={space.section} />
        <Timeline reached={5} now={store.now} times={{ broadcast: session.since }} />

        <Gap size={space.section} />
        <Notice title="BROADCAST BY THIS DEVICE">
          Your vault signed it and never touched a network. This wallet published it. Confirmations will
          appear in the activity list as blocks arrive.
        </Notice>

        <Gap size={space.section} />
        <Action label="DONE" onPress={onClose} />
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
function Mismatch({ onDiscard }: { onDiscard: () => void }) {
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

// ----------------------------------------------------------------- 9. failed

function Failed({ onBack }: { onBack: () => void }) {
  const store = useStore();
  const signed = store.session.verified?.ok === true;

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Header overline={signed ? 'NOT PUBLISHED' : 'NO SIGNATURE'} />
      <Gap size={space.gap} />
      <View style={{ paddingHorizontal: space.gutter }}>
        <Title>{signed ? 'This did not reach a node' : 'The vault did not return a signature'}</Title>
        <Gap size={space.gap} />
        <Body>{store.session.problem}</Body>

        <Gap size={space.section} />
        <Notice tone="warn" title={signed ? 'THE TRANSACTION IS STILL GOOD' : 'NOTHING WAS SIGNED'}>
          {signed
            ? 'It is signed and this device still has it. Try broadcasting again — there is no need to go back to the vault.'
            : 'No signature came back, so nothing can be spent. Show the codes to the vault again when you are ready.'}
        </Notice>

        <Gap size={space.section} />
        <Action label={signed ? 'TRY BROADCASTING AGAIN' : 'TRY AGAIN'} onPress={onBack} />
      </View>
      <Gap size={space.chapter} />
    </ScrollView>
  );
}

// ---------------------------------------------------------------- small bits

function formatAvailable(atoms: bigint, asset: 'BTC' | 'XMR', withTicker = true): string {
  const units = asset === 'BTC' ? 100_000_000n : 1_000_000_000_000n;
  const places = asset === 'BTC' ? 8 : 12;
  const whole = atoms / units;
  const fraction = (atoms % units).toString().padStart(places, '0').replace(/0+$/, '');
  const text = fraction ? `${whole}.${fraction}` : `${whole}`;
  return withTicker ? `${text} ${asset}` : text;
}

function about(minutes: number): string {
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `~${hours} hr`;
}
