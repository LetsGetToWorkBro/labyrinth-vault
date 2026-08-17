/**
 * One field, and no question about which kind of phrase is in it.
 *
 * ## Why there is no picker
 *
 * Every other wallet asks which chain you are restoring before it will accept
 * anything, which is asking somebody to classify their own backup: a person
 * holding a piece of paper with words on it knows it is their wallet and does
 * not necessarily know whether the software that made it called itself Monero
 * or Feather or Cake. `readPhrase` reads the count instead. Twenty-five is
 * Monero, twelve is Bitcoin, and the counts do not collide except at
 * twenty-four, which `keyvault.ts` handles by naming both possibilities rather
 * than guessing between them.
 *
 * ## Why the field is not a grid of twenty-five boxes
 *
 * The other common design. It looks careful and it fights every way a phrase
 * actually arrives: pasted from a password manager as one string, typed with
 * autocorrect on, read aloud from paper by somebody else. A single field takes
 * all of those, and the collapsing of whitespace and case happens in
 * `readPhrase` where it can be tested.
 *
 * What is deliberately absent is any correction of the words themselves. A
 * phrase with a typo fails, loudly, naming the count it found. Nudging a word
 * to the nearest one in the list is how somebody ends up restoring a stranger's
 * wallet, or more likely an empty one, and being told it worked.
 *
 * ## What it says before it acts
 *
 * `restoreEffect` writes the sentence, because the case that matters is a
 * person with a Bitcoin wallet on this phone restoring a Monero phrase.
 * `withRestored` keeps the other chain, and the screen says so before the tap
 * rather than leaving somebody to wonder whether they just wrote over half
 * their wallet.
 */

import { useMemo, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Action, Gap, Notice, Screen } from '../design/atoms';
import { Body, Label, Small } from '../design/text';
import { Header } from '../components/chrome';
import { color, radius, space } from '../design/tokens';
import { useStore } from '../state/store';
import { readPhrase, withRestored } from '../core/keyvault';
import { restoreEffect } from '../core/backup';
import type { Nav } from '../nav/routes';

export function RestoreScreen({ navigation }: Nav<'Restore'>) {
  const { hot, keepHot } = useStore();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * Read on every keystroke, and that is affordable because `readPhrase` is a
   * word count and a checksum rather than a key derivation. Reading as it is
   * typed means the count is on screen while somebody is still counting, which
   * is when "found 24 words" is useful rather than after they commit.
   *
   * Empty is not a refusal. A field nobody has typed in yet showing a red
   * sentence is a screen that shouts before it has been asked anything.
   */
  const reading = useMemo(() => (text.trim() === '' ? null : readPhrase(text)), [text]);

  const effect = reading?.ok === true ? restoreEffect(hot, reading.chain) : null;

  const restore = async () => {
    if (reading === null || !reading.ok) return;
    setSaving(true);
    setProblem(null);
    try {
      /* `withRestored` decides what the record becomes, including keeping the
       * chain that is not being restored. The screen does not merge anything
       * itself: a second merge written here would be a second place for the
       * rule about not discarding the other half to be got wrong. */
      const folded = withRestored(hot, reading, 'mainnet', Date.now());
      if (!folded.ok) {
        setProblem(folded.problem);
        return;
      }
      await keepHot(folded.record);
      navigation.navigate('Home');
    } catch {
      setProblem(
        'This phone would not store the keys. Check that it has a passcode set, then try again. ' +
          'Your words are unchanged by this.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: space.chapter }}
      >
        <Header onBack={() => navigation.goBack()} overline="RESTORE" title="Type or paste your words" />

        <View style={{ paddingHorizontal: space.gutter }}>
          <Body>
            Twenty-five words for Monero, twelve for Bitcoin. It reads the count and works out
            which, so there is nothing to choose here.
          </Body>

          <Gap size={space.gap} />
          <View
            style={{
              backgroundColor: color.well,
              borderRadius: radius.soft,
              borderWidth: 1,
              borderColor: reading?.ok === false ? color.alarm : color.rule,
              paddingHorizontal: space.step,
              paddingVertical: space.snug,
            }}
          >
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="ordinary words, separated by spaces"
              placeholderTextColor={color.dim}
              /* Every one of these off, and each for its own reason.
                 Autocorrect rewrites a valid word into a nearer English one.
                 Autocapitalize breaks nothing here, because `readPhrase` folds
                 case, but it makes a phrase look wrong while it is typed.
                 Spellcheck underlines all twenty-five in red. */
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              textContentType="none"
              multiline
              textAlignVertical="top"
              style={{
                color: color.bone,
                fontSize: 16,
                lineHeight: 24,
                minHeight: 120,
                paddingVertical: space.snug,
              }}
            />
          </View>

          <Gap size={space.step} />
          <WordTally text={text} />

          <Gap size={space.gap} />
          {reading?.ok === false ? (
            <Notice tone="alarm" title="NOT A PHRASE THIS READS">
              {reading.problem}
            </Notice>
          ) : null}
          {effect !== null ? (
            <Notice tone={effect.includes('replaces') ? 'warn' : 'plain'} title="WHAT THIS WILL DO">
              {effect}
            </Notice>
          ) : null}
          {problem !== null ? (
            <>
              <Gap size={space.gap} />
              <Notice tone="alarm" title="NOT SAVED">
                {problem}
              </Notice>
            </>
          ) : null}

          <Gap size={space.section} />
          <Small tone={color.dim}>
            A restored Monero wallet scans from the beginning of the chain, because nobody typing a
            phrase knows the height it was made at. That is slow and it is the only way to find
            every coin it ever received.
          </Small>
          <Gap size={space.step} />
          <Action
            label="RESTORE THIS WALLET"
            disabled={reading === null || !reading.ok || saving}
            onPress={() => void restore()}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

/**
 * The count, while somebody is still counting.
 *
 * The single most useful thing on this screen and it is four words long. A
 * person who dropped one word off a twenty-five word phrase learns it here,
 * before they have committed to anything, rather than from a checksum failure
 * that reads as "your backup is bad".
 */
function WordTally({ text }: { text: string }) {
  const count = text.trim() === '' ? 0 : text.trim().split(/\s+/).filter(Boolean).length;
  const known = count === 25 || count === 12 || count === 24;

  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <Label tone={color.slate}>{count === 0 ? 'NOTHING TYPED YET' : `${count} WORDS`}</Label>
      {count > 0 && !known ? <Label tone={color.slate}>MONERO 25 · BITCOIN 12</Label> : null}
    </View>
  );
}
