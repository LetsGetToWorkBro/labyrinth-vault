/**
 * The labyrinth is load-bearing, so it is tested like anything else.
 *
 * It draws the state of somebody's payment. A glyph that quietly stops turning
 * inward at one size, or doubles back on itself at another, is a progress
 * indicator that lies — and this one is deliberately the only thing on the
 * transaction screen that says how far along the payment is.
 */

import { describe, expect, it } from 'vitest';
import { markPath, pathFrom, pathLength, spiral, stageStops } from '../src/design/geometry';

describe('the path', () => {
  it('starts at the entrance, top centre', () => {
    const points = spiral(100, 12);
    expect(points[0]).toEqual([50, 0]);
  });

  it('turns only at right angles', () => {
    const points = spiral(120, 14);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const straight = a[0] === b[0] || a[1] === b[1];
      expect(straight, `segment ${i} from ${a} to ${b} is diagonal`).toBe(true);
    }
  });

  it('never doubles back along the segment it just drew', () => {
    const points = spiral(120, 14);
    for (let i = 2; i < points.length; i++) {
      const a = points[i - 2]!;
      const b = points[i - 1]!;
      const c = points[i]!;
      const back = Math.sign(b[0] - a[0]) === -Math.sign(c[0] - b[0]) && a[1] === b[1] && b[1] === c[1];
      const backVertical = Math.sign(b[1] - a[1]) === -Math.sign(c[1] - b[1]) && a[0] === b[0] && b[0] === c[0];
      expect(back && backVertical, `reversal at ${i}`).toBe(false);
    }
  });

  it('ends near the middle at every size it is drawn at', () => {
    for (const size of [16, 24, 44, 120, 320]) {
      const points = spiral(size, size / 6);
      const end = points[points.length - 1]!;
      const centre = size / 2;
      expect(Math.abs(end[0] - centre), `x at size ${size}`).toBeLessThan(size / 4);
      expect(Math.abs(end[1] - centre), `y at size ${size}`).toBeLessThan(size / 4);
    }
  });

  it('stays inside its box', () => {
    const size = 100;
    for (const [x, y] of spiral(size, 11)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(size);
      expect(y).toBeLessThanOrEqual(size);
    }
  });

  it('terminates on a gap too small to turn in, rather than spinning', () => {
    expect(spiral(40, 40).length).toBeLessThan(8);
    expect(spiral(400, 2).length).toBeLessThan(300);
  });
});

describe('measuring it', () => {
  it('sums the segments, which are all axis-aligned', () => {
    expect(pathLength([[0, 0], [10, 0], [10, 10]])).toBe(20);
  });

  it('gets longer as the line gets denser', () => {
    expect(pathLength(spiral(200, 8))).toBeGreaterThan(pathLength(spiral(200, 30)));
  });

  it('emits path data a renderer can use', () => {
    expect(pathFrom([[0, 0], [10, 0]])).toBe('M 0 0 L 10 0');
    expect(pathFrom([])).toBe('');
    expect(markPath(24)).toMatch(/^M 12 0 L /);
  });
});

describe('where the stages fall along it', () => {
  it('ends at the centre, exactly', () => {
    const stops = stageStops(6);
    expect(stops[stops.length - 1]).toBe(1);
  });

  it('advances, never retreats', () => {
    const stops = stageStops(6);
    for (let i = 1; i < stops.length; i++) expect(stops[i]!).toBeGreaterThan(stops[i - 1]!);
  });

  it('gives the two stages that happen on the vault more of the line', () => {
    const stops = stageStops(6);
    const lengthOf = (index: number) => stops[index]! - (stops[index - 1] ?? 0);
    // verified (2) and signed (3) against prepared (0) and broadcast (4).
    expect(lengthOf(2)).toBeGreaterThan(lengthOf(0));
    expect(lengthOf(3)).toBeGreaterThan(lengthOf(4));
  });
});
