/**
 * The motif, drawn.
 *
 * Three things live here and they are all the same line at different jobs:
 *
 *   `Mark`      — the identity glyph. Four turns, still, 14 to 28 points.
 *   `Journey`   — the same construction at a finer gap, drawn progressively as
 *                 a payment moves through the two devices. This is the one
 *                 that matters.
 *   `Link`      — the connection between the halves: two points and the
 *                 distance between them, with light travelling one way at a
 *                 time. Not a network cable. A camera looking at a screen.
 *
 * ## What the journey glyph is instead of
 *
 * A progress bar, and it is worth being explicit about why not. A bar implies
 * one process, running at a knowable rate, on one machine. A payment here is
 * none of those things: it stops entirely while a person reads a screen on a
 * different phone, and the wallet has no idea how long that will take or
 * whether it is happening at all. Drawing that as a bar at 60% would be
 * inventing information.
 *
 * A line finding its way inward makes no claim about rate. It has arrived
 * somewhere or it has not. And because the stages that happen on the vault
 * take the longest stretch of it (`stageStops` weights them so), the geometry
 * says the true thing: most of this journey happens somewhere you are not.
 */

import { useEffect } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedProps,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { markPath, pathFrom, pathLength, spiral, stageStops } from '../design/geometry';
import { color, motion } from '../design/tokens';
import { Label } from '../design/text';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedLine = Animated.createAnimatedComponent(Line);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// --------------------------------------------------------------------- mark

export function Mark({
  size = 18,
  tone = color.bone,
  weight = 1.25,
}: {
    size?: number | undefined;
    tone?: string | undefined;
    weight?: number | undefined;
}) {
  return (
    <Svg width={size} height={size} viewBox={`-1 -1 ${size + 2} ${size + 2}`}>
      <Path
        d={markPath(size)}
        stroke={tone}
        strokeWidth={weight}
        strokeLinecap="square"
        strokeLinejoin="miter"
        fill="none"
      />
    </Svg>
  );
}

// ------------------------------------------------------------------ journey

export interface JourneyProps {
  /** How many of the six stages are complete, 0 to 6. */
  reached: number;
    size?: number | undefined;
    tone?: string | undefined;
  /** The unlit remainder. Visible, because the shape of what is left to
   *  happen is information too. */
    ghost?: string | undefined;
    weight?: number | undefined;
  /** Pulse the leading edge, for a stage that is waiting on somebody. */
    waiting?: boolean | undefined;
}

export function Journey({
  reached,
  size = 220,
  tone = color.bone,
  ghost = color.dim,
  weight = 1.5,
  waiting = false,
}: JourneyProps) {
  const points = spiral(size, size / 11);
  const data = pathFrom(points);
  const total = pathLength(points);
  const stops = stageStops(6);
  const target = reached <= 0 ? 0 : (stops[Math.min(reached, 6) - 1] ?? 1);

  const drawn = useSharedValue(0);
  const breath = useSharedValue(0);

  useEffect(() => {
    drawn.value = withSpring(target, motion.heavy);
  }, [target, drawn]);

  useEffect(() => {
    breath.value = waiting
      ? withRepeat(withTiming(1, { duration: 1600, easing: Easing.inOut(Easing.quad) }), -1, true)
      : withTiming(0, { duration: 300 });
  }, [waiting, breath]);

  const lit = useAnimatedProps(() => ({
    strokeDashoffset: total * (1 - drawn.value),
    opacity: 0.75 + 0.25 * (waiting ? breath.value : 1),
  }));

  return (
    <Svg width={size} height={size} viewBox={`-2 -2 ${size + 4} ${size + 4}`}>
      <Path d={data} stroke={ghost} strokeWidth={weight} fill="none" strokeLinecap="butt" />
      <AnimatedPath
        d={data}
        stroke={tone}
        strokeWidth={weight}
        fill="none"
        strokeLinecap="butt"
        strokeDasharray={total}
        animatedProps={lit}
      />
    </Svg>
  );
}

