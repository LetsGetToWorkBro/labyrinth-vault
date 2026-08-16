/*
 * A CLSAG signature from Monero's own prover, and Monero's verdict on ours.
 *
 * ## Why this exists
 *
 * The Monero project ships no fixed CLSAG test vector. Its own unit tests
 * generate random keys, sign, and verify, which proves the pair is
 * self-consistent and proves nothing to anybody writing a second
 * implementation. `docs/monero-send.md` said so plainly: "round-trip plus
 * adversarial plus constant-anchored is as far as a test environment reaches".
 *
 * That was true only for as long as this repository would not compile
 * `ringct/rctSigs.cpp`. It compiles it now, for the transaction verifier next
 * door, so the vector can simply be asked for.
 *
 * The harness does two things with the same inputs:
 *
 *   sign    `rct::proveRctCLSAGSimple`, the call `wallet2` makes, with the RNG
 *           stubbed to a byte counter so the signature is reproducible. The
 *           TypeScript is handed the same counter bytes as its nonces and has
 *           to produce the same c1 and the same s vector.
 *
 *   verify  `rct::verRctCLSAGSimple`, over a signature the TypeScript made.
 *           This is the direction that matters, because a prover and a
 *           verifier that share a mistake agree perfectly with each other.
 *
 * The second one earned its keep on the first run. Two errors in the
 * aggregation hash -- `C_offset` in the wrong slot, and the *unscaled*
 * auxiliary key image where Monero hashes `D·(1/8)` -- were mirrored in
 * `clsagSign` and `clsagVerify` and were invisible to every round trip and
 * every tamper test in the suite.
 *
 * ## Usage
 *
 *   clsag sign   <file>     print Monero's signature over the inputs in <file>
 *   clsag verify <file>     print Monero's verdict on the signature in <file>
 *
 * The file is lines of:
 *
 *   message <hex32>       what is being signed
 *   secret  <hex32>       the one-time secret key of the real ring member
 *   mask    <hex32>       the real input's amount mask
 *   out     <hex32>       the pseudo-out mask, so z = mask - out
 *   offset  <hex32>       the pseudo-out commitment, C_offset
 *   index   <n>           which ring member is real
 *   ring    <key> <commitment>    in order
 *
 * and, for `verify`, the signature to judge:
 *
 *   sig_c1  <hex32>
 *   sig_s   <hex32>       one per ring member, in order
 *   sig_I   <hex32>       the key image
 *   sig_D   <hex32>       the auxiliary key image as stored on the wire, D·(1/8)
 */
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "device/device.hpp"
#include "ringct/rctOps.h"
#include "ringct/rctSigs.h"
#include "ringct/rctTypes.h"

static std::string hex(const void *p, size_t n) {
  static const char *d = "0123456789abcdef";
  std::string out;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = ((const unsigned char *)p)[i];
    out += d[c >> 4];
    out += d[c & 15];
  }
  return out;
}

