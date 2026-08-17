/**
 * The small pieces, and the rules they encode.
 *
 * There are no cards in this application. A card is a container that says
 * "these things belong together" by drawing a box around them, and a screen
 * made of boxes has the same visual weight everywhere — which means it has no
 * hierarchy, only compartments. Everything here groups with space and separates
 * with a hairline instead, which is how a printed instrument panel does it and
 * how the vault does it.
 *
 * Two exceptions, both earned: `Panel`, for a surface that genuinely sits above
 * the page (a sheet, the QR frame), and `Notice`, for the security statements,
 * which are tinted because the tint is the meaning.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withRepeat, withSpring, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, motion, radius, space } from './tokens';
import { Body, Label, Small, Strong } from './text';
import { tap } from './haptics';

// ------------------------------------------------------------------ surfaces

export function Screen({ children, style }: { children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <SafeAreaView style={[styles.screen, style]}>{children}</SafeAreaView>;
}

/** A horizontal hairline. The only divider in the application. */
export function Rule({ inset = 0, strong = false }: { inset?: number; strong?: boolean }) {
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        marginLeft: inset,
        backgroundColor: strong ? color.ruleStrong : color.rule,
      }}
    />
  );
}

export function Panel({
  children,
  style,
  tone = color.surface,
}: {
  children: ReactNode;
    style?: StyleProp<ViewStyle> | undefined;
    tone?: string | undefined;
}) {
  return <View style={[styles.panel, { backgroundColor: tone }, style]}>{children}</View>;
}

/** Vertical space, named rather than a magic margin at the call site. */
export function Gap({ size = space.gap }: { size?: number }) {
  return <View style={{ height: size }} />;
}

// ------------------------------------------------------------------- pressing

/**
 * Everything tappable in this application goes through here.
 *
 * Two reasons. It presses *in* — a scale to 0.985 and a shade, under a spring —
 * rather than flashing an overlay, because a physical response is what makes a
 * dark interface feel like an instrument rather than a web page. And it fires
 * one haptic, of one weight, in one place, so the whole application has a
 * single vocabulary of touch instead of each screen inventing its own.
 */
export function Press({
  children,
  onPress,
  onPressIn,
  onPressOut,
  disabled,
  style,
  weight = 'light',
  scale = 0.985,
}: {
  children: ReactNode;
    onPress?: (() => void) | undefined;
  /**
   * For the one interaction that is about the holding rather than the tap.
   *
   * Hold-to-reveal on the recovery screen: the words are on the glass while a
   * finger is down and gone when it lifts, so the press *is* the control and
   * `onPress` never fires meaningfully. Routed through here rather than around
   * it, because a second pressable in the codebase is how an application ends
   * up with two vocabularies of touch.
   */
    onPressIn?: (() => void) | undefined;
    onPressOut?: (() => void) | undefined;
    disabled?: boolean | undefined;
    style?: StyleProp<ViewStyle> | undefined;
    weight?: 'light' | 'medium' | 'none' | undefined;
    scale?: number | undefined;
}) {
  const pressed = useSharedValue(0);
  const animated = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - pressed.value * (1 - scale) }],
    opacity: 1 - pressed.value * 0.12,
  }));

  return (
    <Pressable
      disabled={disabled}
      onPressIn={() => {
        pressed.value = withSpring(1, motion.quick);
        onPressIn?.();
      }}
      onPressOut={() => {
        pressed.value = withSpring(0, motion.quick);
        onPressOut?.();
      }}
      onPress={() => {
        if (weight !== 'none') tap(weight);
        onPress?.();
      }}
    >
      <Animated.View style={[animated, disabled ? { opacity: 0.35 } : null, style]}>{children}</Animated.View>
    </Pressable>
  );
}

// -------------------------------------------------------------------- actions

/**
 * The primary action. One per screen, at the bottom, full width.
 *
 * Filled in warm white on near-black, which is the strongest thing this
 * palette can say — deliberately stronger than any asset color, because the
 * most important control on a screen should not be competing with a currency.
 */
