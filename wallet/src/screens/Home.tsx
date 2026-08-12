/**
 * The home screen, which has one job before any other: say whether this device
 * can spend right now, and why not.
 *
 * Order on the page, and it is the argument the whole design makes:
 *
 *   1. the wordmark, which half you are holding
 *   2. the vault status, because it decides what the rest of the screen means
 *   3. the total, large enough to be the only thing you came for
 *   4. what it is made of
 *   5. what you can do
 *   6. what has been happening
 *
 * A conventional wallet puts the balance first and the security state in a
 * settings screen. That ordering is a claim that the number is the product.
 * Here the number is the *second* thing, under a line saying whether the other
 * half of the system is available, because on a two-device wallet that is the
 * difference between a balance and a balance you can move.
 *
 * ## The total
 *
 * Set at 64 points, alone on its line, with nothing next to it. The one place
 * this application spends its whole typographic budget, and it is spent on a
 * number that is *derived* — from real amounts and a real price, by the code
 * in `units.ts`, checked by tests that assert this screen adds up.
 *
 * Under it, a two-part rule: the proportion of the portfolio in each asset.
 * Not a donut. A donut of two values is an ornament with a legend.
 */

import { Dimensions, ScrollView, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { ActionRow, Cell, Chip, Gap, Press, Rule, Screen } from '../design/atoms';
import { Body, Display, Label, Small } from '../design/text';
import { SectionHead, VaultStatus, Wordmark } from '../components/chrome';
import { Amount, AssetLine } from '../components/money';
import { Allocation } from '../labyrinth/glyphs';
import { TxRow } from '../components/tx';
import { ActivityIcon, AssetsIcon, ReceiveIcon, ScanIcon, SendIcon, VaultIcon, SwapIcon, NodeIcon } from '../components/icons';
import { assetColor, color, space } from '../design/tokens';
import { fiatCents, formatFiat, hasPrice } from '../core/units';
import { useStore } from '../state/store';
import type { Nav } from '../nav/routes';

/* The gutter is 24 either side, so the readout column is whatever is left.
 * Measuring it here rather than writing 342 keeps the allocation rule the
 * width of the thing above it on a mini, a Pro and a Max alike. */
const COLUMN = Dimensions.get('window').width - space.gutter * 2;

export function HomeScreen({ navigation }: Nav<'Home'>) {
  const { snapshot, vault, now, setAsset } = useStore();
  const bitcoin = snapshot.assets.BTC;
  const monero = snapshot.assets.XMR;

  const btcValue = fiatCents(bitcoin.balance, 'BTC', snapshot.centsPerUnit.BTC);
  const xmrValue = fiatCents(monero.balance, 'XMR', snapshot.centsPerUnit.XMR);
  const total = btcValue + xmrValue;
  /* Whether the hero can be a dollar figure at all. Zero cents per unit means
   * no price is known right now. A price only ever arrives through Labyrinth's
   * relay, which serves every client one cached answer so no price service
   * sees a phone; when there is no relay configured, or it has not answered,
   * or this wallet runs only on its owner's own nodes and therefore asks
   * Labyrinth for nothing, the zero stays. Without a price the total is shown
   * in the coins themselves, which is the truth, rather than as "$0.00",
   * which is a lie about the money and reads as a wallet that lost it. */
  const priced = hasPrice(snapshot.centsPerUnit.BTC) || hasPrice(snapshot.centsPerUnit.XMR);

  const recent = snapshot.transactions.slice(0, 3);

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={{ paddingBottom: space.chapter }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ paddingHorizontal: space.gutter, paddingTop: space.snug }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
            <Wordmark />
            <View style={{ flex: 1 }} />
            {/* Three states, three different things to say. Fixture data, a
                node whose last answer did not arrive, and a live one. A wallet
                that showed nothing in the middle case would be presenting an
                old balance as a current one. */}
            {snapshot.demo ? (
              <Press onPress={() => navigation.navigate('Nodes')}>
                <Chip tone={color.warn}>DEMO DATA · SET A NODE</Chip>
              </Press>
            ) : snapshot.stale ? (
              <Press onPress={() => navigation.navigate('Nodes')}>
                <Chip tone={color.warn}>NOT UP TO DATE</Chip>
              </Press>
            ) : null}
          </View>

          <Gap size={space.snug} />
          <VaultStatus vault={vault} now={now} onPress={() => navigation.navigate('Vault')} />
        </View>

        <Rule />

        {/* ------------------------------------------------------- the total */}
        {/* Two shapes for the hero, and which one shows is a fact about the
            data rather than a setting. With a price the total is a dollar
            figure and the rule under it is the allocation. Without one, which
            is every session against a real node, the coins themselves are the
            readout: two amounts, stacked, full typographic budget. The
            allocation goes with the price, because weighing bitcoin against
            monero needs a common unit and there is none. */}
        <View style={{ paddingHorizontal: space.gutter, paddingTop: space.section }}>
          {priced ? (
            <>
              <Label>TOTAL HELD</Label>
              <Gap size={space.step} />
              <Display>{formatFiat(total)}</Display>
              <Gap size={space.gap} />
              <Allocation
                width={COLUMN}
                parts={[
                  { weight: btcValue, tone: assetColor('BTC') },
                  { weight: xmrValue, tone: assetColor('XMR') },
                ]}
              />
              <Gap size={space.step} />
              <View style={{ flexDirection: 'row', gap: space.gap }}>
                <Small tone={color.slate}>
                  {Math.round((btcValue / Math.max(total, 1)) * 100)}% BITCOIN
                </Small>
                <Small tone={color.slate}>
                  {Math.round((xmrValue / Math.max(total, 1)) * 100)}% MONERO
                </Small>
                {snapshot.stale ? <Small tone={color.dim}>· PRICE NOT LIVE</Small> : null}
              </View>
            </>
          ) : (
            <>
              <Label>HELD</Label>
              <Gap size={space.step} />
              <Amount atoms={bitcoin.balance} asset="BTC" size="readout" />
              <Gap size={space.step} />
              <Amount atoms={monero.balance} asset="XMR" size="readout" />
              <Gap size={space.step} />
              {/* Present tense on purpose. "This wallet asks no price
                  service" was true forever and misleading tomorrow: the day
                  the relay is deployed, dollar figures appear, and a person
                  who read a permanent-sounding sentence concludes the app
                  lied. What is always true is the arrangement: no price is
                  known at this moment, and when one is known it came through
                  Labyrinth's relay rather than from this phone asking a
                  price service. */}
              <Small tone={color.dim}>
                Shown in coin. No price is known right now; one only ever arrives through
                Labyrinth&apos;s relay, and this phone asks no price service itself.
              </Small>
            </>
          )}
        </View>

        <Gap size={space.section} />

        {/* ------------------------------------------------------ the assets */}
        <View style={{ paddingHorizontal: space.gutter }}>
          <SectionHead>HOLDINGS</SectionHead>
          <Press onPress={() => navigation.navigate('Asset', { asset: 'BTC' })}>
            <AssetLine asset="BTC" balance={bitcoin.balance} centsPerUnit={snapshot.centsPerUnit.BTC} />
          </Press>
          <Rule />
          <Press onPress={() => navigation.navigate('Asset', { asset: 'XMR' })}>
            <AssetLine asset="XMR" balance={monero.balance} centsPerUnit={snapshot.centsPerUnit.XMR} />
          </Press>
          {/* A Monero figure from a view key is what arrived rather than what
              is left, and a scan that has not reached the tip has not seen
              everything. Both of those change what the number above means, so
              they belong beside it and not in a settings page. */}
          {monero.caveat ? (
            <>
              <Gap size={space.snug} />
              <Small tone={color.dim}>{monero.caveat}</Small>
            </>
          ) : null}
        </View>

        <Gap size={space.section} />

        {/* ----------------------------------------------------- the actions */}
        <View style={{ paddingHorizontal: space.gutter }}>
          <ActionRow>
            <Cell
              label="RECEIVE"
              glyph={<ReceiveIcon />}
              onPress={() => navigation.navigate('Receive')}
            />
            <Cell
              label="SEND"
              glyph={<SendIcon />}
              onPress={() => {
                setAsset('BTC');
                navigation.navigate('Send');
              }}
            />
            <Cell label="SCAN" glyph={<ScanIcon />} onPress={() => navigation.navigate('Scan')} />
          </ActionRow>

          <Gap size={space.step} />
          <ActionRow>
            <Cell
              label="SWAP"
              glyph={<SwapIcon />}
              onPress={() => navigation.navigate('Swap')}
            />
            <Cell
              label="NODES"
              glyph={<NodeIcon />}
              onPress={() => navigation.navigate('Nodes')}
            />
          </ActionRow>

          {vault.state === 'unpaired' ? (
            <>
              <Gap size={space.step} />
              <Body tone={color.slate}>
                Sending needs your vault. Receiving and watching do not.
              </Body>
            </>
          ) : null}
        </View>

        <Gap size={space.section} />

        {/* ---------------------------------------------------- the activity */}
        <View style={{ paddingHorizontal: space.gutter }}>
          <SectionHead
            right={
              <Press onPress={() => navigation.navigate('Activity')}>
                <Label tone={color.ash}>ALL</Label>
              </Press>
            }
          >
            RECENT
          </SectionHead>
          {recent.map((tx, index) => (
            <TxRow
              key={tx.id}
              tx={tx}
              now={now}
              last={index === recent.length - 1}
              onPress={() => navigation.navigate('Transaction', { id: tx.id })}
            />
          ))}
        </View>

        <Gap size={space.section} />

        {/* --------------------------------------------------------- the rail */}
        <View style={{ paddingHorizontal: space.gutter }}>
          <ActionRow>
            <Cell
              label="ACTIVITY"
              tone={color.ash}
              glyph={<ActivityIcon tone={color.ash} />}
              onPress={() => navigation.navigate('Activity')}
            />
            <Cell
              label="ASSETS"
              tone={color.ash}
              glyph={<AssetsIcon tone={color.ash} />}
              onPress={() => navigation.navigate('Asset', { asset: 'BTC' })}
            />
            <Cell
              label="VAULT"
              tone={color.ash}
              glyph={<VaultIcon tone={color.ash} />}
              onPress={() => navigation.navigate('Vault')}
            />
          </ActionRow>

          <Gap size={space.gap} />
          <Press onPress={() => navigation.navigate('Security')}>
            <View style={{ paddingVertical: space.step }}>
              <Label tone={color.slate}>SECURITY · HOW THIS WALLET IS ARRANGED</Label>
            </View>
          </Press>
        </View>
      </ScrollView>
    </Screen>
  );
}
