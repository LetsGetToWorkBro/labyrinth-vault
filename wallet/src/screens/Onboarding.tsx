/**
 * First run: teaching an architecture in four screens, without a diagram of a
 * blockchain.
 *
 * The thing a new user has to understand is not Bitcoin. It is that the
 * interesting half of this wallet is somewhere else: that the account worth
 * having is signed for on another device, and that this is the feature rather
 * than a missing one. Everything else can be learned by using it. That one
 * idea, misunderstood, produces a person who thinks the app is broken the
 * first time they try to send.
 *
 * So the four panels are: you have two halves; here is what each does; they
 * never share a key; here is how they speak. No jargon until the fourth, and
 * the only animation is the labyrinth line and the dashes traveling between
 * two points — which are the two visual ideas the rest of the product is
 * built from, introduced here where they can be explained.
 *
 * ## The sentences that had to change
 *
 * These four panels are the first thing anybody reads, and until the app grew
 * keys of its own every one of them was true. "It holds no key." "It is the
 * only thing that can spend your money." "Nothing secret crosses between them,
 * ever." A phone that stores a seed makes the first two false and leaves the
 * third true only of the vault half.
 *
 * The rewrite does not soften them into nothing. The airgap claims are the
 * product and they are made in the affirmative, about the vault account, which
 * is where they are still exactly true. What is added is the second kind of
 * account, said plainly and said as the smaller thing, because a person who
 * meets it for the first time on the accounts screen has been misled by
 * omission on the screen that was supposed to explain the design.
 *
 * ## The last panel, which offered one destination twice
 *
 * CONNECT YOUR VAULT and LOOK AROUND FIRST both replaced the route with Home.
 * Somebody tapping the emphasized button landed on a home screen with no
 * explanation of where the pairing had gone. The primary action goes to `Pair`
 * now, and the third way in, a wallet on this phone, is offered here because
 * Home and Accounts both offer it and this screen claimed it did not exist.
 */

import { useEffect, useRef, useState } from 'react';
import { Dimensions, ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Action, Gap, Press, Screen } from '../design/atoms';
import { Body, Label, LabelWide, Small, Title } from '../design/text';
import { Journey, Link, Mark } from '../labyrinth/glyphs';
import { color, space } from '../design/tokens';
import { useStore } from '../state/store';
import { watchingNothing } from '../core/accounts';
import type { Nav } from '../nav/routes';

const { width } = Dimensions.get('window');

export function OnboardingScreen({ navigation }: Nav<'Onboarding'>) {
  const [page, setPage] = useState(0);
  const scroller = useRef<ScrollView>(null);
  const { accounts } = useStore();

  /*
   * The other half of App.tsx's route choice, and the reason it needs one.
   *
   * `initialRouteName` is read once, and the keychain read for a wallet on
   * this phone settles after the store reports itself restored. So a phone
   * whose only account is a hot one can mount this screen and then discover
   * an account underneath it. Leaving on that discovery costs a frame in a
   * narrow case and is correct in every case, where waiting for a flag that
   * does not exist yet would be neither.
   */
  useEffect(() => {
    if (!watchingNothing(accounts)) navigation.replace('Home');
  }, [accounts, navigation]);

  const go = (next: number) => {
    scroller.current?.scrollTo({ x: next * width, animated: true });
    setPage(next);
  };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setPage(Math.round(event.nativeEvent.contentOffset.x / width));
  };

  /** Leave onboarding for a destination somebody can come back from. */
  const open = (route: 'Pair' | 'CreateWallet') => {
    navigation.reset({ index: 1, routes: [{ name: 'Home' }, { name: route }] });
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
            One of them is this phone. The other is a device with no network on it, and it is where the
            money you are keeping rather than spending should live.
          </Body>
        </Panel>

        <Panel>
          <LabelWide>THE ONLINE HALF</LabelWide>
          <Gap size={space.gap} />
          <Title style={{ fontSize: 30, lineHeight: 36 }}>This wallet watches the chain.</Title>
          <Gap size={space.gap} />
          <Body>
            It knows your balance, hands out receiving addresses, builds payments and publishes them once
            they are signed. For an account paired from your vault it holds no key at all, so none of
            that can move a satoshi on its own.
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
          <Gap size={space.gap} />
          {/* The third kind of thing this screen has to say now, and it is
              said here rather than as a fifth panel: it is a footnote to the
              architecture, not a peer of it. Saying it at all is the point.
              Somebody who first meets a hot wallet on the accounts screen was
              misled by omission on the screen that explains the design. */}
          <Small tone={color.slate}>
            You can also keep a small wallet on this phone, with its words in this phone&apos;s keychain
            and Face ID before every signature. That one signs here. It is for the amounts that are not
            worth a walk to the other device, and it is protected by this phone rather than by the
            airgap above.
          </Small>
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
            {/* Three destinations, three routes. This was two buttons pointing
                at the same one: the emphasized action said CONNECT YOUR VAULT
                and replaced the route with Home, so a person who tapped it
                arrived somewhere with no explanation of where the pairing had
                gone. `Pair` has existed the whole time.

                `reset` rather than `replace`, because either destination is a
                thing somebody can back out of, and replacing the only route on
                the stack leaves a screen with nowhere behind it. Home is put
                underneath so that backing out of pairing lands where backing
                out of anything else does. */}
            <Action label="CONNECT YOUR VAULT" onPress={() => open('Pair')} />
            <Gap size={space.snug} />
            <Action label="MAKE A WALLET ON THIS PHONE" quiet onPress={() => open('CreateWallet')} />
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
