/*
 * labyrinth_cryptonight.h
 *
 * NOT upstream. This header and vendor/cryptonight/shim are ours; everything
 * under src/crypto and contrib/epee is Monero's, byte for byte, and
 * MANIFEST.json says which is which.
 *
 * The whole of the C surface this app is allowed to see. Monero's
 * `cn_slow_hash` takes a variant, a prehashed flag and a block height, and
 * those three arguments select between five materially different hash
 * functions, one of which (v4 / CryptonightR) generates machine code at
 * runtime. We need exactly one of them, at exactly one setting, forever:
 *
 *     crypto::generate_chacha_key(data, size, key, kdf_rounds = 1)
 *       -> cn_slow_hash(data, size, out, 0, 0, 0)
 *
 * which is `src/crypto/chacha.h` in the Monero tree, and is how wallet2
 * turns a view secret key into the ChaCha20 key that encrypts an exported
 * key-image set. So the variant is bound here, in C, rather than passed from
 * Swift. A caller cannot ask for v4 because there is no argument to ask with.
 */

#ifndef LABYRINTH_CRYPTONIGHT_H
#define LABYRINTH_CRYPTONIGHT_H

#include <stddef.h>
#include <stdint.h>

/**
 * CryptoNight variant 0 — the original, pre-fork function.
 *
 * @param data    input, any length
 * @param length  its length in bytes
 * @param out     32 bytes, written in full on every call
 *
 * There is no failure path: the algorithm is total on its input. It allocates
 * a 2 MiB scratchpad on the heap and frees it before returning.
 */
void labyrinth_cn_slow_hash_v0(const uint8_t *data, size_t length, uint8_t out[32]);

/**
 * Overwrite a buffer so the compiler may not elide the write.
 *
 * Monero's own `memwipe`, re-exported rather than reimplemented: it is already
 * compiled into this target, it already picks `explicit_bzero` / `memset_s` /
 * a volatile-pointer fallback per platform, and a second-best copy of that
 * decision living in Swift is exactly the kind of thing that rots.
 */
void labyrinth_cn_wipe(void *data, size_t length);

#endif /* LABYRINTH_CRYPTONIGHT_H */
