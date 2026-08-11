/**
 * History, and one detail screen that explains the architecture.
 *
 * The list splits in two rather than paginating: what is still confirming, and
 * what has settled. Pending transactions sit at the top under their own
 * heading and stay there, because a payment waiting for confirmations is the
 * only thing on this screen anybody is anxious about, and it should never be
 * something you scroll to find.
 *
 * The detail screen's job is different: it is where somebody goes weeks later
 * to answer "how did this happen". So it leads with the state, gives every
 * fact in a form that can be checked against a block explorer, and ends with
 * the timeline — which is the only place in the product that lays out the
 * whole two-device journey of a single payment, with the vault's two steps
 * attributed to the vault.
 */

import { ScrollView, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Action, Chip, Gap, Notice, Rule, Screen, FactRow } from '../design/atoms';
import { Body, Label, LabelWide, Mono, Small } from '../design/text';
import { Header, SectionHead } from '../components/chrome';
import { Amount, FiatLine } from '../components/money';
import { Empty, Timeline, TxRow } from '../components/tx';
import { Journey } from '../labyrinth/glyphs';
import { OutIcon } from '../components/icons';
import { color, space } from '../design/tokens';
import { elide, relativeTime } from '../core/units';
import { STAGE_ORDER, type Transaction } from '../core/model';
import { useStore } from '../state/store';
import type { Nav } from '../nav/routes';

export function ActivityScreen({ navigation }: Nav<'Activity'>) {
  const { snapshot, now } = useStore();
  const pending = snapshot.transactions.filter((tx) => tx.stage !== 'confirmed');
  const settled = snapshot.transactions.filter((tx) => tx.stage === 'confirmed');

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView showsVerticalScrollIndicator={false}>
        <Header onBack={() => navigation.goBack()} overline="ACTIVITY" title="Everything that moved" />
        <Gap size={space.gap} />

        <View style={{ paddingHorizontal: space.gutter }}>
          {pending.length > 0 ? (
            <>
              <SectionHead right={<Label tone={color.warn}>{`${pending.length}`}</Label>}>CONFIRMING</SectionHead>
              {pending.map((tx, index) => (
                <TxRow
                  key={tx.id}
                  tx={tx}
                  now={now}
                  last={index === pending.length - 1}
                  onPress={() => navigation.navigate('Transaction', { id: tx.id })}
                />
              ))}
              <Gap size={space.section} />
            </>
          ) : null}

          <SectionHead>SETTLED</SectionHead>
          {settled.length === 0 ? (
            <Empty title="Nothing yet">
              Payments appear here once this wallet has seen them on the chain.
            </Empty>
          ) : (
            settled.map((tx, index) => (
              <TxRow
                key={tx.id}
                tx={tx}
                now={now}
                last={index === settled.length - 1}
                onPress={() => navigation.navigate('Transaction', { id: tx.id })}
              />
            ))
          )}
        </View>
        <Gap size={space.chapter} />
      </ScrollView>
    </Screen>
  );
}

