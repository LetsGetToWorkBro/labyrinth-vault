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
import { QrCanvas } from '../qr/QrCanvas';
import { color, space } from '../design/tokens';
import { elide, sessionTime } from '../core/units';
import { DEMO_ZPUB } from '../core/demo';
import { useStore } from '../state/store';
import type { Nav } from '../nav/routes';

export function VaultScreen({ navigation }: Nav<'Vault'>) {
  const { vault, now, snapshot } = useStore();
  const paired = vault.state !== 'unpaired';

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
              <FactRow label="ACCOUNT KEY" last>
                <Mono size={13}>{elide(DEMO_ZPUB, 10, 8)}</Mono>
              </FactRow>

              <Gap size={space.gap} />
              <Notice title="THERE IS NO CONNECTION HERE">
                This wallet cannot reach your vault and never could. "Paired" means it holds the watch-only
                key your vault exported, and knows how to draw codes the vault can read. Whether the vault
                is charged, present, or in one piece is not something this device can tell you.
              </Notice>

              <Gap size={space.section} />
              <Action label="START A SESSION" onPress={() => navigation.navigate('Pair')} />
              <Gap size={space.snug} />
              <Action label="SECURITY" quiet onPress={() => navigation.navigate('Security')} />
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
          <Halves />

          {snapshot.demo ? (
            <>
              <Gap size={space.gap} />
              <Small tone={color.dim}>
                This build has no vault to pair with. The state above is a fixture, and the send flow signs
                for itself with a published test key so the screens after the handoff can be walked.
              </Small>
            </>
          ) : null}
        </View>
        <Gap size={space.chapter} />
      </ScrollView>
    </Screen>
  );
}

function Halves() {
  return (
    <View style={{ flexDirection: 'row', gap: space.step }}>
      <Panel style={{ flex: 1, padding: space.gap, gap: space.snug }}>
        <Label tone={color.bone}>THIS WALLET</Label>
        <Small tone={color.slate}>Online</Small>
        <Gap size={space.snug} />
        {['Watches the chain', 'Builds payments', 'Broadcasts', 'Holds no keys'].map((line) => (
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
          <View style={{ alignItems: 'center' }}>
            <QrCanvas value="LV1:ACCOUNT:1:1:00000000:REQUEST" size={200} level="Q" />
            <Gap size={space.step} />
            <Label tone={color.slate}>SHOW THIS TO THE VAULT TO IDENTIFY THIS WALLET</Label>
          </View>

          <Gap size={space.section} />
          <Action label="OPEN CAMERA" onPress={() => navigation.navigate('Scan')} />
          <Gap size={space.snug} />
          <Action
            label="PAIR WITH A STAND-IN (DEMO)"
            quiet
            onPress={() => {
              store.pairVault('VAULT · iPhone 11');
              navigation.goBack();
            }}
          />

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
  const { vault, now } = useStore();

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView showsVerticalScrollIndicator={false}>
        <Header onBack={() => navigation.goBack()} overline="SECURITY" title="How this is arranged" />
        <Gap size={space.gap} />

        <View style={{ paddingHorizontal: space.gutter }}>
          <Statement label="PRIVATE KEYS" value="VAULT ONLY" tone={color.good}>
            No key, seed phrase or signature has ever been generated on this phone. There is no screen in
            this application that imports one, and no field that would accept one.
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
            value={vault.state === 'unpaired' ? 'NONE' : vault.lastSession ? sessionTime(vault.lastSession, now) : 'NONE'}
            tone={color.slate}
          >
            The last time a signature came back from the vault and matched the transaction this device had
            prepared.
          </Statement>

          <Gap size={space.gap} />
          <Notice tone="alarm" title="WHAT THIS CANNOT PROTECT YOU FROM">
            A person who approves a payment on the vault without reading it. The vault renders the amount,
            the destination and the fee precisely so that a compromised wallet cannot pay somebody else
            quietly, but nothing in either half substitutes for reading that screen.
          </Notice>

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
