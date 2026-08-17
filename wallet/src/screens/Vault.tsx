/**
 * The vault screen, and the security center.
 *
 * ## The hardest thing to get right in the product
 *
 * Every instinct in interface design says to draw this as a connection: two
 * devices, a line, a green dot, "Connected". That would be a lie, and it is
 * the specific lie that gets people hurt, because a person who believes there
 * is a live link will not understand why signing needs them to walk to a
 * drawer — and, worse, will believe the wallet would *know* if something were
 * wrong with the vault. It would not. It has never been able to reach it.
 *
 * So the language here is deliberate throughout. PAIRED, not connected. READY,
 * meaning this wallet holds an account key and can build something the vault
 * will understand. LAST SESSION, a past tense, because that is the only tense
 * this device can honestly use about the other one.
 *
 * The one exception is `IN SESSION`, during a handoff, and even that means
 * "codes are on a screen right now" rather than "a link is open".
 *
 * ## The security center
 *
 * Four statements, in the order somebody would ask them, and each one is a
 * fact about this build rather than a reassurance. The last is the one most
 * wallets would never print: this device has a network, an app store and
 * several hundred dependencies, and that is exactly why the keys are not on
 * it.
 */

import { ScrollView, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Action, Chip, Dot, FactRow, Gap, Notice, Panel, Rule, Screen } from '../design/atoms';
import { Body, Label, LabelWide, Mono, Small, Title } from '../design/text';
import { Header, SectionHead } from '../components/chrome';
import { Link, Mark } from '../labyrinth/glyphs';
import { color, space } from '../design/tokens';
import { useState } from 'react';
import { elide, sessionTime } from '../core/units';
import { DEMO } from '../demo/standin';
import { useStore } from '../state/store';
import type { Nav } from '../nav/routes';

