/**
 * Type as components, so that a size is chosen once and used by name.
 *
 * Every `<Text>` in this application goes through one of these. Not for
 * tidiness — for the same reason the amounts are integers: a screen that sets
 * its own font size is a screen that will be 15pt when the rest of the
 * application is 15.5, and nobody will ever find it. Naming the roles makes
 * the hierarchy something you can read in the JSX.
 *
 * `Label` deserves its own note. Small caps, wide tracking, one word or two:
 * `VAULT READY`, `WATCH-ONLY`, `UNSIGNED`. It is the voice both halves of
 * Labyrinth speak in when they are naming a state rather than talking to you,
 * and it does most of the work of making the two applications look related. It
 * is never used for a sentence. Sentences are `Body`, in mixed case, because
 * upper-case prose is shouting and this product does not shout — least of all
 * where it is explaining how somebody's money is protected.
 */

import type { ReactNode } from 'react';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';
import { color, face, tabular, type } from './tokens';

interface Props {
  children: ReactNode;
    style?: StyleProp<TextStyle> | undefined;
  /** Override the default color for this role. */
    tone?: string | undefined;
    numberOfLines?: number | undefined;
  /** Turn on tabular figures. Default true for the big readouts. */
    figures?: boolean | undefined;
}

function make(role: keyof typeof type, defaultTone: string, defaultFigures = false) {
  return function Role({ children, style, tone, numberOfLines, figures }: Props) {
    return (
      <Text
        numberOfLines={numberOfLines}
        style={[
          type[role],
          { color: tone ?? defaultTone },
          (figures ?? defaultFigures) ? tabular : null,
          style,
        ]}
      >
        {children}
      </Text>
    );
  };
}

export const Display = make('display', color.bone, true);
export const Readout = make('readout', color.bone, true);
export const Title = make('title', color.bone);
export const Strong = make('strong', color.bone);
export const Body = make('body', color.ash);
export const Small = make('small', color.slate);
export const Label = make('label', color.slate);
export const LabelWide = make('labelWide', color.slate);

/**
 * Monospaced, for anything that gets checked character by character.
 *
 * `selectable` is on by default. An address a person cannot select is an
 * address they will retype by hand, and retyping is where the digit gets
 * dropped.
 */
export function Mono({
  children,
  style,
  tone,
  size = 14,
  numberOfLines,
  selectable = true,
}: Props & { size?: number; selectable?: boolean }) {
  return (
    <Text
      selectable={selectable}
      numberOfLines={numberOfLines}
      style={[
        styles.mono,
        { fontSize: size, lineHeight: Math.round(size * 1.5), color: tone ?? color.ash },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  mono: {
    fontFamily: face.mono,
    letterSpacing: 0.4,
  },
});
