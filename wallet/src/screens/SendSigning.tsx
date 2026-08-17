/**
 * The other way a payment reaches a signature: this phone signs it.
 *
 * ## One face, where the vault path has four
 *
 * `SendHandoff.tsx` is transmit, awaiting, receive and mismatch, because that
 * path crosses a room and every stage of the crossing is something a person
 * has to do. This path is a prompt and a key schedule. Giving it four screens
 * to match would be ceremony imitating security, and this is the half of the
 * product that has less of it: pretending otherwise on screen is how somebody
 * comes to believe the two are equivalent.
 *
 * ## What this screen says, and why it says it here
 *
 * That the keys are on this phone, and what that costs. The review screen
 * before it already says which of the two is about to happen, so this is not
 * the first warning; it is the last honest sentence before a signature, and
 * the moment somebody is most likely to read it.
 *
 * It does not congratulate. A hot signature is the convenient option and the
 * weaker one, and a screen that celebrates it would be selling the weaker
 * option with the interface.
 *
 * ## The absence worth naming
 *
 * There is no "remember for the next few minutes". `signgate.ts` argues that
 * out: a session-long unlock is a phone that signs anything for as long as
 * somebody keeps it awake, which is exactly the hole the prompt closes. The
 * absence is the feature, and it is why this screen has no settings.
 */

import { useEffect, useRef } from 'react';
import { ScrollView, View } from 'react-native';
import { Action, Gap, Notice, Rule } from '../design/atoms';
import { Body, Label, Small } from '../design/text';
import { Header } from '../components/chrome';
import { AddressBlock, Amount } from '../components/money';
import { color, space } from '../design/tokens';
import { useStore } from '../state/store';

export function Signing({ onBack }: { onBack: () => void }) {
  const store = useStore();
  const draft = store.session.draft;

  /*
   * The prompt is raised once, on arrival.
   *
   * A screen that waits for a second tap would put a button in front of a
   * person who has just tapped a button, and the review screen was the
   * decision. A ref rather than a dependency list because the effect must not
   * re-fire when the store's `now` ticks underneath it: raising a second Face
   * ID prompt over the first is how a signature gets authorized twice and
   * built once.
   */
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void store.signOnThisDevice();
  }, [store]);

  if (!draft) return null;

  return (
    <ScrollView showsVerticalScrollIndicator={false}>
      <Header onBack={onBack} overline="SIGNING HERE" title="This phone is signing" />
      <Gap size={space.gap} />

      <View style={{ paddingHorizontal: space.gutter }}>
        <Label>SENDING</Label>
        <Gap size={space.snug} />
        <Amount atoms={draft.amount} asset={draft.asset} size="readout" />

        <Gap size={space.section} />
        <Label style={{ marginBottom: space.snug }}>TO</Label>
        <AddressBlock address={draft.recipient} />

        <Gap size={space.section} />
        <Rule />
        <Gap size={space.gap} />

        <Notice tone="warn" title="THE KEYS FOR THIS ACCOUNT ARE ON THIS PHONE">
          They sit in the keychain under this device&apos;s passcode, and Face ID authorizes each
          signature separately. That is protection by the device rather than by something you know,
          and it is weaker than the vault, which keeps its keys on a phone with no network on it.
        </Notice>

        <Gap size={space.gap} />
        <Body>
          If the prompt did not appear, or you dismissed it, nothing has been signed and the payment
          is still here. Go back and try again.
        </Body>

        <Gap size={space.section} />
        <Small tone={color.dim}>
          Asked once per signature, never once per session. A phone that stayed unlocked for a while
          would sign anything for as long as somebody kept it awake, which is the whole thing the
          prompt is here to prevent.
        </Small>

        <Gap size={space.section} />
        <Action label="CANCEL" quiet onPress={onBack} />
      </View>
      <Gap size={space.chapter} />
    </ScrollView>
  );
}