static bool unhex32(const char *s, void *out) {
  if (strlen(s) != 64) return false;
  for (size_t i = 0; i < 32; i++) {
    unsigned byte;
    if (sscanf(s + 2 * i, "%2x", &byte) != 1) return false;
    ((unsigned char *)out)[i] = (unsigned char)byte;
  }
  return true;
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: clsag sign|verify <file>\n");
    return 2;
  }
  const bool signing = !strcmp(argv[1], "sign");
  if (!signing && strcmp(argv[1], "verify")) {
    fprintf(stderr, "clsag: unknown command %s\n", argv[1]);
    return 2;
  }

  FILE *in = fopen(argv[2], "r");
  if (!in) {
    fprintf(stderr, "clsag: cannot open %s\n", argv[2]);
    return 2;
  }

  rct::key message = rct::zero(), secret = rct::zero(), mask = rct::zero();
  rct::key outMask = rct::zero(), offset = rct::zero();
  unsigned index = 0;
  rct::ctkeyV ring;
  rct::clsag sig;
  sig.c1 = rct::zero();
  sig.I = rct::zero();
  sig.D = rct::zero();

  char kind[16], a[128], b[128];
  char *line = NULL;
  size_t cap = 0;
  while (getline(&line, &cap, in) > 0) {
    std::string text(line);
    while (!text.empty() && (text.back() == '\n' || text.back() == '\r')) text.pop_back();
    if (text.empty()) continue;
    const int fields = sscanf(text.c_str(), "%15s %127s %127s", kind, a, b);
    if (fields < 2) continue;
    bool ok = true;
    if (!strcmp(kind, "message")) ok = unhex32(a, message.bytes);
    else if (!strcmp(kind, "secret")) ok = unhex32(a, secret.bytes);
    else if (!strcmp(kind, "mask")) ok = unhex32(a, mask.bytes);
    else if (!strcmp(kind, "out")) ok = unhex32(a, outMask.bytes);
    else if (!strcmp(kind, "offset")) ok = unhex32(a, offset.bytes);
    else if (!strcmp(kind, "index")) index = (unsigned)strtoul(a, NULL, 10);
    else if (!strcmp(kind, "ring")) {
      rct::ctkey entry;
      ok = fields == 3 && unhex32(a, entry.dest.bytes) && unhex32(b, entry.mask.bytes);
      if (ok) ring.push_back(entry);
    }
    else if (!strcmp(kind, "sig_c1")) ok = unhex32(a, sig.c1.bytes);
    else if (!strcmp(kind, "sig_I")) ok = unhex32(a, sig.I.bytes);
    else if (!strcmp(kind, "sig_D")) ok = unhex32(a, sig.D.bytes);
    else if (!strcmp(kind, "sig_s")) {
      rct::key s;
      ok = unhex32(a, s.bytes);
      if (ok) sig.s.push_back(s);
    }
    if (!ok) {
      fprintf(stderr, "clsag: bad %s line: %s\n", kind, text.c_str());
      return 2;
    }
  }
  free(line);
  fclose(in);

  if (ring.empty() || index >= ring.size()) {
    fprintf(stderr, "clsag: need a ring and an index inside it\n");
    return 2;
  }

  if (signing) {
    /* The call wallet2 makes. `inSk.dest` is the one-time secret and
     * `inSk.mask` is the real input's amount mask; `proveRctCLSAGSimple`
     * derives z = inSk.mask - a itself, which is why the harness does not.
     * With the RNG stubbed to a counter, the alpha it draws and the n-1 fake
     * responses are the counter bytes in order, and the TypeScript is handed
     * the same ones. */
    rct::ctkey inSk;
    inSk.dest = secret;
    inSk.mask = mask;
    rct::clsag made =
        rct::proveRctCLSAGSimple(message, ring, inSk, outMask, offset, index, hw::get_device("default"));
    printf("c1 %s\n", hex(made.c1.bytes, 32).c_str());
    for (const rct::key &s : made.s) printf("s %s\n", hex(s.bytes, 32).c_str());
    printf("I %s\n", hex(made.I.bytes, 32).c_str());
    printf("D %s\n", hex(made.D.bytes, 32).c_str());
    /* Monero verifying Monero, so a reader can tell a broken harness from a
     * broken implementation without running anything. */
    printf("self_ok %d\n", rct::verRctCLSAGSimple(message, made, ring, offset) ? 1 : 0);
    return 0;
  }

  if (sig.s.size() != ring.size()) {
    fprintf(stderr, "clsag: %zu responses for a ring of %zu\n", sig.s.size(), ring.size());
    return 2;
  }
  int ok = 0;
  try {
    ok = rct::verRctCLSAGSimple(message, sig, ring, offset) ? 1 : 0;
  } catch (const std::exception &e) {
    fprintf(stderr, "clsag: verRctCLSAGSimple threw: %s\n", e.what());
  }
  printf("verified %d\n", ok);
  return 0;
}
