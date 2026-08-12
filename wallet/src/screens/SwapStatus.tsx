/**
 * Where a swap is, on the provider's say-so.
 *
 * This screen exists because a swap outlives every other flow in the app: the
 * deposit goes through the send flow and the vault, and then the exchange
 * works for minutes to hours while this wallet has nothing to do but ask. So
 * the order is minded in the store, restored across relaunches, and this
 * screen renders the answer to one question: how far along the road is it.
 *
 * Three rules, all inherited:
 *
 * **Pull, never poll.** The rest of this wallet refreshes when a person asks,
 * because polling a server on a timer tells that server exactly when this
 * phone is awake. An exchange already knows more about this swap than anyone;
 * it does not also need a heartbeat. The status is fetched when the screen
 * opens and when the person asks again, and the screen says when it last
 * asked.
 *
 * **The provider's words, through the one translation.** Every stage sentence
 * comes from STAGE_LINES, and the provider's own raw word is shown beside the
 * terminal states, because "failed" from a screen and "failed" from the
 * exchange are different claims and a person chasing an order needs the
 * second one.
 *
 * **The journey does not guess.** The lit trail shows stages the provider has
 * confirmed passed. A terminal state freezes the geometry rather than
 * inventing how far the money got: the provider says "refunded", not
 * "refunded after exchanging".
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Action, Dot, FactRow, Gap, Notice, Press, Rule, Screen } from '../design/atoms';
import { Body, Label, Mono, Small, Strong } from '../design/text';
import { Header } from '../components/chrome';
import { Amount } from '../components/money';
import { Journey } from '../labyrinth/glyphs';
import { color, space, tabular } from '../design/tokens';
import { arrived, settled } from '../design/haptics';
import { parseAmount as parseAtoms, relativeTime } from '../core/units';
import { useStore } from '../state/store';
import type { Nav } from '../nav/routes';
import type { Asset } from '../core/model';
import { PROVIDERS, swapCoin, type SwapStage } from '../core/swap';
import { JOURNEY_STAGES, journeyOf } from '../core/swaptrack';

export function SwapStatusScreen({ navigation }: Nav<'SwapStatus'>) {
  const store = useStore();
  const pending = store.pendingSwap;
  const check = store.swapCheck;
  const [asking, setAsking] = useState(false);

  const refresh = useCallback(async () => {
    setAsking(true);
    try {
      await store.refreshSwap();
    } finally {
      setAsking(false);
    }
  }, [store]);

  /* Once, when the screen opens. Asking again is the person's move. */
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* A stage that moved gets a beat; arrival gets the latch. An answer that
   * says what the last one said gets silence, because nothing happened. */
  const lastStage = useRef<SwapStage | null>(null);
  useEffect(() => {
    const stage = check?.status.stage ?? null;
    if (stage && lastStage.current && stage !== lastStage.current) {
      if (stage === 'done') arrived();
      else settled();
    }
    if (stage) lastStage.current = stage;
  }, [check]);

  if (!pending) {
    return (
      <Screen>
        <StatusBar style="light" />
        <Header title="SWAP" onBack={() => navigation.goBack()} />
        <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: space.gutter }}>
          <Label>NO SWAP IN FLIGHT</Label>
          <Gap size={space.snug} />
          <Body>
            When an order is created, its journey lives here until it is done
            or you dismiss it.
          </Body>
        </View>
      </Screen>
    );
  }

  const from = swapCoin(pending.fromId);
  const to = swapCoin(pending.toId);
  const provider = PROVIDERS.find((p) => p.id === pending.provider)!;
  const stage: SwapStage = check?.status.stage ?? 'waiting';
  const journey = journeyOf(stage);
  const rate = pending.toAmount / pending.fromAmount;
  const trimmed = (n: number) => String(Number(n.toPrecision(6)));

  /* The glyph lights confirmed ground plus the step being walked; a terminal
   * state holds at one so the geometry reads as begun and stopped. The spiral
   * has six stops and the road five stages, so done fills it. */
  const glyphReached = journey.ended ? 1 : stage === 'done' ? 6 : journey.reached + 1;

  const title =
    journey.ended ? 'Where it stopped'
    : stage === 'done' ? 'Swap complete'
    : 'Where it stands';

  return (
    <Screen>
      <StatusBar style="light" />
      <Header overline="SWAP" title={title} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: space.gutter }}>
        {/* The two sides, as quoted at creation. The record of intent: these
            numbers never update from a status answer. */}
        <View style={styles.sides}>
          <View style={{ flex: 1 }}>
            <Label style={{ marginBottom: 5 }}>YOU SENT</Label>
            <SideAmount amountText={String(pending.fromAmount)} ours={from?.ours ?? null} ticker={from?.ticker ?? pending.fromId} />
          </View>
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <Label style={{ marginBottom: 5 }}>YOU RECEIVE</Label>
            <SideAmount
              approx
              amountText={String(pending.toAmount)}
              ours={to?.ours ?? null}
              ticker={to?.ticker ?? pending.toId}
              align="right"
            />
          </View>
        </View>

        <Gap size={space.section} />
        <View style={{ alignItems: 'center' }}>
          <Journey
            reached={glyphReached}
            size={180}
            waiting={journey.inFlight && !journey.ended}
            tone={journey.ended ? color.slate : color.bone}
          />
        </View>
        <Gap size={space.section} />

        {/* The road, stage by stage, in the words STAGE_LINES already uses. */}
        {journey.steps.map((step, index) => (
          <View key={step.stage}>
            <View style={styles.stageRow}>
              <Dot
                state={step.state === 'done' ? 'ready' : step.state === 'current' ? 'working' : 'offline'}
                tone={step.state === 'done' ? color.bone : step.state === 'current' ? color.warn : color.slate}
              />
              <Label tone={step.state === 'ahead' ? color.dim : color.bone} style={{ flex: 1 }}>
                {step.label}
              </Label>
              {step.state === 'current' && asking ? <Small tone={color.slate}>asking</Small> : null}
            </View>
            {index < JOURNEY_STAGES.length - 1 ? <Rule inset={19} /> : null}
          </View>
        ))}

        {journey.ended ? (
          <>
            <Gap size={space.section} />
            <Notice
              title={journeyEndTitle(journey.ended)}
              tone={journey.ended === 'failed' ? 'alarm' : 'warn'}
            >
              {journeyEndBody(journey.ended)}
              {check ? ` The exchange's own word for it: "${check.status.raw}".` : ''}
            </Notice>
          </>
        ) : null}

        <Gap size={space.section} />
        <FactRow label="RATE">{`1 ${(from?.ticker ?? '').toUpperCase()} ≈ ${trimmed(rate)} ${(to?.ticker ?? '').toUpperCase()}`}</FactRow>
        <FactRow label="ROUTE">{provider.label}</FactRow>
        <FactRow label="ORDER">
          <Mono size={12} tone={color.bone}>{pending.id}</Mono>
        </FactRow>
        {check?.status.txId ? (
          <FactRow label="PAYOUT TX">
            <Mono size={12} tone={color.bone} numberOfLines={1}>{check.status.txId}</Mono>
          </FactRow>
        ) : null}
        <FactRow label="CREATED" last={!check}>{relativeTime(pending.createdAt, store.now)}</FactRow>
        {check ? (
          <FactRow label="CHECKED" last>{relativeTime(check.at, store.now)}</FactRow>
        ) : null}

        <Gap size={space.section} />
        {stage === 'done' || journey.ended ? (
          <View style={{ gap: space.snug }}>
            <Action
              label="DONE"
              onPress={() => {
                store.dismissSwap();
                navigation.goBack();
              }}
            />
            {journey.ended ? (
              <Action label={asking ? 'ASKING' : 'CHECK AGAIN'} quiet disabled={asking} onPress={() => void refresh()} />
            ) : null}
          </View>
        ) : (
          <View style={{ gap: space.snug }}>
            <Action label={asking ? 'ASKING' : 'CHECK STATUS'} disabled={asking} onPress={() => void refresh()} />
            <Press onPress={() => { store.dismissSwap(); navigation.goBack(); }}>
              <View style={{ alignItems: 'center', paddingVertical: space.step }}>
                <Label tone={color.slate}>STOP MINDING THIS ORDER</Label>
              </View>
            </Press>
          </View>
        )}

        <Gap />
        <Small>
          The exchange holds the order; this screen only asks about it. Checking
          again is always safe, and dismissing the order here cancels nothing.
        </Small>
        <Gap size={space.chapter} />
      </ScrollView>
    </Screen>
  );
}