export function VaultScreen({ navigation }: Nav<'Vault'>) {
  const store = useStore();
  const { vault, now } = store;
  const paired = vault.state !== 'unpaired';
  const [syncNote, setSyncNote] = useState<string | null>(null);

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView showsVerticalScrollIndicator={false}>
        <Header
          onBack={() => navigation.goBack()}
          overline="THE OTHER HALF"
          right={<Chip tone={paired ? color.good : color.slate}>{paired ? 'PAIRED' : 'NOT PAIRED'}</Chip>}
        />

        <Gap size={space.gap} />
        <View style={{ alignItems: 'center', paddingHorizontal: space.gutter }}>
          <Mark size={44} tone={paired ? color.bone : color.slate} weight={1.4} />
          <Gap size={space.gap} />
          <Title>{paired ? 'Labyrinth Vault' : 'No vault yet'}</Title>
          <Gap size={space.snug} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.snug }}>
            <Dot state={vault.state === 'in-session' ? 'working' : paired ? 'ready' : 'offline'} />
            <Label tone={paired ? color.bone : color.slate}>
              {vault.state === 'in-session' ? 'IN SESSION' : paired ? 'AIRGAPPED · SIGNING READY' : 'NOTHING PAIRED'}
            </Label>
          </View>

          <Gap size={space.section} />
          <Link direction={vault.state === 'in-session' ? 'out' : 'still'} active={paired} width={300} />
        </View>

        <Gap size={space.section} />
        <View style={{ paddingHorizontal: space.gutter }}>
          {paired ? (
            <>
              <SectionHead>THIS PAIRING</SectionHead>
              <Rule />
              <FactRow label="DEVICE">{vault.label}</FactRow>
              <FactRow label="PAIRED">{sessionTime(vault.pairedAt, now)}</FactRow>
              <FactRow label="LAST SESSION">
                {vault.lastSession ? sessionTime(vault.lastSession, now) : 'never'}
              </FactRow>
              {/* The pairing's key, not the selection's.
                  `store.selectedAccountKey` is the account key of whichever account
                  the app is looking at, so with a vault paired and the wallet
                  on this phone selected, this row printed that wallet's own
                  zpub under the heading THIS PAIRING. Two things wrong at
                  once: a false statement about where a key came from, and an
                  invitation to hand out the one string that links every
                  address of the hot wallet to every other. */}
              <FactRow label="ACCOUNT KEY" last>
                <Mono size={13}>
                  {store.pairing?.btc
                    ? elide(store.pairing.btc.zpub, 10, 8)
                    : store.pairing?.xmr
                      ? 'MONERO ONLY'
                      : 'NOT PAIRED'}
                </Mono>
              </FactRow>

              <Gap size={space.gap} />
              <Notice title="THERE IS NO CONNECTION HERE">
                This wallet cannot reach your vault and never could. "Paired" means it holds the watch-only
                key your vault exported, and knows how to draw codes the vault can read. Whether the vault
                is charged, present, or in one piece is not something this device can tell you.
              </Notice>

              <Gap size={space.section} />
              <SectionHead>MONERO SPENDS</SectionHead>
              <Gap size={8} />
              <Small>
                The vault computes one key image per payment this wallet found, and with them the wallet
                can subtract what you have spent from what arrived. Without them the Monero figure is
                what arrived, and says so.
              </Small>
              <Gap size={8} />
              {store.moneroStatus ? (
                <Small tone={color.slate}>
                  {`${store.moneroStatus.images} of ${store.moneroStatus.outputs} payments have a key image · ${store.moneroStatus.spentOutputs} known spent`}
                </Small>
              ) : (
                <Small tone={color.slate}>Nothing scanned yet. Set a Monero node first.</Small>
              )}
              <Gap size={8} />
              {/* Offered whenever a vault is paired, which the branch above
                  already establishes. This used to be hidden while the app was
                  showing fixture data, a gate that stopped meaning what it
                  said the moment the fixture went: the screens behind these
                  levers say for themselves when nothing has been scanned yet,
                  which is the better place for that sentence anyway. */}
              <Action label="SHOW OUTPUTS TO VAULT" quiet onPress={() => navigation.navigate('KeyImages')} />
              <Gap size={space.snug} />
              {/* Read only, and labelled so. This hands the vault a file
                  another Monero wallet wrote so it can say what is in it;
                  no signature comes back, because a wallet2 file is the
                  sending wallet describing itself and a signature has to
                  be over what the vault re-derived. The screen says the
                  same thing at more length. */}
              <Action label="SHOW A MONERO FILE (READ ONLY)" quiet onPress={() => navigation.navigate('MoneroFile')} />
              <Gap size={space.snug} />
              {/* The stand-in's lever renders only where the stand-in can
                  act. In a release build the signer behind this is
                  compiled out, and a control whose only possible answer
                  is "this does not exist here" is chrome pretending to be
                  a feature. Same gate, same reasoning, as the stand-in
                  vault controls on the send flow. */}
              {DEMO ? (
                <>
                  <Action
                    label="SYNC WITH THE STAND-IN (DEMO)"
                    quiet
                    onPress={() => setSyncNote(store.syncStandInKeyImages().note)}
                  />
                  <Gap size={space.snug} />
                </>
              ) : null}
              {syncNote ? (
                <>
                  <Small tone={color.slate}>{syncNote}</Small>
                  <Gap size={space.snug} />
                </>
              ) : null}

              <Gap size={space.gap} />
              <Action label="START A SESSION" onPress={() => navigation.navigate('Pair')} />
              <Gap size={space.snug} />
              <Action label="SECURITY" quiet onPress={() => navigation.navigate('Security')} />
              <Gap size={space.snug} />
              {/* Forgetting costs nothing and can be undone by scanning the
                  vault again, because what is being forgotten is a public key.
                  A wallet that will not let go of one is keeping it for its own
                  convenience. */}
              <Action label="FORGET THIS VAULT" quiet onPress={store.unpairVault} />
            </>
          ) : (
            <>
              <Notice tone="warn" title="VAULT NOT FOUND">
                Scan the QR code your vault shows when it exports a watch-only key. Until then this wallet
                has nothing to watch and nothing to spend.
              </Notice>
              <Gap size={space.section} />
              <Action label="CONNECT VAULT" onPress={() => navigation.navigate('Pair')} />
            </>
          )}

          <Gap size={space.section} />
          <SectionHead>WHAT EACH HALF DOES</SectionHead>
          {/* `hot` rather than the selected account, because this panel is
              about the two devices rather than about one account: the question
              it answers is "what does the phone in my hand do", and on a phone
              holding a seed the answer is not "holds no keys" no matter which
              row happens to be selected. 130 lines below this, `SecurityScreen`
              was made conditional for exactly this reason. */}
          <Halves anyKeysHere={store.hot !== null} />

          {/* The note that used to live here described the fixture: "the state
              above is a fixture, and the send flow signs for itself with a
              published test key". There is no fixture any more. What is left of
              that idea is the stand-in signer, which is gated on DEMO and says
              so at its own control. */}
        </View>
        <Gap size={space.chapter} />
      </ScrollView>
    </Screen>
  );
}

