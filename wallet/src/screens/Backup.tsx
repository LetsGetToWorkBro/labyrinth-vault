/**
 * The words, and the only screen in this application that shows them.
 *
 * ## Two screens, one sheet
 *
 * `CreateWalletScreen` makes a wallet and cannot finish until its words have
 * been read. `BackupScreen` shows the words for a wallet that already exists.
 * They are the same grid with different chrome, and they are in one file
 * because the concealment is the part worth having exactly one copy of.
 *
 * ## Concealed by not being drawn
 *
 * The vault's own recovery screen blurs the grid and lifts the blur while a
 * finger is down, and this is the same interaction with a different mechanism:
 * a concealed word here is not rendered at all, it is a row of dashes the same
 * width. The vault can blur safely because it runs on a phone with no network
 * and no camera roll worth worrying about. This half is the networked one, and
 * a blur is a view treatment over a string that is still in the view tree,
 * still in a screenshot, still in whatever the system captures when the app is
 * backgrounded. Not drawing it is the version of the same idea that survives
 * being on this device.
 *
 * That is also why the screenshot warning here is louder than the vault's. On
 * the vault, photographing the words means walking them to another phone. On
 * this one, the camera roll is on the phone that has the network.
 *
 * ## Why there is no copy button
 *
 * Deliberate, and the omission somebody will try to fix. A general pasteboard
 * on iOS is readable by every app that comes to the foreground, and is offered
 * to the person's other devices over Handoff by default. A seed phrase on it
 * is a seed phrase in an unknown number of places. The words are here to be
 * written on paper, which is the only backup this product has ever claimed.
 */

import { useCallback, useMemo, useReducer, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Action, Gap, Notice, Press, Screen } from '../design/atoms';
import { Body, Label, LabelWide, Mono, Small } from '../design/text';
import { Header } from '../components/chrome';
import { color, radius, space } from '../design/tokens';
import { tap } from '../design/haptics';
import { useStore } from '../state/store';
import {
  beginCreation,
  creationHint,
  creationReduce,
  isKept,
  mayKeep,
  phrasesFor,
  wordCount,
  type Phrases,
} from '../core/backup';
import { makeHotRecord, type HotRecord } from '../core/keyvault';
import type { Nav } from '../nav/routes';

/**
 * Sixteen bytes for Bitcoin and thirty-two for Monero, from the platform.
 *
 * `crypto.getRandomValues` is the same source `store.tsx` draws decoy
 * selection from, and on this runtime it is the system CSPRNG. The entropy is
 * drawn here and handed to `makeHotRecord` rather than drawn inside it, which
 * is the reason that function is testable against a known answer at all.
 */