export function TransactionScreen({ navigation, route }: Nav<'Transaction'>) {
  const { snapshot, now } = useStore();
  const tx = snapshot.transactions.find((entry) => entry.id === route.params.id);

  if (!tx) {
    return (
      <Screen>
        <Header onBack={() => navigation.goBack()} overline="TRANSACTION" title="Not found" />
      </Screen>
    );
  }

  const outgoing = tx.direction === 'sent';
  const reached = reachedFor(tx);

  return (
    <Screen>
      <StatusBar style="light" />
      <ScrollView showsVerticalScrollIndicator={false}>
        <Header
          onBack={() => navigation.goBack()}
          overline={outgoing ? 'SENT' : 'RECEIVED'}
          right={<Chip tone={tx.stage === 'confirmed' ? color.slate : color.warn}>{tx.stage.toUpperCase().replace('-', ' ')}</Chip>}
        />

        <Gap size={space.gap} />
        <View style={{ paddingHorizontal: space.gutter }}>
          <Amount atoms={tx.amount} asset={tx.asset} size="readout" tone={outgoing ? color.bone : color.good} />
          <Gap size={space.snug} />
          <FiatLine
            atoms={tx.amount}
            asset={tx.asset}
            centsPerUnit={snapshot.centsPerUnit[tx.asset]}
            stale={snapshot.stale}
          />

          {tx.stage === 'broadcast' ? (
            <>
              <Gap size={space.gap} />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.step }}>
                <LabelWide tone={color.warn}>{`CONFIRMING ${tx.confirmations} OF ${tx.confirmationTarget}`}</LabelWide>
              </View>
              <Gap size={space.snug} />
              <Confirmations have={tx.confirmations} want={tx.confirmationTarget} />
            </>
          ) : null}

          <Gap size={space.section} />
          <Rule />
          <FactRow label={outgoing ? 'DESTINATION' : 'RECEIVED AT'}>
            <Mono size={13}>{elide(tx.counterparty, 10, 8)}</Mono>
          </FactRow>
          {tx.fee > 0n ? (
            <FactRow label="FEE">
              <Amount atoms={tx.fee} asset={tx.asset} size="strong" />
            </FactRow>
          ) : null}
          <FactRow label="BLOCK">{tx.blockHeight ? tx.blockHeight.toLocaleString('en-US') : 'unconfirmed'}</FactRow>
          <FactRow label="CONFIRMATIONS">{`${tx.confirmations}`}</FactRow>
          <FactRow label="WHEN" last>{relativeTime(tx.at, now)}</FactRow>

          <Gap size={space.gap} />
          <Label style={{ marginBottom: space.snug }}>TXID</Label>
          {tx.txid ? (
            <>
              <Mono size={13} tone={color.bone}>{tx.txid.slice(0, 32)}</Mono>
              <Mono size={13} tone={color.bone}>{tx.txid.slice(32)}</Mono>
            </>
          ) : (
            <Body tone={color.slate}>Not broadcast yet.</Body>
          )}

          {outgoing && tx.journey ? (
            <>
              <Gap size={space.section} />
              <View style={{ flexDirection: 'row', gap: space.section, alignItems: 'center' }}>
                <Journey reached={reached} size={120} weight={1.2} />
                <View style={{ flex: 1 }}>
                  <Label style={{ marginBottom: space.step }}>HOW IT HAPPENED</Label>
                  <Small tone={color.slate}>
                    Two of these six steps happened on a device with no network on it. This wallet could
                    not have made them happen on its own.
                  </Small>
                </View>
              </View>
              <Gap size={space.gap} />
              <Timeline
                reached={reached}
                now={now}
                times={Object.fromEntries((tx.journey ?? []).map((step) => [step.stage, step.at]))}
              />
            </>
          ) : null}

          {!outgoing ? (
            <>
              <Gap size={space.section} />
              <Notice title="RECEIVING NEEDS NO SIGNATURE">
                Nothing was signed for this. An address is public, and money arriving at one is the chain's
                business rather than this wallet's, which is why receiving works whether or not your vault
                is anywhere nearby.
              </Notice>
            </>
          ) : null}

          <Gap size={space.section} />
          <Action
            label="VIEW ON CHAIN"
            quiet
            onPress={() => undefined}
            detail="Opens a block explorer in Safari"
          />
          <Gap size={space.snug} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
            <OutIcon size={12} tone={color.dim} />
            <Small tone={color.dim}>A lookup tells that explorer you are interested in this transaction.</Small>
          </View>
        </View>
        <Gap size={space.chapter} />
      </ScrollView>
    </Screen>
  );
}

/**
 * Confirmations as a row of marks rather than a percentage.
 *
 * Six blocks is not 60% of anything; it is six discrete events. A bar implies
 * a rate that does not exist — the next block is a Poisson process, and a
 * progress bar that has been at 83% for forty minutes is a bar that has taught
 * somebody to distrust the screen.
 */
function Confirmations({ have, want }: { have: number; want: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 5 }}>
      {Array.from({ length: want }, (_, index) => (
        <View
          key={index}
          style={{
            width: 22,
            height: 3,
            borderRadius: 2,
            backgroundColor: index < have ? color.warn : color.dim,
          }}
        />
      ))}
    </View>
  );
}

function reachedFor(tx: Transaction): number {
  const index = STAGE_ORDER.indexOf(tx.stage);
  return index < 0 ? 0 : index + 1;
}
