/**
 * Vector drawing, recorded rather than rasterized.
 *
 * Three things in this application are SVG: the icons, the QR canvas, and the
 * animated marks. Every one of them is a tree of elements whose meaning is
 * entirely in their props, so a host node holding those props is not a
 * simplification of the real thing, it is the same data one step before a
 * renderer turns it into pixels.
 *
 * That makes the QR canvas genuinely testable here: `matrix.ts` decides which
 * modules are dark and `QrCanvas` turns that into a path, so a test can read
 * the path back out and know the frame a vault would be shown is the frame the
 * wire format asked for.
 */

import type { ReactElement } from 'react';

type Host = (props: Record<string, unknown>) => ReactElement;

const Svg = 'Svg' as unknown as Host;

export default Svg;
export const Circle = 'Circle' as unknown as Host;
export const Line = 'Line' as unknown as Host;
export const Path = 'Path' as unknown as Host;
export const Rect = 'Rect' as unknown as Host;
