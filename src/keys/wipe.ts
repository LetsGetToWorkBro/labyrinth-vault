/**
 * Wiping secrets, and an honest account of what that is worth in JavaScript.
 *
 * The habit is real: zero a secret's bytes the moment it has done its job, so
 * the window in which it exists is as short as we can make it. Every function
 * in this project that holds key material transiently wipes it on the way out,
 * and `closeWallet` in bitcoin.ts zeroes a wallet's private keys in place.
 *
 * What this cannot be is a guarantee, and pretending otherwise is the kind of
 * security claim this project refuses to make:
 *
 *   - A garbage collector may have already copied the buffer during a
 *     compaction, and the copy is not ours to zero.
 *   - Strings are immutable. A secret that has ever been a string (a seed
 *     phrase on screen, a hex key) cannot be wiped, which is why the APIs
 *     here deal in bytes and why the sealed storage in seal.ts takes and
 *     returns Uint8Array.
 *   - Crossing a React Native bridge serialises and copies.
 *
 * So the real protections remain the outer ones: the device is offline, the
 * seed at rest is sealed (seal.ts), and the platform keystore holds what it
 * can. Wiping narrows the window inside a running process; it does not close
 * it. That is worth doing and not worth overselling.
 */

/** Zero every buffer given. Order of arguments carries no meaning. */
export function wipe(...buffers: (Uint8Array | null | undefined)[]): void {
  for (const buffer of buffers) {
    if (buffer && buffer.length) buffer.fill(0);
  }
}

/**
 * Run `use` over a secret and wipe the secret afterwards, whatever happens.
 *
 * The wipe is in a finally block so a thrown error does not leave the secret
 * lying around, which is exactly when nobody is thinking about cleanup.
 */
export function withSecret<T>(secret: Uint8Array, use: (secret: Uint8Array) => T): T {
  try {
    return use(secret);
  } finally {
    wipe(secret);
  }
}
