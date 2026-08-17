/**
 * Mounting a screen, and asking it questions.
 *
 * ## What this closes
 *
 * Until this file existed, `wallet/` had 905 tests and not one of them ran a
 * component. Every screen defect the audit found was read out of source, and
 * the worst of them was a crash: `Receive` indexed a list of derived addresses
 * that is empty on a wallet whose first account has just been paired. Source
 * reading found it because somebody happened to look at that line. Nothing
 * would have found the next one.
 *
 * The stand-ins under `native/` are what make this possible and are also its
 * boundary: read the head of `native/react-native.tsx` for what a passing test
 * here does and does not prove. In short, this runs JavaScript and not layout.
 *
 * ## The vocabulary
 *
 * Screens are asked about in the words a person would use. `shows` is what is
 * legible, `press` is a finger, `controls` is what could be pressed. Nothing
 * here reaches for a test id, because a test id is a hook the product does not
 * otherwise have and a screen that can only be found by one is a screen an
 * assistive reader cannot find either.
 */

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { ReactElement } from 'react';
import type { Nav, Routes } from '../../src/nav/routes';
import * as camera from './native/expo-camera';
import * as clipboard from './native/expo-clipboard';
import * as documents from './native/expo-document-picker';
import * as files from './native/expo-file-system';
import * as haptics from './native/expo-haptics';
import * as keychain from './native/expo-secure-store';
import * as gate from './native/expo-local-authentication';
import { shared } from './native/react-native';

/* React refuses to run effects outside an act environment and says so on
 * stderr rather than failing, which is the shape of warning a suite learns to
 * ignore. Set once, here, so no test file has to remember. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Every stand-in back to the state a fresh launch has.
 *
 * Module state outlives a test, and the keychain is the one that matters: a
 * seed written by one test is a wallet the next test did not create, and the
 * assertion that would have caught a missing write passes on the leftover.
 * Call it in `beforeEach`; `harness.test.ts` checks that the test files here
 * do.
 */
export function resetNative(): void {
  camera.reset();
  clipboard.reset();
  documents.reset();
  files.reset();
  haptics.reset();
  keychain.reset();
  gate.reset();
  shared.length = 0;
}

/** Text under one node, in the order it is drawn, with runs of whitespace
 *  collapsed the way reading collapses them. */
function textUnder(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(textUnder).join(' ');
}

function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface Mounted {
  /** The renderer, for the rare question this vocabulary does not cover. */
  readonly tree: ReactTestRenderer;
  /** Everything legible on the screen, in reading order. */
  text(): string;
  /** Whether a sentence is on the screen, wrapping and indentation ignored.
   *  JSX breaks prose wherever the formatter put the line, so a check written
   *  against one wrapping stops looking the next time a paragraph reflows. */
  shows(phrase: string): boolean;
  /** What a person could press, by the words on it. */
  controls(): string[];
  /** Whether a control is present and not disabled. */
  enabled(label: string): boolean;
  /** Press it: in, down, out, which is the order a finger produces. */
  press(label: string): void;
  /** Hold it down, for the one control that is about the holding. */
  hold(label: string): void;
  release(label: string): void;
  /** Type into the field with this placeholder. */
  type(placeholder: string, text: string): void;
  /** Every node of a kind, for the questions about drawing rather than words:
   *  whether a QR is on the screen, whether the camera is live. */
  all(kind: string): ReactTestInstance[];
  /** Let effects, promises and state settle. */
  settle(): Promise<void>;
  /** Run something that changes the screen, then let it settle. */
  act(work: () => void | Promise<void>): Promise<void>;
  unmount(): void;
}

/**
 * Whether a node is a host of this kind.
 *
 * Through `unknown` because `ReactTestInstance.type` is typed `ElementType`,
 * and React Native declares no intrinsic elements, so the compiler is right
 * that `'Pressable'` is not in that union and wrong about what it means here:
 * the stand-ins under `native/` are host strings on purpose, which is how
 * react-test-renderer records a node with its props. One function so the
 * assertion is made once and explained once.
 */
function isHost(node: ReactTestInstance, kind: string): boolean {
  return (node.type as unknown) === kind;
}

function pressables(tree: ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findAll((node) => isHost(node, 'Pressable'), { deep: true });
}

function matching(tree: ReactTestRenderer, label: string): ReactTestInstance[] {
  const wanted = tidy(label);
  return pressables(tree).filter((node) => {
    const spoken = node.props['accessibilityLabel'];
    if (typeof spoken === 'string' && tidy(spoken) === wanted) return true;
    return tidy(textUnder(node)).includes(wanted);
  });
}

/**
 * The one control this label names, or a failure that says why not.
 *
 * Ambiguity is an error rather than a first match. Two controls reading
 * CONTINUE on one screen is a real thing that happens here, and a harness that
 * silently picked the earlier one would let a test claim it pressed the button
 * it meant. The message lists what it found, because the fix is almost always
 * to name the control more exactly rather than to change the screen.
 */
