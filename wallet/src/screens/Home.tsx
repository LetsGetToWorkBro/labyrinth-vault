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

import { ScrollView, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Action, ActionRow, Cell, Chip, Gap, Press, Rule, Screen } from '../design/atoms';
import { Body, Display, Label, Small } from '../design/text';
import { SectionHead, VaultStatus, Wordmark } from '../components/chrome';
import { AssetLine } from '../components/money';
import { Allocation } from '../labyrinth/glyphs';
import { TxRow } from '../components/tx';
import { ActivityIcon, AssetsIcon, ReceiveIcon, ScanIcon, SendIcon, VaultIcon } from '../components/icons';
import { assetColor, color, space } from '../design/tokens';
import { fiatCents, formatFiat } from '../core/units';
import { useStore } from '../state/store';
import type { Nav } from '../nav/routes';

export function HomeScreen({ navigation }: Nav<'Home'>) {
  const { snapshot, vault, now, setAsset } = useStore();
  const bitcoin = snapshot.assets.BTC;
  const monero = snapshot.assets.XMR;

  const btcValue = fiatCents(bitcoin.balance, 'BTC', snapshot.centsPerUnit.BTC);
  const xmrValue = fiatCents(monero.balance, 'XMR', snapshot.centsPerUnit.XMR);
  const total = btcValue + xmrValue;

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
            {snapshot.demo ? <Chip tone={color.warn}>DEMO DATA</Chip> : null}
          </View>

          <Gap size={space.snug} />
          <VaultStatus vault={vault} now={now} onPress={() => navigation.navigate('Vault')} />
        </View>

        <Rule />

        {/* ------------------------------------------------------- the total */}
        <View style={{ paddingHorizontal: space.gutter, paddingTop: space.section }}>
          <Label>TOTAL HELD</Label>
          <Gap size={space.step} />
          <Display>{formatFiat(total)}</Display>
          <Gap size={space.gap} />
          <Allocation
            width={342}
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

/** Kept out of the component so the screen file has one export that is a
 *  screen. Used by the empty-wallet state below. */
export function NothingYet({ onConnect }: { onConnect: () => void }) {
  return (
    <View style={{ padding: space.gutter, gap: space.gap }}>
      <Label>NO VAULT</Label>
      <Body>
        This wallet has no account key yet. A vault exports one as a QR code, and until it does there is
        nothing here to watch.
      </Body>
      <Action label="CONNECT VAULT" onPress={onConnect} />
    </View>
  );
}
