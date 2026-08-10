/**
 * Headers, and the status line that is the point of the product.
 *
 * The header is not a navigation bar. It has no centered title and no chevron,
 * because a large title that scrolls under a blurred bar is an iOS convention
 * for content, and these screens are not content — they are an instrument with
 * a name at the top of it. The back affordance is a small mark on the left and
 * the swipe gesture, which is what people actually use.
 *
 * `VaultStatus` is the line under the wordmark, and it is the most important
 * two words on the home screen. It answers, before anything else, the question
 * that decides what this device can do right now: can a payment be signed. It
 * never says "connected", because there is no connection — see `Link` in
 * `labyrinth/glyphs.tsx`. It says READY, meaning: this wallet holds an account
 * key, it can build a transaction, and there is a vault somewhere that can
 * sign it. Or OFFLINE, meaning: there is no vault paired with this device, and
 * everything except spending still works.
 */

import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Label, LabelWide, Small, Title } from '../design/text';
import { Dot, Press, Rule } from '../design/atoms';
import { Mark } from '../labyrinth/glyphs';
import { color, space } from '../design/tokens';
import { sessionTime } from '../core/units';
import type { VaultLink } from '../core/model';

export function Header({
  title,
  onBack,
  right,
  overline,
}: {
    title?: string | undefined;
    onBack?: (() => void) | undefined;
    right?: ReactNode | undefined;
    overline?: string | undefined;
}) {
  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        {onBack ? (
          <Press onPress={onBack} style={styles.back}>
            <View style={styles.backInner}>
              <Mark size={14} tone={color.ash} weight={1.1} />
              <Label tone={color.ash}>BACK</Label>
            </View>
          </Press>
        ) : (
          <View style={{ height: 20 }} />
        )}
        <View style={{ flex: 1 }} />
        {right}
      </View>
      {overline ? <LabelWide style={{ marginTop: space.gap }}>{overline}</LabelWide> : null}
      {title ? <Title style={{ marginTop: overline ? 6 : space.gap }}>{title}</Title> : null}
    </View>
  );
}

/**
 * The wordmark. Two lines, because the product is two words and the second one
 * is the half you are holding.
 */
export function Wordmark({ half = 'WALLET' }: { half?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.step }}>
      <Mark size={20} tone={color.bone} weight={1.3} />
      <View>
        <Label tone={color.bone} style={{ letterSpacing: 3.4 }}>
          LABYRINTH
        </Label>
        <Label tone={color.slate} style={{ letterSpacing: 3.4, marginTop: 2 }}>
          {half}
        </Label>
      </View>
    </View>
  );
}

export function VaultStatus({ vault, now, onPress }: { vault: VaultLink; now: number; onPress?: () => void }) {
  const ready = vault.state !== 'unpaired';
  const busy = vault.state === 'in-session';

  return (
    <Press onPress={onPress}>
      <View style={styles.status}>
        <Dot state={busy ? 'working' : ready ? 'ready' : 'offline'} />
        <View>
          <Label tone={ready ? color.bone : color.slate}>
            {busy ? 'VAULT · IN SESSION' : ready ? 'VAULT · READY' : 'VAULT · OFFLINE'}
          </Label>
          <Small tone={color.slate} style={{ marginTop: 3 }}>
            {vault.state === 'unpaired'
              ? 'No vault paired. Balances and receiving still work.'
              : vault.lastSession
                ? `Last session ${sessionTime(vault.lastSession, now)}`
                : 'Paired. Nothing signed yet.'}
          </Small>
        </View>
      </View>
    </Press>
  );
}

/** A section heading: a caps label with a rule running off to the right. */
export function SectionHead({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <View style={{ marginBottom: space.step }}>
      <View style={styles.sectionRow}>
        <LabelWide>{children}</LabelWide>
        <View style={{ flex: 1 }} />
        {right}
      </View>
      <Rule />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: space.gutter,
    paddingTop: space.snug,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 24,
  },
  back: {
    marginLeft: -4,
  },
  backInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.snug,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.step,
    paddingVertical: space.step,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingBottom: space.snug,
    gap: space.step,
  },
});
