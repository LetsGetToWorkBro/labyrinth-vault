/**
 * Runtime floor. Loaded first, before any vault module, from index.js.
 *
 * Order matters and is test-enforced (test/app-wiring.test.ts checks this
 * file's first import): the vault libraries draw their entropy arguments from
 * crypto.getRandomValues, so the polyfill has to exist before any of them is
 * even parsed. A module evaluated too early would not fail loudly — it would
 * fail at first use, at runtime, on the phone.
 */

// 1. The CSPRNG. Native, from the platform's own source of randomness.
import 'react-native-get-random-values';

// 2. WHATWG Encoding on older Hermes. The vault target's entire ambient
//    surface is written down in src/platform.d.ts, and TextEncoder/TextDecoder
//    are the only globals it needs beyond the language; newer Hermes ships
//    them, older does not. Guarded so the polyfill never shadows a native one.
if (typeof global.TextEncoder === 'undefined' || typeof global.TextDecoder === 'undefined') {
  require('fast-text-encoding');
}
