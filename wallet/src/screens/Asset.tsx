/**
 * One chain, on its own terms.
 *
 * Bitcoin and Monero are not two skins of the same screen and pretending
 * otherwise produces a page that is wrong about both. Bitcoin has unspent
 * outputs, a fee market measured in vbytes and a gap limit; Monero has a view
 * key, one address, and a fee the daemon quotes. So the facts listed here
 * differ by chain, and the ones that do not apply are absent rather than
 * showing a dash.
 *
 * What both screens share is the shape of the claim at the bottom: this wallet
 * watches this chain with a key that cannot spend from it.
 */

import { ScrollView, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Action, ActionRow, Cell, Chip, FactRow, Gap, Notice, Rule, Screen } from '../design/atoms';
import { Label, Mono, Small } from '../design/text';
import { Header, SectionHead } from '../components/chrome';
import { Amount, FiatLine } from '../components/money';
import { Empty, TxRow } from '../components/tx';
import { ReceiveIcon, SendIcon } from '../components/icons';
import { assetColor, color, space } from '../design/tokens';
import { elide, formatFiat, hasPrice } from '../core/units';
import { TICKER_NAME } from '../core/model';
import { useStore } from '../state/store';
import type { Nav } from '../nav/routes';

export function AssetScreen({ navigation, route }: Nav<'Asset'>) {
  const store = useStore();
  const asset = route.params.asset;
  const view = store.snapshot.assets[asset];
  const history = store.snapshot.transactions.filter((tx) => tx.asset === asset);
  /* Bitcoin only. On the Monero side `spendable` is deliberately zero, because
   * this half of the product cannot build a Monero spend at all, and
   * subtracting that from the balance would label every coin unconfirmed. */
  const unconfirmed = asset === 'BTC' ? view.balance - view.spendable : 0n;

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView showsVerticalScrollIndicator={false}>
        <Header
          onBack={() => navigation.goBack()}
          overline={TICKER_NAME[asset]}
          right={
            <View style={{ flexDirection: 'row', gap: space.snug }}>
              {(['BTC', 'XMR'] as const).map((which) => (
                <Chip
                  key={which}
                  tone={which === asset ? color.void : color.slate}
                  fill={which === asset ? assetColor(which) : 'transparent'}
                  onPress={() => navigation.setParams({ asset: which })}
                >
                  {which}
                </Chip>
              ))}
            </View>
          }
        />

        <Gap size={space.gap} />
        <View style={{ paddingHorizontal: space.gutter }}>
          <Amount atoms={view.balance} asset={asset} size="readout" />
          <Gap size={space.snug} />
          <FiatLine
            atoms={view.balance}
            asset={asset}
            centsPerUnit={store.snapshot.centsPerUnit[asset]}
            stale={store.snapshot.stale}
          />

          {/* Directly under the number, not at the bottom of the page. A
              caveat about what a figure means is only doing its job if it is
              read before somebody acts on the figure. */}
          {view.caveat ? (
            <>
              <Gap size={space.snug} />
              <Notice title="WHAT THIS NUMBER IS" tone="warn">
                {view.caveat}
              </Notice>
            </>
          ) : null}

          <Gap size={space.section} />
          <ActionRow>
            <Cell
              label="RECEIVE"
              glyph={<ReceiveIcon />}
              onPress={() => navigation.navigate('Receive', { asset })}
            />
            <Cell
              label="SEND"
              glyph={<SendIcon />}
              onPress={() => {
                store.setAsset(asset);
                navigation.navigate('Send');
              }}
            />
          </ActionRow>

          <Gap size={space.section} />
          <SectionHead>THIS WALLET</SectionHead>
          <Rule />
          {unconfirmed > 0n ? (
            <FactRow label="UNCONFIRMED">
              <Amount atoms={unconfirmed} asset={asset} size="strong" />
            </FactRow>
          ) : null}
          {asset === 'BTC' ? (
            <>
              <FactRow label="COINS">{`${view.utxos.length}`}</FactRow>
              <FactRow label="DERIVATION">
                <Mono size={13}>m/84'/0'/0'</Mono>
              </FactRow>
              <FactRow label="ADDRESSES SEEN">{`${view.addresses.filter((entry) => entry.used).length}`}</FactRow>
            </>
          ) : (
            <>
              <FactRow label="ADDRESS">
                <Mono size={13}>{elide(view.addresses[0]?.address ?? '', 8, 8)}</Mono>
              </FactRow>
              <FactRow label="KEY HELD HERE">VIEW KEY ONLY</FactRow>
            </>
          )}
          <FactRow label="SETTLES AT">{`${view.confirmationTarget} blocks`}</FactRow>
          {/* The price row exists only when a price does. With no source the
              row would read "$0.00", which is not a fact about the coin, and a
              fact list is the last place to put a number that is not one. */}
          {hasPrice(store.snapshot.centsPerUnit[asset]) ? (
            <>
              <FactRow label="CHAIN TIP">{view.height.toLocaleString('en-US')}</FactRow>
              <FactRow label="PRICE" last>{formatFiat(store.snapshot.centsPerUnit[asset])}</FactRow>
            </>
          ) : (
            <FactRow label="CHAIN TIP" last>{view.height.toLocaleString('en-US')}</FactRow>
          )}

          {asset === 'BTC' ? (
            <>
              <Gap size={space.section} />
              <SectionHead right={<Label tone={color.slate}>{`${view.utxos.length}`}</Label>}>COINS</SectionHead>
              {view.utxos.map((utxo, index) => (
                <View key={`${utxo.txid}:${utxo.vout}`}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: space.step }}>
                    <View style={{ flex: 1, gap: 4 }}>
                      <Mono size={13} tone={color.ash}>
                        {elide(utxo.txid, 8, 6)}:{utxo.vout}
                      </Mono>
                      <Small tone={color.slate}>
                        {utxo.confirmations > 0 ? `${utxo.confirmations} confirmations` : 'unconfirmed'} · {utxo.path.change === 0 ? 'received' : 'change'}
                      </Small>
                    </View>
                    <Amount atoms={utxo.value} asset="BTC" size="strong" ticker={false} />
                  </View>
                  {index === view.utxos.length - 1 ? null : <Rule />}
                </View>
              ))}
            </>
          ) : null}

          <Gap size={space.section} />
          <SectionHead>HISTORY</SectionHead>
          {history.length === 0 ? (
            <Empty title="Nothing on this chain yet">
              Payments in and out of this asset will appear here.
            </Empty>
          ) : (
            history.map((tx, index) => (
              <TxRow
                key={tx.id}
                tx={tx}
                now={store.now}
                last={index === history.length - 1}
                onPress={() => navigation.navigate('Transaction', { id: tx.id })}
              />
            ))
          )}

          <Gap size={space.section} />
          <Notice title="WATCH-ONLY">
            {asset === 'BTC'
              ? 'This wallet holds an extended public key. It can derive every address this account will ever use and cannot produce a single signature for any of them.'
              : 'This wallet holds a view key. It can see what arrives and cannot author anything that leaves.'}
          </Notice>

          <Gap size={space.section} />
          <Action label="SECURITY" quiet onPress={() => navigation.navigate('Security')} />
        </View>
        <Gap size={space.chapter} />
      </ScrollView>
    </Screen>
  );
}
