/**
 * The labyrinth, as a line somebody can follow.
 *
 * The motif has one job in this product and it is not decoration: it is how a
 * transaction's progress is drawn. A payment here does not have a progress
 * bar, because it is not one process — it is a path that leaves this device,
 * goes somewhere this device cannot see, and comes back. A line traveling
 * inward through a labyrinth says that. A bar filling up says "loading".
 *
 * So the geometry is a single unbroken path, entered at the top, turning
 * inward, ending at the center. Six stages of a transaction light six stretches
 * of it. When a payment is confirmed the line has reached the middle, and
 * nothing else on the screen has to say so.
 *
 * ## Why a square spiral and not a maze
 *
 * A maze has dead ends and choices. A labyrinth, properly, has exactly one
 * path and no decisions — you cannot get lost in one, you can only walk it.
 * That is the correct metaphor for this system: there is one route a payment
 * takes, it is not optional, and the parts of it that happen elsewhere still
 * happen on the same line.
 *
 * It also has to survive being 14 points wide next to a title, so it is right
 * angles and one stroke weight, and there is no version of it with a gradient.
 *
 * This file is pure geometry and no React, which is why `test/geometry.test.ts`
 * can assert the useful properties: the path never doubles back on itself, the
 * turns are all right angles, and it ends near the center at every size.
 */

export type Point = readonly [number, number];

/**
 * A rectangular spiral inward from the top edge.
 *
 * `gap` is the distance between adjacent runs of the line, in the same units
 * as `size`. Small gaps make a denser, more instrument-like glyph; large ones
 * make a mark that survives at 14pt. Both are used.
 */
export function spiral(size: number, gap: number): Point[] {
  const points: Point[] = [];
  let left = 0;
  let top = 0;
  let right = size;
  let bottom = size;

  /* The entrance. Top center, which is where the eye starts and where every
   * screen that uses this puts the thing that begins the journey. */
  points.push([size / 2, top]);
  points.push([right, top]);

  let guard = 0;
  while (right - left > gap * 1.4 && bottom - top > gap * 1.4 && guard++ < 64) {
    points.push([right, bottom]);
    points.push([left, bottom]);
    top += gap;
    points.push([left, top]);
    right -= gap;
    points.push([right, top]);
    bottom -= gap;
    left += gap;
  }

  return points;
}

/** SVG path data. Straight segments only, by construction. */
export function pathFrom(points: readonly Point[]): string {
  if (points.length === 0) return '';
  const [first, ...rest] = points;
  const start = `M ${round(first![0])} ${round(first![1])}`;
  return rest.reduce((data, point) => `${data} L ${round(point[0])} ${round(point[1])}`, start);
}

/** Total length, for stroke-dash arithmetic. Cheap because every segment is
 *  axis-aligned, so there is no square root in here. */
export function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    total += Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
  }
  return total;
}

/**
 * Where along the path each of `stages` stages ends, as a fraction.
 *
 * Not evenly spaced. The stages of a payment are not equally long or equally
 * important: the two that happen on the vault — verification and signing — get
 * more of the line than the ones that happen here, because they are the ones a
 * person is standing there doing. The geometry is where that judgement lives,
 * so every screen that draws it agrees.
 */
export function stageStops(stages: number, weights?: readonly number[]): number[] {
  const share = weights ?? defaultWeights(stages);
  const total = share.reduce((sum, weight) => sum + weight, 0);
  const stops: number[] = [];
  let running = 0;
  for (let i = 0; i < stages; i++) {
    running += share[i] ?? 1;
    stops.push(running / total);
  }
  return stops;
}

function defaultWeights(stages: number): number[] {
  /* prepared, sent, verified, signed, broadcast, confirmed */
  if (stages === 6) return [1, 1.2, 1.8, 1.4, 1, 1.6];
  return new Array(stages).fill(1);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------- the mark

/**
 * How far apart the identity glyph's runs sit, as a fraction of its size.
 *
 * A named number rather than a literal because three surfaces draw this mark
 * and they have to draw the same one: the vault's icon, the wallet's icon, and
 * the navigation bars of the wallet and the marketing site. They used to use
 * two different numbers, 6 for the icons and 5.5 for the navigation mark. That
 * is not a difference anybody could name and it is one everybody could feel,
 * and it is how a logo drifts from itself a release at a time.
 *
 * Set to the icons' value, deliberately. The icon is the copy of this mark
 * that is already installed on people's home screens, so it is the one that
 * does not get to move.
 *
 * Note that this is *not* the figure the vault's own screens draw. Those use
 * a denser involute from `ios/LabyrinthVault/Design/Labyrinth.swift`, and that
 * is a deliberate second figure rather than drift: it exists to be animated,
 * drawing itself as the launch sequence resolves and freezing mid-stroke when
 * a signature is refused. This one is the still mark.
 */
export const MARK_GAP_RATIO = 6;

/**
 * The identity glyph: four turns, entered from the top, ending at the center.
 *
 * Deliberately the same construction as the journey path, at a coarser gap, so
 * the mark in the navigation bar and the animation on a transaction screen are
 * visibly the same object at different densities. A logo that is a special
 * case is a logo that stops meaning anything.
 */
export function markSpiral(size = 24): Point[] {
  return spiral(size, size / MARK_GAP_RATIO);
}

/** The same glyph as SVG path data, for anything that draws rather than measures. */
export function markPath(size = 24): string {
  return pathFrom(markSpiral(size));
}