function Halves({ anyKeysHere }: { anyKeysHere: boolean }) {
  return (
    <View style={{ flexDirection: 'row', gap: space.step }}>
      <Panel style={{ flex: 1, padding: space.gap, gap: space.snug }}>
        <Label tone={color.bone}>THIS WALLET</Label>
        <Small tone={color.slate}>Online</Small>
        <Gap size={space.snug} />
        {[
          'Watches the chain',
          'Builds payments',
          'Broadcasts',
          anyKeysHere ? 'Holds keys for one wallet' : 'Holds no keys',
        ].map((line) => (
          <Small key={line} tone={color.ash}>
            {line}
          </Small>
        ))}
      </Panel>
      <Panel style={{ flex: 1, padding: space.gap, gap: space.snug }}>
        <Label tone={color.bone}>THE VAULT</Label>
        <Small tone={color.slate}>Offline</Small>
        <Gap size={space.snug} />
        {['Holds the keys', 'Shows you the payment', 'Signs, if you approve', 'Never touches a network'].map((line) => (
          <Small key={line} tone={color.ash}>
            {line}
          </Small>
        ))}
      </Panel>
    </View>
  );
}

// ------------------------------------------------------------------ pairing

/**
 * A session, which is two people-shaped steps and no handshake.
 *
 * The screen shows this wallet's side of the conversation: what it is about to
 * ask for, and the code the vault should be looking at. There is no "searching
 * for device" state, because nothing is being searched for.
 */
export function PairScreen({ navigation }: Nav<'Pair'>) {
  const store = useStore();

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView showsVerticalScrollIndicator={false}>
        <Header onBack={() => navigation.goBack()} overline="VAULT SESSION" title="Two steps, by hand" />
        <Gap size={space.gap} />

        <View style={{ paddingHorizontal: space.gutter }}>
          <Step
            number="01"
            title="On the vault"
            body="Open Labyrinth Vault, choose Export Watch-Only, and let it draw its codes. It will show an account key, a public one. It never shows a private key, and there is no screen in it that could."
          />
          <Step
            number="02"
            title="On this phone"
            body="Point the camera at the vault until every frame is read. The wallet checks the payload against its own digest before it accepts anything; a scan that does not add up is thrown away rather than half-imported."
          />

          <Gap size={space.gap} />
          {/* There was a QR code here that said "show this to the vault to
              identify this wallet". It was not a code any vault would accept:
              the digest was zeroes, and `ACCOUNT` is a payload the vault sends
              *to* a wallet, not one it reads. Nothing in the protocol needs
              this wallet to identify itself, because the vault does not choose
              who it exports to. A picture that only looks like a step is worse
              than no picture. */}
          <Notice title="THIS WALLET SENDS NOTHING FIRST">
            There is no handshake to start. The vault decides what to export and shows it; this phone
            reads it. Nothing about this device needs to reach the vault for that to work, which is why
            there is no code on this screen to show it.
          </Notice>

          <Gap size={space.section} />
          <Action label="OPEN CAMERA" onPress={() => navigation.navigate('Scan')} />
          {/* Development builds get a second lever that pairs with the
              stand-in, through the same acceptance path a scanned export
              takes. In release the stand-in is compiled out and this button
              would pair with nothing, silently, which reads as a broken app
              rather than as a build without a second device; the camera above
              is the whole of pairing there. */}
          {DEMO ? (
            <>
              <Gap size={space.snug} />
              <Action
                label="PAIR WITH A STAND-IN (DEMO)"
                quiet
                onPress={() => {
                  store.pairVault('VAULT · iPhone 11');
                  navigation.goBack();
                }}
              />
            </>
          ) : null}

          <Gap size={space.section} />
          <Notice title="WHAT CROSSES">
            An extended public key, or a Monero view key and address. Both are things you could publish on
            a noticeboard: they see money arriving and cannot move it.
          </Notice>
        </View>
        <Gap size={space.chapter} />
      </ScrollView>
    </Screen>
  );
}

