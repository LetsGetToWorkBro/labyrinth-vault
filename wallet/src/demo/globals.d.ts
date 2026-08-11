/**
 * `__DEV__`, which React Native defines and TypeScript does not know about.
 *
 * Declared in its own file next to the thing that depends on it most, because
 * the gate on the stand-in vault is the one place in this app where getting
 * this constant wrong has a consequence worth naming: it would put a signer
 * holding a published seed into a build a stranger installs.
 */
declare const __DEV__: boolean;