function drawEntropy(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

// -------------------------------------------------------------- the creation

/**
 * The guard, outside the flow.
 *
 * Split in two so that nothing is generated on a screen that is about to
 * refuse. Key material drawn and then discarded because a check further down
 * said no is key material that briefly existed for no reason, and the version
 * of this screen that generates first and checks second is one edit away from
 * saving what it generated.
 */
export function CreateWalletScreen({ navigation }: Nav<'CreateWallet'>) {
  const { hot } = useStore();

  /*
   * A wallet already here, so this screen refuses rather than overwrites.
   *
   * `saveHot` keeps exactly one record and overwriting is what it does, so the
   * refusal has to be here. Somebody who wants a second chain restores it;
   * somebody who genuinely wants to start over forgets the old one first, on a
   * screen that says what forgetting costs.
   */
  if (hot !== null) {
    return (
      <Refusal
        onBack={() => navigation.goBack()}
        title="This phone already holds a wallet"
        body={
          'Making a new one would replace it, and the words for the old one would be the ' +
          'only way back. Restore a phrase to add a chain, or forget the wallet on this ' +
          'phone first if you mean to start over.'
        }
      />
    );
  }

  return <CreateFlow navigation={navigation} />;
}

function CreateFlow({ navigation }: { navigation: Nav<'CreateWallet'>['navigation'] }) {
  const { keepHot } = useStore();

  /*
   * Drawn once, in a lazy initializer.
   *
   * Not in an effect and not during render: an effect would show an empty grid
   * for a frame and then fill it, and a plain call in the body would draw a
   * different wallet on every re-render, which means the words somebody is
   * copying change while they copy them. React calls this exactly once per
   * mount, which is exactly the requirement.
   */
  const [made] = useState(() =>
    makeHotRecord(drawEntropy(32), drawEntropy(16), 'mainnet', Date.now()),
  );

  if (!made.ok) {
    /* Only reachable if the platform CSPRNG handed back the wrong length,
     * which is not a thing that happens quietly enough to swallow. */
    return (
      <Refusal onBack={() => navigation.goBack()} title="Could not make a wallet" body={made.problem} />
    );
  }

  return <CreateSheet navigation={navigation} record={made.record} keepHot={keepHot} />;
}

function CreateSheet({
  navigation,
  record,
  keepHot,
}: {
  navigation: Nav<'CreateWallet'>['navigation'];
  record: HotRecord;
  keepHot: (record: HotRecord) => Promise<void>;
}) {
  const [creation, dispatch] = useReducer(creationReduce, record, beginCreation);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const phrases = useMemo(() => phrasesFor(creation.record), [creation.record]);
  const onRevealed = useCallback(() => dispatch({ type: 'revealed' }), []);

  const keep = async () => {
    if (!mayKeep(creation)) return;
    setSaving(true);
    try {
      await keepHot(creation.record);
      dispatch({ type: 'keep' });
      navigation.navigate('Home');
    } catch {
      /* The keychain refused. The words are still on paper and still restore,
       * which is the whole reason the order is this way round. */
      setProblem(
        'This phone would not store the keys. The words you wrote down still work: ' +
          'restore them once the phone has a passcode set.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: space.chapter }}>
        <Header onBack={() => navigation.goBack()} overline="NEW WALLET" title="Write these down" />

        <View style={{ paddingHorizontal: space.gutter }}>
          <Body>
            {wordCount(phrases)} words, on paper, by hand, now. They are the only copy that is not
            on this phone, and nobody can issue you another.
          </Body>
          <Gap size={space.gap} />
          <Notice tone="warn" title="THIS PHONE IS THE ONLINE HALF">
            Do not screenshot these words and do not put them in a password manager. The camera
            roll and the clipboard on this phone are reachable by other software on it. That is
            what the vault exists to avoid, and this wallet is the other side of that trade.
          </Notice>

          <Gap size={space.section} />
          <PhraseSheet phrases={phrases} onRevealed={onRevealed} />

          <Gap size={space.section} />
          {problem ? (
            <>
              <Notice tone="alarm" title="NOT SAVED">
                {problem}
              </Notice>
              <Gap size={space.gap} />
            </>
          ) : null}

          <Small tone={color.dim}>{creationHint(creation)}</Small>
          <Gap size={space.step} />
          <Action
            label={isKept(creation) ? 'SAVED' : 'I HAVE WRITTEN THEM DOWN'}
            disabled={!mayKeep(creation) || saving}
            onPress={() => void keep()}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

// ---------------------------------------------------------------- the backup

export function BackupScreen({ navigation }: Nav<'Backup'>) {
  const { hot } = useStore();

  if (hot === null) {
    return (
      <Refusal
        onBack={() => navigation.goBack()}
        title="No keys are stored on this phone"
        body={
          'This wallet is watching accounts that are signed for somewhere else, so there is ' +
          'nothing here to write down. The vault holding those keys has its own recovery screen.'
        }
      />
    );
  }

  return <BackupSheet onBack={() => navigation.goBack()} record={hot} />;
}

function BackupSheet({ onBack, record }: { onBack: () => void; record: HotRecord }) {
  const phrases = useMemo(() => phrasesFor(record), [record]);

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: space.chapter }}>
        <Header onBack={onBack} overline="RECOVERY" title="The words on paper" />

        <View style={{ paddingHorizontal: space.gutter }}>
          <Body>
            {wordCount(phrases)} words. They restore this wallet into any software that reads them,
            and they are the only backup that exists.
          </Body>
          <Gap size={space.gap} />
          <Notice tone="warn" title="THIS PHONE IS THE ONLINE HALF">
            Do not screenshot these words and do not put them in a password manager. The camera
            roll and the clipboard on this phone are reachable by other software on it.
          </Notice>

          <Gap size={space.section} />
          <PhraseSheet phrases={phrases} />

          <Gap size={space.section} />
          <Notice tone="plain" title="WHAT THESE KEYS CAN DO">
            They can spend, and they live on this phone under its passcode. Every signature asks
            for Face ID first. That is a real reduction against the vault, which keeps its keys
            behind a passphrase on a device with no network on it. Anything worth more than this
            phone belongs on that half.
          </Notice>
        </View>
      </ScrollView>
    </Screen>
  );
}

// ------------------------------------------------------------------ the sheet

/**
 * The grid, concealed until held.
 *
 * `onRevealed` fires on the first press and on every one after it. The
 * creation flow uses it to move out of `drawn`, and it is idempotent there on
 * purpose: a person reads thirty-seven words in more than one sitting, and a
 * transition that only tolerated one press would strand the flow.
 */
function PhraseSheet({ phrases, onRevealed }: { phrases: Phrases; onRevealed?: (() => void) | undefined }) {
  const [shown, setShown] = useState(false);

  const hold = () => {
    if (!shown) tap('light');
    setShown(true);
    onRevealed?.();
  };

  return (
    <View>
      {phrases.monero ? <WordGrid heading="MONERO · 25 WORDS" words={phrases.monero} shown={shown} /> : null}
      {phrases.monero && phrases.bitcoin ? <Gap size={space.section} /> : null}
      {phrases.bitcoin ? <WordGrid heading="BITCOIN · 12 WORDS" words={phrases.bitcoin} shown={shown} /> : null}

      <Gap size={space.gap} />
      <Press weight="none" onPressIn={hold} onPressOut={() => setShown(false)}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingVertical: space.gap,
            paddingHorizontal: space.step,
            borderRadius: radius.soft,
            borderWidth: 1,
            borderColor: shown ? color.warn : color.ruleStrong,
            backgroundColor: color.well,
          }}
        >
          <Label tone={shown ? color.warn : color.ash}>HOLD TO REVEAL</Label>
          <Label tone={shown ? color.warn : color.dim}>{shown ? 'VISIBLE' : 'CONCEALED'}</Label>
        </View>
      </Press>
    </View>
  );
}