// --------------------------------------------------------------------- link

/**
 * WALLET ● ─────── ○ VAULT
 *
 * The most important diagram in the product, and the easiest one to get
 * wrong. Everything about it is chosen to say *there is no connection here*:
 *
 * The line is dashed, not solid, because nothing continuous exists between
 * these two points. The dashes travel in one direction at a time, never both,
 * because the channel is half duplex by physics — a screen and a camera. And
 * the vault's end is a hollow circle whether or not it is "connected", because
 * the wallet genuinely does not know: it has never been able to reach the
 * vault and cannot start now.
 *
 * `direction` is what is being shown at this moment, not a state of the world:
 * `out` while frames are on this screen, `in` while the camera is open, and
 * `still` the rest of the time, which is almost always.
 */
export function Link({
  direction = 'still',
  width = 200,
  active = false,
  labels = true,
}: {
    direction?: 'out' | 'in' | 'still' | undefined;
    width?: number | undefined;
  /** True when this wallet holds an account key from a vault. */
    active?: boolean | undefined;
    labels?: boolean | undefined;
}) {
  const travel = useSharedValue(0);

  useEffect(() => {
    if (direction === 'still') {
      travel.value = withTiming(0, { duration: 200 });
      return;
    }
    travel.value = 0;
    travel.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.linear }), -1, false);
  }, [direction, travel]);

  const dash = 4;
  const gap = 5;
  const period = dash + gap;

  const flow = useAnimatedProps(() => ({
    strokeDashoffset: direction === 'in' ? travel.value * period : -travel.value * period,
    opacity: direction === 'still' ? 0.4 : 1,
  }));

  const glow = useDerivedValue(() => (direction === 'still' ? 0 : travel.value));
  const spark = useAnimatedProps(() => ({
    cx: 22 + glow.value * (width - 44),
    opacity: direction === 'still' ? 0 : 1 - Math.abs(0.5 - glow.value) * 0.8,
  }));

  return (
    <View style={{ alignItems: 'center', gap: 10 }}>
      <Svg width={width} height={20} viewBox={`0 0 ${width} 20`}>
        <Circle cx={8} cy={10} r={4.5} fill={color.bone} />
        <AnimatedLine
          x1={20}
          y1={10}
          x2={width - 20}
          y2={10}
          stroke={direction === 'in' ? color.good : color.slate}
          strokeWidth={1.25}
          strokeDasharray={`${dash} ${gap}`}
          animatedProps={flow}
        />
        <AnimatedCircle cy={10} r={2} fill={direction === 'in' ? color.good : color.bone} animatedProps={spark} />
        <Circle
          cx={width - 8}
          cy={10}
          r={4.5}
          fill="none"
          stroke={active ? color.bone : color.slate}
          strokeWidth={1.25}
        />
      </Svg>
      {labels ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', width }}>
          <Label tone={color.ash}>WALLET</Label>
          <Label tone={active ? color.ash : color.slate}>VAULT</Label>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The portfolio allocation, as a line rather than a pie.
 *
 * A pie chart of two things is a decoration. What a person wants to know at a
 * glance is the proportion, and a single divided rule says that in eight
 * points of height, sits under a balance without competing with it, and works
 * at any width.
 */
export function Allocation({
  parts,
  width,
  height = 3,
}: {
  parts: { weight: number; tone: string }[];
  width: number;
    height?: number | undefined;
}) {
  const total = parts.reduce((sum, part) => sum + part.weight, 0) || 1;
  let cursor = 0;
  return (
    <Svg width={width} height={height}>
      {parts.map((part, index) => {
        const span = (part.weight / total) * (width - (parts.length - 1) * 3);
        const x = cursor;
        cursor += span + 3;
        return (
          <Line
            key={index}
            x1={x}
            y1={height / 2}
            x2={x + Math.max(span, 1)}
            y2={height / 2}
            stroke={part.tone}
            strokeWidth={height}
            strokeLinecap="round"
          />
        );
      })}
    </Svg>
  );
}
