/*
 * CryptoNight, from Monero's own source rather than from vendor/cryptonight.
 *
 * The distinction is the whole point of this file. vendor/cryptonight is a
 * copy, and a copy is only worth anything if it can be checked against the
 * original; this harness is the original, built from the checkout
 * oracle/build.sh makes at the pinned tag. `build.sh --check` runs it against
 * `tests/hash/tests-slow.txt` so a broken build is caught before anything
 * downstream trusts a number that came out of it.
 *
 * It calls `cn_slow_hash` directly at variant 0, which is what
 * `crypto::generate_chacha_key` runs and therefore the only setting any of
 * this needs. See src/keys/moneroexport.ts for what that key is for.
 *
 *     oracle/.work/cryptonight <hex>
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stddef.h>

#include "hash-ops.h"

int main(int argc, char **argv) {
    unsigned char in[4096];
    char out[32];

    if (argc < 2) {
        fprintf(stderr, "usage: cryptonight <hex>\n");
        return 2;
    }

    size_t n = strlen(argv[1]) / 2;
    if (n > sizeof in) {
        fprintf(stderr, "cryptonight: input too long\n");
        return 2;
    }
    for (size_t i = 0; i < n; i++) sscanf(argv[1] + 2 * i, "%2hhx", &in[i]);

    cn_slow_hash(in, n, out, 0 /*variant*/, 0 /*prehashed*/, 0 /*height*/);

    for (int i = 0; i < 32; i++) printf("%02x", (unsigned char)out[i]);
    printf("\n");
    return 0;
}
