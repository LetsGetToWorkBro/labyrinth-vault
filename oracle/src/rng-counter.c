/* Deterministic stand-in for Monero's RNG, so the reference is reproducible.
 * Counter bytes, which is the least interesting sequence that still exercises
 * every branch. */
#include <stddef.h>
#include <stdint.h>
static uint8_t counter = 0;
void generate_random_bytes_thread_safe(size_t n, uint8_t *bytes) {
  for (size_t i = 0; i < n; i++) bytes[i] = counter++;
}
void generate_random_bytes_not_thread_safe(size_t n, void *bytes) {
  generate_random_bytes_thread_safe(n, (uint8_t *)bytes);
}
void add_extra_entropy_thread_safe(const void *ptr, size_t n) { (void)ptr; (void)n; }
void add_extra_entropy_not_thread_safe(const void *ptr, size_t n) { (void)ptr; (void)n; }