function one(tree: ReactTestRenderer, label: string): ReactTestInstance {
  const found = matching(tree, label);
  if (found.length === 1) return found[0]!;
  const drawn = pressables(tree).map((node) => tidy(textUnder(node))).filter((text) => text !== '');
  if (found.length === 0) {
    throw new Error(`nothing on this screen reads "${label}". What can be pressed: ${drawn.join(' | ')}`);
  }
  throw new Error(`"${label}" matches ${found.length} controls on this screen: ${drawn.join(' | ')}`);
}

function fire(node: ReactTestInstance, handler: 'onPress' | 'onPressIn' | 'onPressOut', label: string): void {
  if (node.props['disabled'] === true) {
    throw new Error(`"${label}" is disabled, so a finger does nothing to it`);
  }
  const press = node.props[handler];
  if (typeof press === 'function') (press as () => void)();
}

export function mount(element: ReactElement): Mounted {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(element);
  });

  const settle = async (): Promise<void> => {
    /* Three turns rather than one. The store reads the keychain, and what it
     * finds decides whether it reads the pairing, which decides whether it
     * builds watchers: promises chained behind state, and a single flush
     * leaves a screen one step short of where a phone would have it. */
    for (let turn = 0; turn < 3; turn += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  return {
    tree,
    text: () => tidy(textUnder(tree.root)),
    shows: (phrase) => tidy(textUnder(tree.root)).includes(tidy(phrase)),
    controls: () => pressables(tree).map((node) => tidy(textUnder(node))).filter((text) => text !== ''),
    enabled: (label) => {
      const found = matching(tree, label);
      return found.length > 0 && found.every((node) => node.props['disabled'] !== true);
    },
    press: (label) => {
      const node = one(tree, label);
      act(() => {
        fire(node, 'onPressIn', label);
        fire(node, 'onPress', label);
        fire(node, 'onPressOut', label);
      });
    },
    hold: (label) => {
      const node = one(tree, label);
      act(() => fire(node, 'onPressIn', label));
    },
    release: (label) => {
      const node = one(tree, label);
      act(() => fire(node, 'onPressOut', label));
    },
    type: (placeholder, text) => {
      const fields = tree.root.findAll(
        (node) => isHost(node, 'TextInput') && node.props['placeholder'] === placeholder,
        { deep: true },
      );
      if (fields.length !== 1) {
        const seen = tree.root
          .findAll((node) => isHost(node, 'TextInput'), { deep: true })
          .map((node) => String(node.props['placeholder']));
        throw new Error(`no single field reads "${placeholder}". Fields on this screen: ${seen.join(' | ')}`);
      }
      const onChangeText = fields[0]!.props['onChangeText'];
      if (typeof onChangeText !== 'function') {
        throw new Error(`the field "${placeholder}" is not wired to anything, so typing into it is lost`);
      }
      act(() => (onChangeText as (value: string) => void)(text));
    },
    all: (kind) => tree.root.findAll((node) => isHost(node, kind), { deep: true }),
    settle,
    act: async (work) => {
      await act(async () => {
        await work();
      });
      await settle();
    },
    unmount: () => act(() => tree.unmount()),
  };
}

/**
 * The props a navigator would hand a screen, and a record of what the screen
 * did with them.
 *
 * Cast rather than modeled. `NativeStackScreenProps` carries the whole of
 * React Navigation's imperative surface, and these screens use six methods of
 * it. Writing the other forty as stubs would be fiction that reads like
 * fidelity: the cast at least says out loud that this is a stand-in, and the
 * six that matter are real and recorded.
 */
export interface Navigated {
  /** Where the screen went, in order, as `Route` or `Route(params)`. */
  readonly went: string[];
  /** Whether the screen left by going back. */
  back: number;
  /** Params the screen set on itself. */
  readonly params: Record<string, unknown>[];
}

export function navigator(): { nav: Navigated; props: <R extends keyof Routes>(params?: Routes[R]) => Nav<R> } {
  const nav: Navigated = { went: [], back: 0, params: [] };
  const navigation = {
    navigate: (route: string, params?: unknown) =>
      nav.went.push(params === undefined ? route : `${route}(${JSON.stringify(params)})`),
    replace: (route: string, params?: unknown) =>
      nav.went.push(params === undefined ? `replace:${route}` : `replace:${route}(${JSON.stringify(params)})`),
    push: (route: string) => nav.went.push(`push:${route}`),
    goBack: () => {
      nav.back += 1;
    },
    popToTop: () => nav.went.push('popToTop'),
    reset: () => nav.went.push('reset'),
    setParams: (params: Record<string, unknown>) => nav.params.push(params),
    addListener: () => () => {},
    setOptions: () => {},
    isFocused: () => true,
    canGoBack: () => true,
  };

  return {
    nav,
    props: <R extends keyof Routes>(params?: Routes[R]) =>
      ({ navigation, route: { key: 'test', name: 'test', params } } as unknown as Nav<R>),
  };
}

export { camera, clipboard, documents, files, haptics, keychain, gate, shared };
