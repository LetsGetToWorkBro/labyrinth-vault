/**
 * The platform, as much of it as a screen in this application actually asks
 * for, running under Node.
 *
 * ## Why a stand-in and not the real package
 *
 * `react-native`'s entry point is Flow-typed source that a Node loader cannot
 * parse, and the components behind it are shells over native views that do not
 * exist here. There is no configuration that makes the real package run in
 * this process, so the choice is a stand-in or no harness, and no harness is
 * what this package had: every screen defect the audit found was reasoned out
 * of source, including a crash.
 *
 * ## What that costs, stated plainly
 *
 * Nothing here proves a layout. Flexbox is not run, no text is measured, and
 * `style` is carried as data rather than applied. A control this harness can
 * press might be under another view on a phone and unpressable, and this file
 * would never know.
 *
 * What it does prove is the class of defect that has actually shipped: an
 * index into an empty list dereferenced during render, a branch that renders
 * the wrong sentence for the account that is selected, a control that is drawn
 * but wired to nothing, an effect that throws. Those are JavaScript failures
 * and they fail here exactly as they fail on the device.
 *
 * ## The rule this file lives under
 *
 * A stand-in earns its keep by being *narrow* and *loud*. Narrow: nothing is
 * modeled that no screen uses, because unused fidelity is fiction nobody
 * checks. Loud: every namespace goes through `strict`, so reaching for an
 * unmodeled member throws instead of yielding `undefined` and rendering
 * something plausible. `test/harness.test.ts` holds both halves, including the
 * check that the set of names exported here is the set the application
 * imports.
 *
 * The components below are the ones whose *behavior* a screen depends on.
 * Everything else is a host string, which react-test-renderer records as a
 * node with its props: that is all a `View` does here anyway.
 */

