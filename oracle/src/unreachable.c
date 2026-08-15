/* Link-time stubs for the parts of Monero cn_slow_hash never reaches at
 * variant 0: the CryptonightR JIT (x86-only, and gated off at runtime on
 * every other target) and the RandomX state allocator. */
#include <stddef.h>
#include <stdint.h>
int v4_generate_JIT_code(const void *code, void *buf, size_t buf_size) {
  (void)code; (void)buf; (void)buf_size; return -1;
}
void rx_slow_hash_allocate_state(void) {}
void rx_slow_hash_free_state(void) {}
