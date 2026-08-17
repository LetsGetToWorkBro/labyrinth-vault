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

import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import { Action, ActionRow, Chip, FactRow, Gap, Notice, Panel, Press, Rule, Screen } from '../design/atoms';
import { Body, Label, Mono, Small, Strong, Title } from '../design/text';
import { Header } from '../components/chrome';
import { AddressBlock, Amount } from '../components/money';
import { Timeline } from '../components/tx';
import { Journey, Link } from '../labyrinth/glyphs';
import { CheckIcon } from '../components/icons';
import { assetColor, color, radius, space } from '../design/tokens';
import { elide, fiatCents, formatFeeRate, formatFiat, hasPrice, parseAmount } from '../core/units';
import { maxSendable } from '../core/build';
import { checkAddress, readPaymentUri } from '../core/addresses';
import { frameEstimate } from '../core/wire';
import { tap } from '../design/haptics';
import { useStore } from '../state/store';
import { Awaiting, Mismatch, Receiving, Transmit } from './SendHandoff';
import { Signing } from './SendSigning';
import type { Nav } from '../nav/routes';

export function SendScreen({ navigation }: Nav<'Send'>) {
  const store = useStore();
  const { session, asset } = store;

  const back = () => {
    if (session.step === 'compose') {
      store.send({ type: 'reset' });
      store.endSession();
      navigation.goBack();
      return;
    }
    /* Stepping back off the transmit screen means the codes are no longer on
     * the glass, so the wallet stops saying a session is in progress. */
    if (session.step === 'transmit' || session.step === 'awaiting') store.endSession();
    store.send({ type: 'back' });
  };

  return (
    <Screen>
      <StatusBar style="light" />
      {session.step === 'compose' ? <Compose onBack={back} navigation={navigation} /> : null}
      {session.step === 'review' ? <Review onBack={back} /> : null}
      {session.step === 'transmit' ? <Transmit onBack={back} /> : null}
      {session.step === 'signing' ? <Signing onBack={back} /> : null}
      {session.step === 'awaiting' ? <Awaiting onBack={back} /> : null}
      {session.step === 'receive' ? <Receiving onBack={back} /> : null}
      {session.step === 'ready' || session.step === 'broadcasting' ? <Ready /> : null}
      {session.step === 'done' ? (
        <Done
          onClose={() => {
            store.send({ type: 'reset' });
            store.endSession();
            navigation.popToTop();
          }}
        />
      ) : null}
      {session.step === 'mismatch' ? (
        <Mismatch
          onDiscard={() => {
            store.send({ type: 'reset' });
            store.endSession();
            navigation.popToTop();
          }}
        />
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

function Compose({ onBack, navigation }: { onBack: () => void; navigation: Nav<'Send'>['navigation'] }) {
  const store = useStore();
  const { session, asset, snapshot, vault } = store;
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
            <Press onPress={() => void paste()}>
              <Label tone={color.ash}>PASTE</Label>
            </Press>
            <View style={{ width: space.gap }} />
            <Press onPress={() => navigation.navigate('Scan', { purpose: 'address' })}>
              <Label tone={color.ash}>SCAN</Label>
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
          {session.compose.source === 'scanned' ? <Small tone={color.slate}>Scanned. Check it anyway.</Small> : null}

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
        <Small tone={parsed.ok || !session.compose.amountText ? color.slate : color.warn}>
          {parsed.ok
            ? /* The line under a valid amount is its dollar figure when a
               * price is known and what remains spendable when none is, which
               * is every live-node session. The second is the more useful
               * sentence anyway; the first only exists where it can be true. */
              hasPrice(snapshot.centsPerUnit[asset])
              ? formatFiat(fiatCents(parsed.atoms!, asset, snapshot.centsPerUnit[asset]))
              : `Available ${view.spendable === view.balance ? '' : 'to spend '}${formatAvailable(view.spendable, asset)}`
            : session.compose.amountText
              ? /* Typing nine decimal places into a chain that has eight is not
                 * an error worth a red field, but silence leaves somebody
                 * pressing a key that does nothing. */
                parsed.problem
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
        {vault.state === 'unpaired' ? (
          <>
            {/* Not an error, and not a dead end either. Three quarters of this
                application works with no vault anywhere near it, and saying so
                plainly is the difference between a limitation and a fault. */}
            <Notice title="SIGNING NEEDS YOUR VAULT">
              This wallet can watch your balances, show your history and receive funds without it. It cannot
              sign, and it was built not to be able to.
            </Notice>
            <Gap size={space.step} />
            <Action label="CONNECT YOUR VAULT" onPress={() => navigation.navigate('Pair')} />
            <Gap size={space.step} />
            <Action label="BUILD IT ANYWAY" quiet disabled={!ready} onPress={() => void store.prepareDraft().then(setProblem)} />
            <Gap size={space.step} />
            <Body tone={color.slate} style={{ textAlign: 'center' }}>
              A transaction can be prepared now and shown to a vault later. Nothing about it is secret.
            </Body>
          </>
        ) : (
          <>
            <Action
              label="REVIEW TRANSACTION"
              disabled={!ready}
              onPress={() => void store.prepareDraft().then(setProblem)}
            />
            <Gap size={space.step} />
            <Body tone={color.slate} style={{ textAlign: 'center' }}>
              Nothing is signed here. This device builds the transaction; your vault approves it.
            </Body>
          </>
        )}
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

  /* The account being paid from, which is the one being looked at.
   *
   * `some((a) => a.signsHere)` was the earlier version and it asked the wrong
   * question: whether *any* account signs here. On a phone watching a vault
   * and a hot wallet at once that answers yes for both, so the vault's own
   * payment would have been offered a SIGN ON THIS PHONE button. Reading the
   * selected account is what makes the answer about this payment. */
  const account = store.accounts.find((entry) => entry.id === store.selectedAccount) ?? null;
  const signsHere = account?.signsHere === true;

  if (!draft) return null;

  const estimate = frameEstimate(draft.unsigned.length);
  const total = draft.amount + draft.fee;

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Header
        onBack={onBack}
        overline={account ? `REVIEW · ${account.label.toUpperCase()}` : 'REVIEW'}
        title={signsHere ? 'Before this phone signs it' : 'Before it goes to the vault'}
      />
      <Gap size={space.gap} />

      <View style={{ paddingHorizontal: space.gutter }}>
        <Label>SENDING</Label>
        <Gap size={space.snug} />
        <Amount atoms={draft.amount} asset={draft.asset} size="readout" />
        {hasPrice(store.snapshot.centsPerUnit[draft.asset]) ? (
          <Small tone={color.ash} style={{ marginTop: 6 }}>
            {formatFiat(fiatCents(draft.amount, draft.asset, store.snapshot.centsPerUnit[draft.asset]))}
          </Small>
        ) : null}

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
        <FactRow label="COINS SPENT">
          {`${draft.asset === 'XMR' ? draft.spentKeys?.length ?? 0 : draft.inputs.length}`}
        </FactRow>
        {draft.asset === 'XMR' ? (
          /* The ring is stated here because this device chose the decoys.
             Privacy, not custody: a bad ring cannot move money, and the vault
             will say the same thing in the same words. */
          <FactRow label="RING">{'16 members · 15 decoys per coin'}</FactRow>
        ) : null}
        <FactRow label="TRANSFER" last>{`${estimate.frames} codes · about ${estimate.seconds}s`}</FactRow>

        <Gap size={space.section} />
        {/* Two entirely different sentences, and which one shows is read from
            the account rather than from what this phone happens to be holding.
            A phone with a seed on it and a vault paired sees the vault sentence
            for the vault's account, because `canSignHere` says so and the
            interface has to agree with it. */}
        {signsHere ? (
          <Notice tone="warn" title="THIS PHONE HOLDS THE KEYS FOR THIS ACCOUNT">
            It will sign this itself, after Face ID. Nothing crosses to a vault, and nothing about
            this payment is reviewed on a second screen: this one is the only screen. Read it
            properly, because it is doing the job the vault&apos;s screen does on the other path.
          </Notice>
        ) : (
          <Notice tone="warn" title="THIS TRANSACTION IS NOT SIGNED">
            This device built it and cannot sign it. Your vault holds the keys, and it will show you the
            amount, the destination, the fee and the change before anything happens. Read that screen. It
            is the one that matters, not this one.
          </Notice>
        )}

        <Gap size={space.gap} />
        <View style={{ alignItems: 'center' }}>
          <Link direction="still" active width={280} />
        </View>

        <Gap size={space.section} />
        {signsHere ? (
          <Action label="SIGN ON THIS PHONE" onPress={() => void store.signOnThisDevice()} />
        ) : (
          <Action label="SEND TO VAULT" onPress={store.beginTransmit} />
        )}
        <Gap size={space.step} />
        <Action label="DISCARD" quiet onPress={onBack} />
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

  /* No haptic here. `broadcast()` already fired one when the node accepted it,
   * and a second identical buzz as this screen mounts reads as a stutter
   * rather than as a second event. */
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
          Your vault signed it and never touched a network. This wallet published it. In a build with a
          node behind it, confirmations would start arriving here within the hour.
        </Notice>

        <Gap size={space.section} />
        <Action label="DONE" onPress={onClose} />
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
            ? 'It is signed and this device still has it. Try broadcasting again. There is no need to go back to the vault.'
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
