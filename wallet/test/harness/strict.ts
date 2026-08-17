/**
 * A namespace object that refuses to answer a question nobody taught it.
 *
 * The harness under `test/harness/native` stands in for modules that cannot
 * run in Node: the platform's components, the animation library, the six Expo
 * modules that are native code behind a JavaScript face. Standing in for them
 * is the only way to mount a screen here at all, and it is also the one way
 * this harness could start lying.
 *
 * The lie has a shape. A stub that is missing a member hands back `undefined`,
 * `undefined` flows into a style or a branch, and the screen renders something
 * plausible that the phone would never draw. Every assertion downstream then
 * passes against a fiction. That is worse than having no harness, because it
 * reads as coverage.
 *
 * So members are enumerated, and anything outside the list throws a sentence
 * naming what to add and where. Missing coverage becomes a failure at the
 * moment of first use rather than a silence.
 *
 * Named imports need none of this: `import { Foo } from 'react-native'` where
 * the stub has no `Foo` is a module-resolution error before a line runs, which
 * is already the loud failure. This is for the objects reached by property
 * instead — `StyleSheet.create`, `Dimensions.get`, `Haptics.impactAsync`.
 */

/* Keys that a runtime asks about rather than a caller: promise unwrapping,
 * printing, equality. Answering `undefined` is correct for these and throwing
 * would break `expect(...)` and `console.log` on a stub. */
const PROBES = new Set([
  'then',
  'toJSON',
  'constructor',
  'prototype',
  'nodeType',
  'tagName',
  '$$typeof',
  '_isMockFunction',
  'asymmetricMatch',
  'hasAttribute',
  '@@__IMMUTABLE_RECORD__@@',
  '@@__IMMUTABLE_ITERABLE__@@',
]);

export function strict<T extends object>(module: string, name: string, members: T): T {
  return new Proxy(members, {
    get(target, key) {
      if (typeof key === 'symbol') return Reflect.get(target, key) as unknown;
      if (key in target) return Reflect.get(target, key) as unknown;
      if (PROBES.has(key)) return undefined;
      throw new Error(
        `${name}.${key} is not modeled by the ${module} test harness. ` +
          `A screen under test reached for it, so add it to test/harness/native/${module}.tsx ` +
          `with the behavior the real module has, or the assertion below this line is about nothing.`,
      );
    },
  });
}
