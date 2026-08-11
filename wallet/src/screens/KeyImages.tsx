/**
 * The key image round trip, as a screen.
 *
 * Two steps and no connection, like everything else between the halves: this
 * phone draws the outputs it found, the vault reads them, computes one key
 * image per output, and draws its answer back. The camera screen this hands
 * off to already knows what an `XMRKEYIMAGES` payload is.
 *
 * The sentence at the top says what is being handed over, because this is the
 * one payload the *wallet* sends that is about the person rather than a
 * transaction: the list of every payment this account has received. It only
 * ever crosses by light, to a device with no radio, but a person should still
 * know that is what the codes say.
 */

import { useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Action, Gap, Notice, Screen } from '../design/atoms';
import { Body, Label, Small, Strong } from '../design/text';
import { Header } from '../components/chrome';
import { QrCanvas } from '../qr/QrCanvas';
import { Link } from '../labyrinth/glyphs';
import { color, space } from '../design/tokens';
import { FRAME_MS } from '../core/wire';
import { useStore } from '../state/store';
import type { Nav } from '../nav/routes';

export function KeyImagesScreen({ navigation }: Nav<'KeyImages'>) {
  const store = useStore();
  const transmission = useMemo(() => store.keyImageFrames(), [store]);
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

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView showsVerticalScrollIndicator={false}>
        <Header onBack={() => navigation.goBack()} overline="MONERO SPENDS" title="Show this to the vault" />
        <Gap size={space.gap} />

        {transmission ? (
          <View style={{ alignItems: 'center' }}>
            <QrCanvas value={frame} size={320} level="M" />
            <Gap size={space.gap} />
            <View style={{ flexDirection: 'row', gap: space.section }}>
              <View>
                <Label tone={color.slate}>FRAME</Label>
                <Strong>{`${status.frame} / ${status.total}`}</Strong>
              </View>
              <View>
                <Label tone={color.slate}>PASSES</Label>
                <Strong>{`${status.laps}`}</Strong>
              </View>
            </View>
            <Gap size={space.gap} />
            <Link direction="out" active width={280} />
            <Gap size={space.section} />
            <View style={{ paddingHorizontal: space.gutter, alignSelf: 'stretch' }}>
              <Body>
                The vault will compute one key image per payment and draw its answer. When it does,
                open the camera and read it back.
              </Body>
              <Gap size={space.gap} />
              <Action label="OPEN CAMERA FOR THE ANSWER" onPress={() => navigation.navigate('Scan', { purpose: 'wire' })} />
              <Gap size={space.section} />
              <Notice title="WHAT THESE CODES SAY">
                The list of payments this wallet has found for your account. That is a private thing,
                and it is crossing by light to a device with no network. It is not going anywhere else.
              </Notice>
            </View>
          </View>
        ) : (
          <View style={{ paddingHorizontal: space.gutter }}>
            <Notice title="NOTHING TO ASK ABOUT YET">
              The scan has not found any Monero payments, so there is nothing to compute key images
              for. Set a Monero node and let the scan run first.
            </Notice>
            <Gap size={space.gap} />
            <Small tone={color.slate}>
              The scan runs a couple of hundred blocks per refresh and remembers where it got to.
            </Small>
          </View>
        )}
        <Gap size={space.chapter} />
      </ScrollView>
    </Screen>
  );
}
