/**
 * Six glyphs, drawn on the same grid as the labyrinth mark.
 *
 * All of them are strokes on a 24-unit box at 1.4 weight with square caps and
 * mitred joins — the same pen as the mark, so an icon beside it does not look
 * borrowed. No filled shapes, no circles, no rounded ends: the vocabulary is
 * right angles and straight lines, because that is what the motif is.
 *
 * There is no icon for an asset. Bitcoin and Monero are named in words, and
 * the colored rule down the edge of a row does the sorting. A wallet full of
 * coin logos is a wallet that has decided its content is brands.
 */

import Svg, { Path } from 'react-native-svg';
import { color } from '../design/tokens';

interface IconProps {
    size?: number | undefined;
    tone?: string | undefined;
    weight?: number | undefined;
}

function Glyph({ size = 22, tone = color.bone, weight = 1.4, d }: IconProps & { d: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={d} stroke={tone} strokeWidth={weight} fill="none" strokeLinecap="square" strokeLinejoin="miter" />
    </Svg>
  );
}

/** Down into a line: something arriving at this device. */
export function ReceiveIcon(props: IconProps) {
  return <Glyph {...props} d="M12 3 V15 M6 10 L12 16 L18 10 M4 20 H20" />;
}

/** Up out of a line: something leaving, which here means going to the vault
 *  first. The line at the bottom is this device; the arrow does not start
 *  inside it. */
export function SendIcon(props: IconProps) {
  return <Glyph {...props} d="M12 21 V9 M6 14 L12 8 L18 14 M4 4 H20" />;
}

/** Four corners: a camera looking at something. */
export function ScanIcon(props: IconProps) {
  return <Glyph {...props} d="M3 8 V3 H8 M16 3 H21 V8 M21 16 V21 H16 M8 21 H3 V16 M3 12 H21" />;
}

/** A stack of rules: history. */
export function ActivityIcon(props: IconProps) {
  return <Glyph {...props} d="M4 6 H20 M4 12 H14 M4 18 H17" />;
}

/** Two nested squares: holdings, one inside the other. */
export function AssetsIcon(props: IconProps) {
  return <Glyph {...props} d="M3 3 H21 V21 H3 Z M8 8 H16 V16 H8 Z" />;
}

/** A closed shape with a gap at the top: the vault, and the one way in. */
export function VaultIcon(props: IconProps) {
  return <Glyph {...props} d="M14 3 H21 V21 H3 V3 H10 M12 8 V13 M9 11 H15" />;
}

/** A tick, for a state that has been checked rather than merely finished. */
export function CheckIcon(props: IconProps) {
  return <Glyph {...props} d="M4 12 L9 17 L20 6" />;
}

/** A cross, used once: a transaction that does not match. */
export function CrossIcon(props: IconProps) {
  return <Glyph {...props} d="M5 5 L19 19 M19 5 L5 19" />;
}

/** Two sheets: copy. */
export function CopyIcon(props: IconProps) {
  return <Glyph {...props} d="M8 3 H21 V16 M3 8 H16 V21 H3 Z" />;
}

/** Out of a box: share, and open on the chain. */
export function OutIcon(props: IconProps) {
  return <Glyph {...props} d="M12 4 H4 V20 H20 V12 M14 4 H20 V10 M20 4 L11 13" />;
}

/**
 * Two arrows passing, for a swap.
 *
 * Deliberately not a circular-arrows glyph. A swap in this wallet is not a
 * refresh and not a loop: coins leave on one chain and different coins arrive
 * on another, and the two paths never meet. The icon says that.
 */
export function SwapIcon(props: IconProps) {
  return <Glyph {...props} d="M4 8 h12 l-4 -4 M20 16 h-12 l4 4" />;
}

/** A box with a line out of it: something this device talks to and does not
 *  contain. Deliberately not a cloud. */
export function NodeIcon(props: IconProps) {
  return <Glyph {...props} d="M4 6 H14 V14 H4 Z M14 10 H21 M18 7 L21 10 L18 13" />;
}
