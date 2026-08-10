/**
 * First run: teaching an architecture in four screens, without a diagram of a
 * blockchain.
 *
 * The thing a new user has to understand is not Bitcoin. It is that this
 * wallet is deliberately incomplete — that it cannot spend, that the missing
 * capability lives on another device, and that this is the feature. Everything
 * else can be learned by using it. That one idea, misunderstood, produces a
 * person who thinks the app is broken the first time they try to send.
 *
 * So the four panels are: you have two halves; here is what each does; they
 * never share a key; here is how they speak. No jargon until the fourth, and
 * the only animation is the labyrinth line and the dashes traveling between
 * two points — which are the two visual ideas the rest of the product is
 * built from, introduced here where they can be explained.
 */

import { useRef, useState } from 'react';
import { Dimensions, ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Action, Gap, Press, Screen } from '../design/atoms';
import { Body, Label, LabelWide, Small, Title } from '../design/text';
import { Journey, Link, Mark } from '../labyrinth/glyphs';
import { color, space } from '../design/tokens';
import type { Nav } from '../nav/routes';

const { width } = Dimensions.get('window');

export function OnboardingScreen({ navigation }: Nav<'Onboarding'>) {
  const [page, setPage] = useState(0);
  const scroller = useRef<ScrollView>(null);

  const go = (next: number) => {
    scroller.current?.scrollTo({ x: next * width, animated: true });
    setPage(next);
  };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setPage(Math.round(event.nativeEvent.contentOffset.x / width));
  };

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView
        ref={scroller}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        style={{ flex: 1 }}
      >
        <Panel>
          <Mark size={40} tone={color.bone} weight={1.4} />
          <Gap size={space.chapter} />
          <Title style={{ fontSize: 34, lineHeight: 40 }}>Your wallet has two halves.</Title>
          <Gap size={space.gap} />
          <Body>
            One of them is this phone. The other is a device with no network on it, and it is the only
            thing that can spend your money.
          </Body>
        </Panel>

        <Panel>
          <LabelWide>THE ONLINE HALF</LabelWide>
          <Gap size={space.gap} />
          <Title style={{ fontSize: 30, lineHeight: 36 }}>This wallet watches the chain.</Title>
          <Gap size={space.gap} />
          <Body>
            It knows your balance, hands out receiving addresses, builds payments and publishes them once
            they are signed. It holds no key, so none of that can move a satoshi on its own.
          </Body>
          <Gap size={space.chapter} />
          <LabelWide>THE OFFLINE HALF</LabelWide>
          <Gap size={space.gap} />
          <Title style={{ fontSize: 30, lineHeight: 36 }}>The vault holds the keys.</Title>
          <Gap size={space.gap} />
          <Body>
            It has never been on a network and has no code in it that could be. It shows you what a
            payment does, in full, and signs it only if you say so.
          </Body>
        </Panel>

        <Panel>
          <Journey reached={6} size={180} />
          <Gap size={space.chapter} />
          <Title style={{ fontSize: 30, lineHeight: 36 }}>They never share a private key.</Title>
          <Gap size={space.gap} />
          <Body>
            Nothing secret crosses between them, ever. What crosses is a transaction that has not been
            signed, and then the same transaction after it has been. Both of them are things you are
            about to publish to the world anyway.
          </Body>
        </Panel>

        <Panel>
          <Link direction="out" active width={280} />
          <Gap size={space.chapter} />
          <Title style={{ fontSize: 30, lineHeight: 36 }}>They speak in QR codes.</Title>
          <Gap size={space.gap} />
          <Body>
            One screen draws, one camera reads, one direction at a time. There is no pairing, no
            Bluetooth and no cable, which means there is nothing to intercept and nothing to
            misconfigure.
          </Body>
          <Gap size={space.gap} />
          <Small tone={color.slate}>
            A payment takes about ten seconds of animation each way. That is the cost of an airgap, and it
            is the whole cost.
          </Small>
        </Panel>
      </ScrollView>

      <View style={{ paddingHorizontal: space.gutter, paddingBottom: space.gap }}>
        <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center', paddingBottom: space.gap }}>
          {[0, 1, 2, 3].map((index) => (
            <View
              key={index}
              style={{
                width: index === page ? 18 : 5,
                height: 3,
                borderRadius: 2,
                backgroundColor: index === page ? color.bone : color.dim,
              }}
            />
          ))}
        </View>

        {page < 3 ? (
          <Animated.View entering={FadeIn}>
            <Action label="NEXT" onPress={() => go(page + 1)} />
            <Gap size={space.snug} />
            <Press onPress={() => navigation.replace('Home')}>
              <View style={{ alignItems: 'center', paddingVertical: space.step }}>
                <Label tone={color.slate}>SKIP</Label>
              </View>
            </Press>
          </Animated.View>
        ) : (
          <Animated.View entering={FadeIn}>
            <Action label="CONNECT YOUR VAULT" onPress={() => navigation.replace('Home')} />
            <Gap size={space.snug} />
            <Press onPress={() => navigation.replace('Home')}>
              <View style={{ alignItems: 'center', paddingVertical: space.step }}>
                <Label tone={color.slate}>LOOK AROUND FIRST</Label>
              </View>
            </Press>
          </Animated.View>
        )}
      </View>
    </Screen>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ width, paddingHorizontal: space.gutter, justifyContent: 'center', flex: 1 }}>{children}</View>
  );
}