export function Action({
  label,
  detail,
  onPress,
  disabled,
  tone,
  quiet,
}: {
  label: string;
    detail?: string | undefined;
    onPress?: (() => void) | undefined;
    disabled?: boolean | undefined;
  /** Overrides the fill. Used exactly once, for a destructive confirmation. */
    tone?: string | undefined;
  /** Outlined rather than filled: a secondary action of equal size. */
    quiet?: boolean | undefined;
}) {
  const fill = quiet ? 'transparent' : (tone ?? color.bone);
  const text = quiet ? color.bone : color.void;
  return (
    <Press onPress={onPress} disabled={disabled} weight="medium" scale={0.975}>
      <View
        style={[
          styles.action,
          {
            backgroundColor: fill,
            borderColor: quiet ? color.ruleStrong : 'transparent',
            borderWidth: quiet ? StyleSheet.hairlineWidth : 0,
          },
        ]}
      >
        <Label tone={text} style={{ letterSpacing: 2.2 }}>
          {label}
        </Label>
        {detail ? (
          <Small tone={quiet ? color.slate : 'rgba(5,5,6,0.55)'} style={{ marginTop: 3 }}>
            {detail}
          </Small>
        ) : null}
      </View>
    </Press>
  );
}

/** A row of two or three equal actions, for the home screen's RECEIVE / SEND /
 *  SCAN and anywhere else a choice is genuinely balanced. */
export function ActionRow({ children }: { children: ReactNode }) {
  return <View style={styles.actionRow}>{children}</View>;
}

export function Cell({
  label,
  glyph,
  onPress,
  tone = color.bone,
}: {
  label: string;
  glyph: ReactNode;
    onPress?: (() => void) | undefined;
    tone?: string | undefined;
}) {
  return (
    <View style={{ flex: 1 }}>
      <Press onPress={onPress} weight="medium">
        <View style={styles.cell}>
          <View style={styles.cellGlyph}>{glyph}</View>
          <Label tone={tone}>{label}</Label>
        </View>
      </Press>
    </View>
  );
}

// ---------------------------------------------------------------------- state

/**
 * The status dot.
 *
 * Three states, and the difference between them is legible without color:
 * `ready` is filled, `offline` is an outline, `working` pulses. A person who
 * cannot tell the green from the amber can still tell a filled circle from a
 * hollow one, and this dot is how the application says whether signing is
 * possible at all.
 */
export function Dot({
  state,
  size = 7,
  tone,
}: {
  state: 'ready' | 'offline' | 'working' | 'alarm';
    size?: number | undefined;
    tone?: string | undefined;
}) {
  const pulse = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ opacity: 0.35 + pulse.value * 0.65 }));

  /* In an effect, and repeating. Reading a shared value during render is both
   * a Reanimated warning and, here, a bug that only shows up in the state that
   * matters: a one-shot fade leaves the dot lit while a handoff is in progress,
   * which is exactly when it is meant to be saying "something is happening". */
  useEffect(() => {
    pulse.value =
      state === 'working'
        ? withRepeat(withTiming(0.15, { duration: 850 }), -1, true)
        : withTiming(1, { duration: 200 });
  }, [state, pulse]);

  const paint = tone ?? (state === 'ready' ? color.good : state === 'alarm' ? color.alarm : color.slate);
  const hollow = state === 'offline';

  return (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: hollow ? 'transparent' : paint,
          borderWidth: hollow ? 1 : 0,
          borderColor: paint,
        },
        state === 'working' ? animated : null,
      ]}
    />
  );
}

/** A small caps chip: `WATCH-ONLY`, `UNSIGNED`, `DEMO DATA`. */
export function Chip({
  children,
  tone = color.slate,
  fill = 'transparent',
  onPress,
}: {
  children: ReactNode;
    tone?: string | undefined;
    fill?: string | undefined;
    onPress?: (() => void) | undefined;
}) {
  const body = (
    <View style={[styles.chip, { backgroundColor: fill, borderColor: fill === 'transparent' ? color.rule : 'transparent' }]}>
      <Label tone={tone}>{children}</Label>
    </View>
  );
  return onPress ? <Press onPress={onPress}>{body}</Press> : body;
}

/**
 * A security statement.
 *
 * The one tinted container in the application. Four tones, and each is a
 * different kind of sentence: `plain` explains, `good` confirms, `warn`
 * qualifies, `alarm` refuses. They are set in mixed case at body size because
 * they are prose, and the thing being explained — where somebody's keys are —
 * deserves to be readable rather than stamped.
 */
