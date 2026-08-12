/**
 * The entire platform surface this project depends on.
 *
 * The TypeScript configuration deliberately loads `ES2022` and nothing else:
 * no DOM library. That is not fussiness. The vault target has no window, no
 * document, no fetch and no storage, and a compiler that knows about them will
 * happily accept the day somebody reaches for one. Keeping the ambient
 * environment this small means "there is no network code in the vault" is
 * something the build checks rather than something a README claims.
 *
 * So anything genuinely needed from outside the language has to be written
 * down here, and the list being short is the point. If this file grows, the
 * property it protects is shrinking, and that is worth an argument rather than
 * an import.
 *
 * `TextEncoder` and `TextDecoder` are the whole of that list, and they are the
 * cautionary tale this file exists for. They are WHATWG Encoding rather than
 * part of the language, and this comment used to say they were safe because
 * Node has them, every browser has them, and Hermes has them. All three are
 * true. None of them is the vault's runtime, which is JavaScriptCore embedded
 * in an iOS app: a bare ECMAScript engine with no Web APIs at all. Ten modules
 * called them, six hundred tests passed on Node, and the first build that ever
 * reached a device stopped on its own launch gate with `ReferenceError: Can't
 * find variable: TextEncoder`.
 *
 * So the bundle carries its own. `src/encoding.js` is prepended by
 * `scripts/build-bundle.mjs` ahead of every module, because module-level code
 * runs on import and a polyfill the graph imports arrives too late. It is
 * installed unconditionally, so the tests and the phone run the same codec,
 * and `test/encoding.test.ts` holds it to Node's byte for byte.
 *
 * The general rule, which cost a device build to learn: a declaration here is
 * a promise that the *vault's* runtime has the thing. Enumerating the runtimes
 * where it happens to exist is not that promise. `test/bare-runtime.test.ts`
 * is where the promise is now checked, by running the bundle with every host
 * global deleted.
 */

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string);
  decode(input?: Uint8Array): string;
}
