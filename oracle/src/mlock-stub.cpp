/* mlocker only pins pages so secrets do not reach swap. Irrelevant to a
 * reference generator and it drags in boost::thread, so it is stubbed. */
#include <cstddef>
namespace epee {
  class mlocker {
  public:
    static void lock(void *p, size_t n);
    static void unlock(void *p, size_t n);
  };
  void mlocker::lock(void *p, size_t n) { (void)p; (void)n; }
  void mlocker::unlock(void *p, size_t n) { (void)p; (void)n; }
}