/** An amount as quoted: through the real Amount treatment when the coin is
 *  one this wallet holds, and the same visual shape when it is not. */
function SideAmount({
  amountText,
  ours,
  ticker,
  approx = false,
  align = 'left',
}: {
  amountText: string;
  ours: Asset | null;
  ticker: string;
  approx?: boolean;
  align?: 'left' | 'right';
}) {
  if (ours) {
    const parsed = parseAtoms(amountText, ours);
    if (parsed.ok && parsed.atoms !== undefined) {
      return <Amount atoms={parsed.atoms} asset={ours} size="strong" align={align} />;
    }
  }
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
      <Strong figures>{approx ? `≈ ${amountText}` : amountText}</Strong>
      <View style={{ width: 5 }} />
      <Label tone={color.slate} style={tabular}>{ticker.toUpperCase()}</Label>
    </View>
  );
}

function journeyEndTitle(ended: 'refunded' | 'expired' | 'failed'): string {
  return ended === 'refunded' ? 'REFUNDED' : ended === 'expired' ? 'EXPIRED' : 'SWAP FAILED';
}

function journeyEndBody(ended: 'refunded' | 'expired' | 'failed'): string {
  switch (ended) {
    case 'refunded':
      return 'The exchange sent your coins back to the refund address this wallet derived. Look for them on the receive side.';
    case 'expired':
      return 'The order lapsed before a deposit arrived. If the deposit was sent, contact the exchange with the order id below; nothing here can move it.';
    case 'failed':
      return "The exchange reports this order failed. Contact them with the order id below; the deposit and payout are in their hands, not this wallet's.";
  }
}

const styles = StyleSheet.create({
  sides: {
    flexDirection: 'row',
    gap: space.gap,
  },
  stageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.step,
    paddingVertical: space.step,
  },
});