export function Notice({
  title,
  children,
  tone = 'plain',
}: {
    title?: string | undefined;
  children: ReactNode;
    tone?: 'plain' | 'good' | 'warn' | 'alarm' | undefined;
}) {
  const paint =
    tone === 'good' ? color.good : tone === 'warn' ? color.warn : tone === 'alarm' ? color.alarm : color.slate;
  const fill =
    tone === 'good' ? color.goodDim : tone === 'warn' ? color.warnDim : tone === 'alarm' ? color.alarmDim : color.well;

  return (
    <View style={[styles.notice, { backgroundColor: fill }]}>
      <View style={[styles.noticeEdge, { backgroundColor: paint }]} />
      <View style={{ flex: 1 }}>
        {title ? <Label tone={paint} style={{ marginBottom: 6 }}>{title}</Label> : null}
        <Body tone={tone === 'plain' ? color.ash : color.bone}>{children}</Body>
      </View>
    </View>
  );
}

/** A label above a value: the unit of every detail screen in the product. */
export function Datum({
  label,
  children,
  align = 'left',
}: {
  label: string;
  children: ReactNode;
    align?: 'left' | 'right' | undefined;
}) {
  return (
    <View style={{ alignItems: align === 'right' ? 'flex-end' : 'flex-start' }}>
      <Label style={{ marginBottom: 5 }}>{label}</Label>
      {typeof children === 'string' ? <Strong>{children}</Strong> : children}
    </View>
  );
}

/** Label on the left, value on the right, hairline underneath. The list row
 *  for every set of facts in the application. */
export function FactRow({
  label,
  children,
  onPress,
  last,
}: {
  label: string;
  children: ReactNode;
    onPress?: (() => void) | undefined;
    last?: boolean | undefined;
}) {
  const body = (
    <View>
      <View style={styles.factRow}>
        <Label>{label}</Label>
        <View style={{ flexShrink: 1, alignItems: 'flex-end' }}>
          {typeof children === 'string' ? <Strong>{children}</Strong> : children}
        </View>
      </View>
      {last ? null : <Rule />}
    </View>
  );
  return onPress ? <Press onPress={onPress}>{body}</Press> : body;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: color.void,
  },
  panel: {
    borderRadius: radius.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.rule,
    overflow: 'hidden',
  },
  action: {
    height: 58,
    borderRadius: radius.soft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionRow: {
    flexDirection: 'row',
    gap: space.snug,
  },
  cell: {
    height: 96,
    borderRadius: radius.soft,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.rule,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.step,
  },
  cellGlyph: {
    height: 26,
    justifyContent: 'center',
  },
  chip: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: radius.round,
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: 'flex-start',
  },
  notice: {
    flexDirection: 'row',
    gap: space.step,
    padding: space.gap,
    borderRadius: radius.soft,
  },
  noticeEdge: {
    width: 2,
    borderRadius: 1,
    opacity: 0.7,
  },
  factRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.gap,
    paddingVertical: space.gap,
  },
});

/**
 * A sentence you can have, and the paragraph behind it if you want it.
 *
 * This app writes unusually good explanatory prose and puts too much of it in
 * the primary reading path. The balance on Home carried two sentences about
 * price relays directly underneath it; the send flow carries about fifteen
 * such passages. Every clause is true and worth saying somewhere, and directly
 * under the number is not somewhere.
 *
 * Deleting it would be the wrong fix twice over: the writing is the product's
 * voice, and the facts it carries are the ones that stop somebody
 * misreading a screen. So the summary stays visible, the argument moves one
 * tap away, and the control says WHY rather than "more" because the thing
 * behind it is a reason.
 *
 * Closed by default, always. A disclosure that remembers being open is a
 * paragraph that comes back.
 */
export function Disclosure({
  summary,
  children,
  tone,
}: {
  summary: string;
  children: ReactNode;
  tone?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Press onPress={() => setOpen((was) => !was)} weight="none">
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.snug }}>
          <Small tone={tone ?? color.dim} style={{ flex: 1 }}>{summary}</Small>
          <Label tone={color.slate}>{open ? 'LESS' : 'WHY'}</Label>
        </View>
      </Press>
      {open ? (
        <Animated.View entering={FadeIn.duration(140)}>
          <Gap size={space.snug} />
          {children}
        </Animated.View>
      ) : null}
    </View>
  );
}
