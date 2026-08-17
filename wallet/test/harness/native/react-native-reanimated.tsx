/**
 * Animation, run as its final frame.
 *
 * Every animation in this application is decoration over a value that state
 * already decided: a press scales a view, a dot pulses while a handoff is in
 * flight, a row fades in as a list settles. None of it changes what a screen
 * says or what a control does, and none of it is what a harness in Node could
 * observe anyway, because Reanimated's whole point is that the interpolation
 * happens off the JavaScript thread.
 *
 * So `withTiming`, `withSpring` and `withRepeat` return their target
 * immediately. A shared value assigned an animation ends up holding the value
 * the animation was heading for, which is the only frame a test can ask a
 * question about, and it is the frame the screen settles on.
 *
 * The one thing modeled with care is `useSharedValue`. It has to be stable
 * across renders: a fresh box every render would make `useAnimatedStyle` read
 * the initial value forever, and `Dot`'s effect writes to it from a dependency
 * array that names it. A ref holds one box for the life of a mount, which is
 * the property being relied on; the real one is a shared value the UI thread
 * can also write, and nothing here has a UI thread.
 */

import { useRef, type ComponentType, type ReactElement } from 'react';
import { strict } from '../strict';

export interface SharedValue<T> {
  value: T;
}

export function useSharedValue<T>(initial: T): SharedValue<T> {
  const box = useRef<SharedValue<T> | null>(null);
  box.current ??= { value: initial };
  return box.current;
}

/* Evaluated during render, so a test reads the style the screen computed from
 * the state it is in. The real one runs the body on the UI thread and this one
 * runs it here, which is the same body over the same values. */
export function useAnimatedStyle<T>(build: () => T): T {
  return build();
}

export function useAnimatedProps<T>(build: () => T): T {
  return build();
}

export function useDerivedValue<T>(build: () => T): SharedValue<T> {
  return { value: build() };
}

export function withTiming<T>(to: T): T {
  return to;
}

export function withSpring<T>(to: T): T {
  return to;
}

/** The value it repeats toward. A repeat has no last frame, so its target is
 *  the only honest answer, and nothing in this application branches on it. */
export function withRepeat<T>(to: T): T {
  return to;
}

export const Easing = strict('react-native-reanimated', 'Easing', {
  linear: (t: number) => t,
  quad: (t: number) => t * t,
  inOut: (easing: (t: number) => number) => easing,
});

/**
 * An entering animation, as a value that can be chained and carried.
 *
 * `FadeIn.duration(300)`, `FadeIn.delay(index * 40)` and
 * `FadeInDown.springify().damping(26).stiffness(220)` all appear in this
 * application, and every one of them ends up in an `entering` prop that
 * react-test-renderer records and nothing reads. What matters is that the
 * chain does not throw, so each method returns the same chainable thing.
 */
type Entering = Record<string, (n?: number) => Entering>;

function entering(name: string): Entering {
  const chain: Entering = {} as Entering;
  for (const method of ['duration', 'delay', 'springify', 'damping', 'stiffness', 'withInitialValues']) {
    chain[method] = () => chain;
  }
  Object.defineProperty(chain, 'name', { value: name });
  return chain;
}

export const FadeIn = entering('FadeIn');
export const FadeInDown = entering('FadeInDown');

/**
 * `Animated.View`, `Animated.Text`, and the wrapper the marks are built from.
 *
 * `createAnimatedComponent` folds `animatedProps` into the props of the thing
 * it wraps, which is what the real one does once a frame. `glyphs.tsx` draws
 * every stroke of the wordmark through it, so a harness that dropped
 * `animatedProps` would render the marks with no geometry and a test asking
 * whether the mark is on the screen would still pass.
 */
type Props = Record<string, unknown>;

function withAnimatedProps<P extends Props>(Inner: ComponentType<P> | string) {
  return function Animatable(props: P & { animatedProps?: Props }): ReactElement {
    const { animatedProps, ...rest } = props;
    const Component = Inner as ComponentType<Props>;
    return <Component {...(rest as Props)} {...(animatedProps ?? {})} />;
  };
}

const Animated = strict('react-native-reanimated', 'Animated', {
  View: withAnimatedProps('View'),
  Text: withAnimatedProps('Text'),
  createAnimatedComponent: withAnimatedProps,
});

export default Animated;
