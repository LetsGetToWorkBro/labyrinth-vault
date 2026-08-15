/*
 * labyrinth_cn.c
 *
 * NOT upstream. Ours.
 *
 * Two jobs, and nothing else belongs in this file.
 *
 * ## 1. Bind the variant
 *
 * `labyrinth_cn_slow_hash_v0` is the only way into the vendored code from
 * this app. It passes variant 0, prehashed 0, height 0 and cannot be talked
 * out of it. See include/labyrinth_cryptonight.h for why those three.
 *
 * This file includes both our header and Monero's `hash-ops.h`, which is
 * deliberate and is the point: if upstream ever changes the signature of
 * `cn_slow_hash`, the two declarations disagree here and the build stops. A
 * vendored dependency whose prototype drifts is otherwise silent until it is
 * a wrong key.
 *
 * ## 2. Stand in for the code paths that are compiled out
 *
 * `slow-hash.c` names three symbols this build never calls but the linker
 * still wants:
 *
 *   v4_generate_JIT_code      the CryptonightR JIT. Guarded by
 *                             `use_v4_jit()`, which returns 0 on anything
 *                             that is not x86-64, and is reached only at
 *                             variant 4. It mmaps executable memory, which
 *                             iOS does not permit a third-party app to do at
 *                             all — so this is not merely unused here, it is
 *                             unusable, and linking the real one would put a
 *                             W^X violation in the binary for no reason.
 *
 *   rx_slow_hash_allocate_state, rx_slow_hash_free_state
 *                             RandomX. Called only from `slow_hash_allocate_state`,
 *                             which is the daemon's entry point and not ours;
 *                             pulling in RandomX for it would be tens of
 *                             thousands of lines to support a call this app
 *                             never makes.
 *
 * They abort rather than return quietly. A stub that no-ops is a stub you
 * find out about later.
 */

#include <stdlib.h>
#include <stdio.h>

#include "labyrinth_cryptonight.h"

/* Monero's. The include is what type-checks the two prototypes against each
 * other; see the note above. */
#include "hash-ops.h"
#include "memwipe.h"

void labyrinth_cn_slow_hash_v0(const uint8_t *data, size_t length, uint8_t out[32]) {
    cn_slow_hash(data, length, (char *)out, 0 /*variant*/, 0 /*prehashed*/, 0 /*height*/);
}

void labyrinth_cn_wipe(void *data, size_t length) {
    memwipe(data, length);
}

static void unreachable(const char *what) {
    fprintf(stderr, "labyrinth: %s was called, and this build has no implementation of it\n", what);
    abort();
}

int v4_generate_JIT_code(const void *code, void *buf, size_t buf_size) {
    (void)code;
    (void)buf;
    (void)buf_size;
    unreachable("the CryptonightR JIT");
    return -1;
}

void rx_slow_hash_allocate_state(void) { unreachable("RandomX state allocation"); }

void rx_slow_hash_free_state(void) { unreachable("RandomX state release"); }
