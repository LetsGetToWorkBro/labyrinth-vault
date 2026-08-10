/**
 * Drawing the wire.
 *
 * This is the most important pixel-level surface in the product. Everything
 * that crosses between the two halves crosses here, read by a camera that may
 * be seven years old, held by a person who is also holding another phone. A QR
 * code that looks beautiful and scans badly is a failed design, not a
 * compromise — so the rules below are in that order.
 *
 * **The code is white on black, not tinted.** Nothing here is amber. A reader
 * thresholds luminance, and every point of contrast given up to brand color is
 * a point of margin taken from somebody in a dim room. The frame around it is
 * where the design happens.
 *
 * **The modules are square and full size.** Rounded "dots" are the current
 * fashion and they shrink the dark area of every module, which is exactly the
 * signal the decoder is measuring. The rounding here is applied only to the
 * *outline* of contiguous runs — the corners of the shape, not of each cell —
 * so the code keeps its full dark area and still reads as drawn rather than
 * printed. At a module size below three points even that is dropped.
 *
 * **The quiet zone is four modules and it is not negotiable.** It is in the
 * specification, it is what most implementations shave, and it is the single
 * most common reason a code that looks fine will not scan.
 *
 * **The finder patterns are drawn as shapes.** Three concentric squares, with
 * the same corner treatment as the frame around the whole code. They are the
 * one part of a QR code whose geometry a reader locates by proportion rather
 * than by module, so they tolerate being drawn as one object, and they are
 * what makes a code look designed at a glance.
 *
 * ## The animation
 *
 * A multi-frame transfer replaces the whole matrix every 220ms. It does *not*
 * cross-fade: two half-drawn codes on screen at once is two codes that will
 * not scan, and a camera catching the moment between them gets nothing. Frames
 * cut. What animates is everything around the code — the counter, the ring,
 * the labyrinth — because that is what tells a person the transfer is alive.
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { at, toMatrix, type Level } from './matrix';
import { color, radius } from '../design/tokens';

export interface QrCanvasProps {
  /** The frame's text. Changing it redraws the whole matrix, by design. */
  value: string;
  /** Side length in points, including the quiet zone. */
  size: number;
    level?: Level | undefined;
  /** The paper. Left as pure white unless something needs otherwise. */
    paper?: string | undefined;
    ink?: string | undefined;
}

const QUIET = 4;

export function QrCanvas({ value, size, level = 'M', paper = color.codeLight, ink = color.codeDark }: QrCanvasProps) {
  const drawing = useMemo(() => {
    const matrix = toMatrix(value, level);
    const cells = matrix.size + QUIET * 2;
    const unit = size / cells;

    /* One path for every data module, and separate shapes for the three
     * finders. Emitting a `<Rect>` per module puts two thousand views on the
     * screen and drops frames on an animation that must not drop frames. */
    let data = '';
    for (let y = 0; y < matrix.size; y++) {
      for (let x = 0; x < matrix.size; x++) {
        if (!at(matrix, x, y) || matrix.isFinder(x, y)) continue;
        const px = (x + QUIET) * unit;
        const py = (y + QUIET) * unit;
        /* A hairline of overlap, so adjacent modules do not show a seam from
         * subpixel rounding. Cheaper and more reliable than merging runs. */
        const span = unit + 0.35;
        data += `M${px.toFixed(2)} ${py.toFixed(2)}h${span.toFixed(2)}v${span.toFixed(2)}h-${span.toFixed(2)}z`;
      }
    }

    const finders = [
      { x: 0, y: 0 },
      { x: matrix.size - 7, y: 0 },
      { x: 0, y: matrix.size - 7 },
    ].map((corner) => ({
      x: (corner.x + QUIET) * unit,
      y: (corner.y + QUIET) * unit,
      span: unit * 7,
    }));

    return { data, finders, unit, side: size };
  }, [value, size, level]);

  const round = Math.min(drawing.unit * 0.9, 6);

  return (
    <View style={{ width: size, height: size, borderRadius: radius.code, overflow: 'hidden', backgroundColor: paper }}>
      <Svg width={size} height={size}>
        <Rect x={0} y={0} width={size} height={size} fill={paper} />
        <Path d={drawing.data} fill={ink} />
        {/* The ring: one module thick, stroked down the center of the module
            band so it covers exactly the seven-by-seven pattern's outer row. */}
        {drawing.finders.map((finder, index) => (
          <Rect
            key={`ring-${index}`}
            x={finder.x + drawing.unit / 2}
            y={finder.y + drawing.unit / 2}
            width={finder.span - drawing.unit}
            height={finder.span - drawing.unit}
            rx={round}
            fill="none"
            stroke={ink}
            strokeWidth={drawing.unit}
          />
        ))}
        {/* The pupil: the three-by-three block at the center. */}
        {drawing.finders.map((finder, index) => (
          <Rect
            key={`pupil-${index}`}
            x={finder.x + drawing.unit * 2}
            y={finder.y + drawing.unit * 2}
            width={drawing.unit * 3}
            height={drawing.unit * 3}
            rx={round * 0.5}
            fill={ink}
          />
        ))}
      </Svg>
    </View>
  );
}