function Step({ number, title, body }: { number: string; title: string; body: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: space.gap, paddingVertical: space.gap }}>
      <Label tone={color.slate} style={{ width: 24, marginTop: 3 }}>
        {number}
      </Label>
      <View style={{ flex: 1, gap: 6 }}>
        <LabelWide tone={color.bone}>{title.toUpperCase()}</LabelWide>
        <Body>{body}</Body>
      </View>
    </View>
  );
}

// ---------------------------------------------------------- security center

export function SecurityScreen({ navigation }: Nav<'Security'>) {
  const { vault, now, hot, forgetHotKeys } = useStore();
  /*
   * Forgetting, in two taps, with the cost printed between them.
   *
   * `forgetHotKeys` was written, documented and exported, and no screen called
   * it. Two places told people to use it: `Backup.tsx` refuses a second wallet
   * with "forget the wallet on this phone first", and the Nodes screen's
   * FORGET EVERYTHING STORED button cleared the node file and neither keychain
   * item. Both were dead ends, and one of them read as a wipe that had not
   * happened.
   *
   * Not a route, because the thing being confirmed is one sentence long and a
   * screen push would be somewhere a back gesture can strand a half-made
   * decision. Not a system alert either: the sentence that matters here is
   * three lines and an alert would truncate it into "are you sure".
   */
  const [asking, setAsking] = useState(false);
  const [forgetting, setForgetting] = useState(false);

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView showsVerticalScrollIndicator={false}>
        <Header onBack={() => navigation.goBack()} overline="SECURITY" title="How this is arranged" />
        <Gap size={space.gap} />

        <View style={{ paddingHorizontal: space.gutter }}>
          {/* Two different true statements, and which one is shown is read
              from what is actually stored rather than from what this app used
              to be. Until there was a key store, this screen said no key had
              ever been generated on this phone, full stop. That sentence was
              the product, and it is now conditional: it is still true of a
              wallet that only watches a vault, and false the moment somebody
              makes a hot wallet. A security screen that kept printing the
              stronger claim would be the worst copy in the application. */}
          {hot === null ? (
            <Statement label="PRIVATE KEYS" value="VAULT ONLY" tone={color.good}>
              No key or seed phrase is stored on this phone. It watches accounts that are signed
              for on a device with no network on it, and that is the whole design.
            </Statement>
          ) : (
            <Statement label="PRIVATE KEYS" value="SOME ON THIS PHONE" tone={color.warn}>
              This phone holds a spending seed for one wallet, in the keychain, under the device
              passcode, and asks for Face ID before every signature. That is protection by the
              device rather than by something you know, and it is a real reduction against the
              vault. Anything worth more than this phone belongs on the other half.
            </Statement>
          )}

          <Statement
            label="ACCOUNTS PAIRED FROM A VAULT"
            value="WATCH-ONLY, ALWAYS"
            tone={color.good}
          >
            Unchanged by any of the above, and unchangeable. An account paired from a vault cannot
            be signed for on this device even while a seed for a different wallet is sitting in this
            phone's keychain. The two are unrelated wallets and this half refuses to confuse them.
          </Statement>

          <Statement label="THIS WALLET" value="WATCH AND BROADCAST" tone={color.bone}>
            It derives addresses from a public key, reads the chain, builds unsigned transactions and
            publishes signed ones. Every one of those is something a stranger could do with your account
            key. None of them can move money.
          </Statement>

          <Statement label="NETWORK" value="ENABLED" tone={color.warn}>
            This half is online, on purpose. It also runs on a phone with an app store, a browser and
            several hundred dependencies underneath it. That is not a flaw in the design. It is the
            reason the keys live somewhere else.
          </Statement>

          <Statement
            label="LAST VERIFIED SESSION"
            value={vault.state === 'unpaired' ? 'NONE' : vault.lastVerified ? sessionTime(vault.lastVerified, now) : 'NONE'}
            tone={color.slate}
          >
            The last time a signature came back from the vault and matched the transaction this device had
            prepared. A handoff that ended in a mismatch is not one of these, and does not move this line.
          </Statement>

          <Gap size={space.gap} />
          <Notice tone="alarm" title="WHAT THIS CANNOT PROTECT YOU FROM">
            A person who approves a payment on the vault without reading it. The vault renders the amount,
            the destination and the fee precisely so that a compromised wallet cannot pay somebody else
            quietly, but nothing in either half substitutes for reading that screen.
          </Notice>

          <Gap size={space.section} />
          <SectionHead>KEYS ON THIS PHONE</SectionHead>
          <Gap size={space.step} />
          {hot === null ? (
            <>
              <Small tone={color.dim}>
                A wallet this phone can spend from, for the amounts that are not worth a walk to
                the vault. The words go on paper before anything is stored.
              </Small>
              <Gap size={space.step} />
              <Action label="MAKE A WALLET" quiet onPress={() => navigation.navigate('CreateWallet')} />
              <Gap size={space.snug} />
              <Action label="RESTORE FROM WORDS" quiet onPress={() => navigation.navigate('Restore')} />
            </>
          ) : (
            <>
              <Small tone={color.dim}>
                The words that restore this wallet are the only backup of it that exists.
              </Small>
              <Gap size={space.step} />
              <Action label="SHOW THE RECOVERY WORDS" quiet onPress={() => navigation.navigate('Backup')} />
              <Gap size={space.snug} />
              <Action label="RESTORE ANOTHER CHAIN" quiet onPress={() => navigation.navigate('Restore')} />
              <Gap size={space.snug} />
              {asking ? (
                <>
                  {/* `forget` rather than `delete`, the word `keyvault.ts`
                      chose and for its reason: the coins stay on the chain and
                      the words on paper still restore them. A screen saying
                      "delete wallet" invites somebody to believe they
                      destroyed something they did not, and then to stop
                      looking after the paper. */}
                  <Notice tone="alarm" title="THE WORDS ARE THE ONLY WAY BACK">
                    This removes the seed for this wallet from the keychain. Nothing on the chain
                    changes and the words you wrote down still restore it anywhere. If they are not
                    written down, there is no other copy of them on this phone or anywhere else.
                  </Notice>
                  <Gap size={space.step} />
                  <Action
                    label={forgetting ? 'FORGETTING…' : 'YES, FORGET THE KEYS'}
                    tone={color.alarm}
                    disabled={forgetting}
                    onPress={() => {
                      setForgetting(true);
                      void forgetHotKeys().finally(() => {
                        setForgetting(false);
                        setAsking(false);
                      });
                    }}
                  />
                  <Gap size={space.snug} />
                  <Action label="KEEP THEM" quiet disabled={forgetting} onPress={() => setAsking(false)} />
                </>
              ) : (
                <Action label="FORGET THE KEYS ON THIS PHONE" quiet onPress={() => setAsking(true)} />
              )}
            </>
          )}

          <Gap size={space.section} />
          <Action label="THE VAULT" quiet onPress={() => navigation.navigate('Vault')} />
        </View>
        <Gap size={space.chapter} />
      </ScrollView>
    </Screen>
  );
}

function Statement({
  label,
  value,
  tone,
  children,
}: {
  label: string;
  value: string;
  tone: string;
  children: string;
}) {
  return (
    <View style={{ paddingVertical: space.gap, gap: space.snug }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.step }}>
        <Label>{label}</Label>
        <View style={{ flex: 1 }} />
        <Label tone={tone}>{value}</Label>
      </View>
      <Body>{children}</Body>
      <Gap size={space.snug} />
      <Rule />
    </View>
  );
}