/**
 * One chain's words, numbered.
 *
 * Numbered because the number is half the backup: a person copying twenty-five
 * words onto paper without them writes twenty-four and finds out years later.
 * Monospaced for the same reason every address in this app is.
 *
 * Not selectable, unlike every other `Mono` in the application. Selection puts
 * a Copy item on screen, and the pasteboard is the one place these words must
 * not go.
 */
function WordGrid({ heading, words, shown }: { heading: string; words: string[]; shown: boolean }) {
  return (
    <View>
      <LabelWide>{heading}</LabelWide>
      <Gap size={space.step} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {words.map((word, index) => (
          <View
            key={`${index}-${word}`}
            style={{
              width: '50%',
              flexDirection: 'row',
              alignItems: 'baseline',
              gap: space.snug,
              paddingVertical: 5,
            }}
          >
            <Mono size={10} tone={color.dim} selectable={false} style={{ width: 18, textAlign: 'right' }}>
              {index + 1}
            </Mono>
            {/* Concealed means not drawn. A blurred string is still a string in
                the view tree and in every screenshot the system takes. */}
            <Mono size={13} tone={shown ? color.bone : color.dim} selectable={false}>
              {shown ? word : '-'.repeat(Math.max(4, word.length))}
            </Mono>
          </View>
        ))}
      </View>
    </View>
  );
}

/** A screen that exists only to say why it has nothing to show. */
function Refusal({ onBack, title, body }: { onBack: () => void; title: string; body: string }) {
  return (
    <Screen>
      <StatusBar style="light" />
      <Header onBack={onBack} overline="RECOVERY" title={title} />
      <View style={{ paddingHorizontal: space.gutter }}>
        <Body>{body}</Body>
      </View>
    </Screen>
  );
}
