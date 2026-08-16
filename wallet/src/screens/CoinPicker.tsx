/**
 * Choosing one coin out of twenty-four.
 *
 * ## What this replaced
 *
 * Two rows of chips inside the swap screen: six tickers, and under them up to
 * nine chains once a ticker was picked. Twice, once per side of the trade. At
 * 390 points both rows wrap, so the target a thumb is travelling to moves when
 * the row above it rewraps, and "I have USDC on Base" was two hunts through
 * two wrapping rows rather than one word typed.
 *
 * ## Why it is a route and not a sheet
 *
 * A sheet over the swap screen would keep the amount visible, which sounds
 * useful and is not: the amount is meaningless until the coin is settled, and
 * a half-covered screen invites tapping the part that is still showing. A
 * route also gets the system back gesture for free, and cancelling a choice by
 * swiping back is what the gesture is for.
 *
 * ## The rule this screen exists to keep
 *
 * **No row is ever just a ticker.** Every one names its chain, in the row
 * itself, not behind a second tap. This is the deliberate divergence from the
 * wallets this flow is otherwise imitating: one well known one presents a
 * trade as `USDC → XMR` and then prints a Solana deposit address with the word
 * Solana nowhere on the screen. Somebody holding USDC on Ethereum sends it
 * there once. `test/coinpick.test.ts` holds the catalog to this, because the
 * way it breaks is somebody shortening a label to tidy up a list.
 */

import { useMemo, useState } from 'react';
import { FlatList, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Gap, Press, Rule, Screen } from '../design/atoms';
import { Body, Label, LabelWide, Small, Strong } from '../design/text';
import { Header } from '../components/chrome';
import { assetColor, color, radius, space } from '../design/tokens';
import { OUR_COINS, SWAP_COINS, chainName, type SwapCoin } from '../core/swap';
import { groupCoins, searchCoins } from '../core/coinpick';
import type { Nav } from '../nav/routes';

/** A group heading, or a coin. One list, so the scroll is one scroll. */
type Row =
  | { kind: 'head'; key: string; name: string; ticker: string }
  | { kind: 'coin'; key: string; coin: SwapCoin; selected: boolean };

export function CoinPickerScreen({ navigation, route }: Nav<'CoinPicker'>) {
  const { side, selected, exclude } = route.params;
  const [query, setQuery] = useState('');

  /*
   * Two different catalogs, and the asymmetry is the product rather than an
   * omission.
   *
   * The sending side offers only what this wallet holds, because sending is
   * this wallet building and broadcasting a payment, and it can only do that
   * for a chain it watches. The receiving side offers everything, because
   * receiving is an exchange paying out to an address, and the address can be
   * anywhere.
   *
   * Either way the coin on the other side of the trade is withdrawn. An
   * exchange asked to turn a coin into itself refuses at order time, after
   * somebody has already chosen and typed an amount.
   */
  const catalog = useMemo(
    () => (side === 'from' ? OUR_COINS : SWAP_COINS).filter((coin) => coin.id !== exclude),
    [side, exclude],
  );

  const rows = useMemo<Row[]>(() => {
    const found = searchCoins(catalog, query);
    const out: Row[] = [];
    for (const group of groupCoins(found)) {
      out.push({ kind: 'head', key: `head:${group.ticker}`, name: group.name, ticker: group.ticker });
      for (const coin of group.coins) {
        out.push({ kind: 'coin', key: coin.id, coin, selected: coin.id === selected });
      }
    }
    return out;
  }, [catalog, query, selected]);

  const choose = (coin: SwapCoin) => {
    /* `popTo` rather than `navigate`, so choosing twice does not stack two
     * pickers behind the swap screen. */
    navigation.navigate('Swap', { chose: { side, id: coin.id } });
  };

  return (
    <Screen>
      <StatusBar style="light" />
      <Header
        onBack={() => navigation.goBack()}
        overline={side === 'from' ? 'YOU SEND' : 'YOU RECEIVE'}
        title="Pick a coin"
      />

      <View style={{ paddingHorizontal: space.gutter }}>
        {/* A search field over two rows is furniture. It appears when the
            catalog is long enough for hunting to be the slow part. */}
        {catalog.length > 8 ? (
        <View
          style={{
            backgroundColor: color.well,
            borderRadius: radius.soft,
            borderWidth: 1,
            borderColor: color.rule,
            paddingHorizontal: space.step,
          }}
        >
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search a coin or a chain"
            placeholderTextColor={color.dim}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            returnKeyType="search"
            style={{
              color: color.bone,
              fontSize: 17,
              paddingVertical: space.step,
            }}
          />
        </View>
        ) : null}
        <Gap size={space.snug} />
        <Small tone={color.dim}>
          Every coin names the chain it is on. Sending a coin to the right address on the wrong
          chain is the one mistake here that cannot be undone.
        </Small>
      </View>

      <Gap size={space.gap} />

      {rows.length === 0 ? (
        <View style={{ paddingHorizontal: space.gutter, paddingTop: space.section }}>
          <Strong>Nothing here matches that.</Strong>
          <Gap size={space.snug} />
          <Body>
            Twenty-four coins across ten chains, and wrapped assets are left out on purpose: a
            token that stands in for a coin is somebody else&apos;s promise, not the coin.
          </Body>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.key}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: space.chapter }}
          renderItem={({ item }) =>
            item.kind === 'head' ? (
              <View style={{ paddingHorizontal: space.gutter, paddingTop: space.gap, paddingBottom: space.tight }}>
                <LabelWide>{item.name.toUpperCase()}</LabelWide>
              </View>
            ) : (
              <CoinRowItem coin={item.coin} selected={item.selected} onPress={() => choose(item.coin)} />
            )
          }
        />
      )}
    </Screen>
  );
}

/**
 * One coin.
 *
 * The chain is the loud half of the row, not the quiet half. The ticker is
 * what somebody searched for and already knows; the chain is the thing that
 * decides whether the money arrives, so it gets the readable weight and the
 * asset color goes on the mark rather than the text.
 */
function CoinRowItem({
  coin,
  selected,
  onPress,
}: {
  coin: SwapCoin;
  selected: boolean;
  onPress: () => void;
}) {
  const tone = coin.ours ? assetColor(coin.ours) : color.ash;
  return (
    <Press onPress={onPress}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.step,
          paddingHorizontal: space.gutter,
          paddingVertical: space.step,
        }}
      >
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            borderWidth: 1,
            borderColor: selected ? tone : color.ruleStrong,
            backgroundColor: selected ? color.raised : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Label tone={selected ? tone : color.slate} style={{ fontSize: 10 }}>
            {coin.ticker.slice(0, 4).toUpperCase()}
          </Label>
        </View>

        <View style={{ flex: 1, minWidth: 0 }}>
          <Strong style={{ fontSize: 16 }}>{chainName(coin.chain)}</Strong>
          <Small tone={color.slate}>{coin.label}</Small>
        </View>

        {/* Held here as well as tradable: worth saying, because it is the
            difference between a swap that lands in this wallet and one that
            lands somewhere a person has to go and fetch. */}
        {coin.ours ? <Label tone={color.slate}>IN THIS WALLET</Label> : null}
        {selected ? <Label tone={tone}>·</Label> : null}
      </View>
      <Rule inset={space.gutter} />
    </Press>
  );
}