import {
  forwardRef,
  useImperativeHandle,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { strict } from '../strict';

/* Host types are strings to react-test-renderer, which records them with their
 * props and children. `as unknown as` because the application types these
 * against the real package: the harness swaps the implementation, never the
 * types a screen is written to. */
type Host = (props: Record<string, unknown>) => ReactElement;

export const View = 'View' as unknown as Host;
export const Text = 'Text' as unknown as Host;
export const TextInput = 'TextInput' as unknown as Host;

/**
 * A scroller, with the one imperative method a screen calls.
 *
 * `Onboarding` advances its panels with `scroller.current?.scrollTo(...)`. The
 * optional chain guards a null ref and not a missing method, so a plain host
 * string would have made that line throw the first time the harness reached
 * the intro. Recorded rather than acted on: there is no scroll position here,
 * and a test that wants to know the intro moved asks what it was told to
 * scroll to.
 */
export interface ScrollHandle {
  scrollTo(to: { x?: number; y?: number; animated?: boolean }): void;
  /** Every `scrollTo` this scroller was given, oldest first. */
  readonly scrolls: { x?: number; y?: number; animated?: boolean }[];
}

export const ScrollView = forwardRef(function ScrollView(
  props: Record<string, unknown> & { children?: ReactNode },
  ref: Ref<ScrollHandle>,
) {
  const scrolls: ScrollHandle['scrolls'] = [];
  useImperativeHandle(ref, () => ({ scrollTo: (to) => void scrolls.push(to), scrolls }), []);
  const { children, ...rest } = props;
  return <ScrollHost {...rest}>{children}</ScrollHost>;
});

const ScrollHost = 'ScrollView' as unknown as Host;

/**
 * A pressable, with the two shapes the real one accepts.
 *
 * `style` and `children` may each be a function of the press state. Nothing in
 * this application uses either today, and both are here anyway: the day one
 * does, a stand-in that rendered a function as a child would put `[Function]`
 * where a label goes and every text assertion would quietly stop matching.
 *
 * The press state itself is not simulated. `press()` in the harness calls
 * `onPressIn`, `onPress` and `onPressOut` in that order, which is the sequence
 * a finger produces, and hold-to-reveal on the recovery screen is the one
 * control that needs the first and last of those to be separable.
 */
export function Pressable({
  children,
  style,
  ...rest
}: Record<string, unknown> & {
  children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
  style?: unknown;
}) {
  const state = { pressed: false };
  const resolved = typeof style === 'function' ? (style as (s: typeof state) => unknown)(state) : style;
  const inside = typeof children === 'function' ? children(state) : children;
  return (
    <PressableHost {...rest} style={resolved}>
      {inside}
    </PressableHost>
  );
}

const PressableHost = 'Pressable' as unknown as Host;

/**
 * A list, which renders its rows.
 *
 * The reason this is not a host string: `CoinPicker` puts twenty-four coins
 * and their chain headings inside one, and a host string would record `data`
 * as a prop and render nothing. A test asserting that the list a person
 * searched holds the coin they typed would then pass on an empty screen.
 *
 * Everything is rendered. There is no windowing here and there should not be:
 * a harness that dropped offscreen rows would report a shorter list than the
 * device has, and the questions asked of a list are about what is in it.
 */
export function FlatList<Item>({
  data,
  renderItem,
  keyExtractor,
  ListEmptyComponent,
  ListHeaderComponent,
  ListFooterComponent,
  ItemSeparatorComponent,
  ...rest
}: {
  data: readonly Item[] | null | undefined;
  renderItem: (info: { item: Item; index: number }) => ReactNode;
  keyExtractor?: ((item: Item, index: number) => string) | undefined;
  ListEmptyComponent?: ReactNode | undefined;
  ListHeaderComponent?: ReactNode | undefined;
  ListFooterComponent?: ReactNode | undefined;
  ItemSeparatorComponent?: (() => ReactNode) | undefined;
} & Record<string, unknown>) {
  const rows = data ?? [];
  return (
    <ListHost {...rest}>
      {ListHeaderComponent ?? null}
      {rows.length === 0
        ? (ListEmptyComponent ?? null)
        : rows.map((item, index) => (
            <ListRow key={keyExtractor ? keyExtractor(item, index) : String(index)}>
              {renderItem({ item, index })}
              {ItemSeparatorComponent && index < rows.length - 1 ? ItemSeparatorComponent() : null}
            </ListRow>
          ))}
      {ListFooterComponent ?? null}
    </ListHost>
  );
}

const ListHost = 'FlatList' as unknown as Host;
const ListRow = 'FlatListRow' as unknown as Host;

/**
 * Styles, carried rather than applied.
 *
 * `create` is the identity function on the device too, near enough: it used to
 * intern styles into numeric handles and has returned the objects since the
 * registry was removed. So a test reading `props.style` sees what the screen
 * wrote, which is the only thing worth asserting about style in a harness that
 * runs no layout.
 *
 * `hairlineWidth` is the value an iPhone at 3x reports. It is a number in a
 * divider's height and nothing branches on it, so its only job is to not be
 * `undefined` where a style expects a number.
 */
export const StyleSheet = strict('react-native', 'StyleSheet', {
  create<T extends Record<string, unknown>>(sheet: T): T {
    return sheet;
  },
  hairlineWidth: 1 / 3,
});

/**
 * The window, at one fixed size.
 *
 * An iPhone 15 in points. Fixed rather than configurable because two screens
 * read it at module scope, into a `const`: `Home` sizes its column and
 * `Onboarding` its panel width, both once, when the module is first imported.
 * A per-test size would therefore be honored by whichever test imported the
 * module first and silently ignored by every test after it, which is a harness
 * lying about the thing it was asked to vary.
 */
export const Dimensions = strict('react-native', 'Dimensions', {
  get(which: 'window' | 'screen') {
    void which;
    return { width: 393, height: 852, scale: 3, fontScale: 1 };
  },
});

/**
 * The share sheet, recorded.
 *
 * Three call sites hand out an address or a key image file. What matters to a
 * test is what was handed out, so the calls are kept and the promise resolves
 * the way a dismissed sheet does.
 */
export const shared: { message?: string; url?: string; title?: string }[] = [];

export const Share = strict('react-native', 'Share', {
  async share(content: { message?: string; url?: string; title?: string }) {
    shared.push(content);
    return { action: 'sharedAction' as const };
  },
});

export type StyleProp<T> = T | T[] | null | undefined | false;
export type ViewStyle = Record<string, unknown>;
export type TextStyle = Record<string, unknown>;
export type NativeScrollEvent = {
  contentOffset: { x: number; y: number };
  contentSize: { width: number; height: number };
  layoutMeasurement: { width: number; height: number };
};
export type NativeSyntheticEvent<T> = { nativeEvent: T };
