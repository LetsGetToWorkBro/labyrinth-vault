/**
 * Transactions in a list, and the timeline that explains one.
 *
 * ## The row
 *
 * Not a banking row. A banking row says what happened to a balance; this one
 * has to say where a payment is in a system with two devices in it, which is a
 * different question and occasionally an urgent one.
 *
 * So the row leads with direction and state rather than with an amount: an
 * arrow, and a word. `SENT / CONFIRMED`. `RECEIVED / CONFIRMED`. And for the
 * one that matters, `BROADCAST / CONFIRMING 2 OF 6`, with the count moving.
 * The amount is on the right where a column of amounts can be scanned, and the
 * asset is a three-point rule down the left edge — enough to sort by at a
 * glance, not enough to make a list of payments look like a chart.
 *
 * ## The timeline
 *
 * Six stages, two of which happened on a device this one cannot see. That is
 * the whole architecture, and this is where a person meets it in a form they
 * can check: their payment, with `VERIFIED BY VAULT` and `SIGNED` sitting in
 * the middle of it, attributed to the other half.
 *
 * The stages the vault performed are marked as the vault's. Not decoration:
 * somebody reading this later, wondering whether a payment could have gone out
 * without them approving it, can see that two of these steps are not
 * something this device is able to do.
 */

import { View } from 'react-native';
import { Body, Label, Mono, Small, Strong } from '../design/text';
import { Press, Rule } from '../design/atoms';
import { Amount } from './money';
import { assetColor, color, space } from '../design/tokens';
import { elide, relativeTime } from '../core/units';
import { JOURNEY, type Stage, type Transaction } from '../core/model';

function stageWords(tx: Transaction): { word: string; tone: string; detail: string | null } {
  switch (tx.stage) {
    case 'confirmed':
      return { word: 'CONFIRMED', tone: color.slate, detail: null };
    case 'broadcast':
      return {
        word: 'CONFIRMING',
        tone: color.warn,
        detail: `${tx.confirmations} OF ${tx.confirmationTarget}`,
      };
    case 'awaiting-signature':
      return { word: 'AT THE VAULT', tone: color.warn, detail: null };
    case 'signed':
      return { word: 'SIGNED', tone: color.good, detail: 'NOT YET BROADCAST' };
    case 'failed':
      return { word: 'FAILED', tone: color.alarm, detail: null };
    default:
      return { word: 'PREPARED', tone: color.slate, detail: 'UNSIGNED' };
  }
}

export function TxRow({
  tx,
  now,
  onPress,
  last,
}: {
  tx: Transaction;
  now: number;
    onPress?: (() => void) | undefined;
    last?: boolean | undefined;
}) {
  const state = stageWords(tx);
  const outgoing = tx.direction === 'sent';

  return (
    <View>
      <Press onPress={onPress}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.gap, paddingVertical: 18 }}>
          <View style={{ width: 2.5, height: 30, borderRadius: 2, backgroundColor: assetColor(tx.asset) }} />
          <View style={{ flex: 1, gap: 5 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.snug }}>
              <Label tone={color.bone}>{outgoing ? '↑ SENT' : '↓ RECEIVED'}</Label>
              <Label tone={state.tone}>{state.word}</Label>
              {state.detail ? <Label tone={color.dim}>{state.detail}</Label> : null}
            </View>
            <Small tone={color.slate}>
              {outgoing ? 'to ' : 'from '}
              {elide(tx.counterparty, 8, 6)} · {relativeTime(tx.at, now)}
            </Small>
          </View>
          <Amount
            atoms={tx.amount}
            asset={tx.asset}
            size="strong"
            ticker={false}
            tone={outgoing ? color.bone : color.good}
            align="right"
          />
        </View>
      </Press>
      {last ? null : <Rule inset={18} />}
    </View>
  );
}

/**
 * The journey, vertically, with the vault's two steps attributed to it.
 *
 * `reached` counts completed stages. Anything past it is drawn dim and
 * unattributed, because a stage that has not happened has no time to show and
 * inventing one ("estimated 2 minutes") would be the fourth lie in a product
 * built to avoid the first three.
 */
export function Timeline({
  reached,
  times,
  now,
  waiting,
}: {
  reached: number;
    times?: Partial<Record<Stage, number>> | undefined;
  now: number;
    waiting?: boolean | undefined;
}) {
  return (
    <View>
      {JOURNEY.map((step, index) => {
        const done = index < reached;
        const current = index === reached;
        const at = times?.[step.stage];
        const tone = done ? color.bone : current ? color.warn : color.dim;

        return (
          <View key={step.stage} style={{ flexDirection: 'row', gap: space.gap }}>
            <View style={{ alignItems: 'center', width: 12 }}>
              <View
                style={{
                  width: done || current ? 7 : 5,
                  height: done || current ? 7 : 5,
                  borderRadius: 4,
                  marginTop: 6,
                  backgroundColor: done ? color.bone : current ? color.warn : 'transparent',
                  borderWidth: done ? 0 : 1,
                  borderColor: current ? color.warn : color.dim,
                }}
              />
              {index < JOURNEY.length - 1 ? (
                <View
                  style={{
                    width: 1,
                    flex: 1,
                    minHeight: 26,
                    marginVertical: 4,
                    backgroundColor: done ? color.ruleStrong : color.rule,
                  }}
                />
              ) : null}
            </View>
            <View style={{ flex: 1, paddingBottom: index < JOURNEY.length - 1 ? space.gap : 0 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.snug }}>
                <Label tone={tone}>{step.label}</Label>
                {step.by === 'vault' ? <Label tone={done ? color.slate : color.dim}>· VAULT</Label> : null}
              </View>
              <Small tone={color.slate} style={{ marginTop: 3 }}>
                {at
                  ? relativeTime(at, now)
                  : current && waiting
                    ? 'Waiting on the other device'
                    : current
                      ? 'Now'
                      : '—'}
              </Small>
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** A transaction id, set to be checked and long enough to be worth eliding. */
export function TxId({ txid }: { txid: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Mono size={13} tone={color.ash}>
        {txid.slice(0, 32)}
      </Mono>
      <Mono size={13} tone={color.ash}>
        {txid.slice(32)}
      </Mono>
    </View>
  );
}

export function Empty({ title, children }: { title: string; children: string }) {
  return (
    <View style={{ paddingVertical: space.chapter, gap: space.snug }}>
      <Strong tone={color.ash}>{title}</Strong>
      <Body>{children}</Body>
    </View>
  );
}
