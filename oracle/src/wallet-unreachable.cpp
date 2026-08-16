/*
 * The six functions the wallet link needs and a key-image import cannot reach.
 *
 * `oracle/src/importkeyimages.cpp` links wallet2.cpp and everything under it.
 * A few of the translation units that come along reference proof-of-work and
 * daemon-side code that a wallet never calls: RandomX, the CryptonightR JIT,
 * and one accessor on the daemon's Blockchain object. Building those would
 * mean building RandomX and the blockchain database for a harness that opens a
 * file and checks some signatures.
 *
 * So they abort instead. Every one of them is defined here, by name, where a
 * reviewer can see the whole list -- rather than quietly satisfied by a linker
 * flag that would also swallow a hole in something that mattered. If the
 * import path ever does reach one of these, the harness dies loudly at the
 * line rather than returning a wrong answer, and this file is where to look.
 *
 * It has already earned that. `miner::find_nonce_for_given_block` was on this
 * list until the abort fired: creating a wallet generates the genesis block,
 * which searches for its nonce. It is compiled for real now. That is the
 * failure mode a permissive linker flag would have hidden, in a harness whose
 * whole job is to be trustworthy about what it ran.
 *
 * The corresponding file for the crypto harnesses is oracle/src/unreachable.c,
 * which does the same for a much shorter list.
 */
#include <cstdio>
#include <cstdlib>

#include "crypto/hash.h" // wraps hash-ops.h in extern "C", which is the linkage these have
#include "cryptonote_basic/blobdatatype.h"
#include "cryptonote_basic/cryptonote_basic.h"
#include "cryptonote_core/blockchain.h"

namespace {
  [[noreturn]] void unreachable(const char *what) {
    fprintf(stderr,
            "oracle: %s was called. That is proof-of-work or daemon code, and the key\n"
            "oracle: image import path is not supposed to reach it. See\n"
            "oracle: oracle/src/wallet-unreachable.cpp.\n",
            what);
    abort();
  }
}

extern "C" {
  struct V4_Instruction;
  typedef void (*v4_random_math_JIT_func)();

  int v4_generate_JIT_code(const struct V4_Instruction *, v4_random_math_JIT_func, const size_t) {
    unreachable("v4_generate_JIT_code");
  }
  void rx_slow_hash_allocate_state(void) { unreachable("rx_slow_hash_allocate_state"); }
  void rx_slow_hash_free_state(void) { unreachable("rx_slow_hash_free_state"); }
  uint64_t rx_seedheight(const uint64_t) { unreachable("rx_seedheight"); }
  void rx_slow_hash(const char *, const void *, size_t, char *) { unreachable("rx_slow_hash"); }
  void rx_set_miner_thread(uint32_t, size_t) { unreachable("rx_set_miner_thread"); }
}

namespace cryptonote {
  crypto::hash Blockchain::get_pending_block_id_by_height(uint64_t) const {
    unreachable("Blockchain::get_pending_block_id_by_height");
  }
}
