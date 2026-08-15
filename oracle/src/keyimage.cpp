// Reference key-image export blob, built by Monero's own crypto.
// Deterministic: generate_random_bytes_thread_safe is stubbed to a counter so
// the ring signatures and the outer signature can be compared byte for byte
// against a second implementation.
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include "crypto/crypto.h"
#include "crypto/chacha.h"
#include "crypto/hash.h"

#define KEY_IMAGE_EXPORT_FILE_MAGIC "Monero key image export\003"

static void hexout(const char *label, const void *p, size_t n) {
  printf("%s ", label);
  for (size_t i = 0; i < n; i++) printf("%02x", ((const unsigned char *)p)[i]);
  printf("\n");
}
static void unhex(const char *s, void *out, size_t n) {
  for (size_t i = 0; i < n; i++) sscanf(s + 2 * i, "%2hhx", &((unsigned char *)out)[i]);
}

int main(int argc, char **argv) {
  // argv: viewSec spendSec offset  then triples of (outPub, ephSec, keyImage)
  if (argc < 4) return 2;
  crypto::secret_key view_sec, spend_sec;
  unhex(argv[1], &view_sec, 32);
  unhex(argv[2], &spend_sec, 32);
  uint32_t offset = (uint32_t)strtoul(argv[3], NULL, 10);

  crypto::public_key view_pub, spend_pub;
  crypto::secret_key_to_public_key(view_sec, view_pub);
  crypto::secret_key_to_public_key(spend_sec, spend_pub);
  hexout("view_pub", &view_pub, 32);
  hexout("spend_pub", &spend_pub, 32);

  crypto::chacha_key ck;
  crypto::generate_chacha_key(&view_sec, sizeof(view_sec), ck, 1);
  hexout("chacha_key", ck.data(), 32);

  std::string data;
  data.resize(4);
  data[0] = offset & 0xff; data[1] = (offset >> 8) & 0xff;
  data[2] = (offset >> 16) & 0xff; data[3] = (offset >> 24) & 0xff;
  data += std::string((const char *)&spend_pub, 32);
  data += std::string((const char *)&view_pub, 32);

  for (int a = 4; a < argc; a += 1) {
    crypto::secret_key eph; unhex(argv[a], &eph, 32);
    crypto::public_key pkey; crypto::secret_key_to_public_key(eph, pkey);
    crypto::key_image ki; crypto::generate_key_image(pkey, eph, ki);
    hexout("out_pub", &pkey, 32);
    hexout("key_image", &ki, 32);
    crypto::signature sig;
    std::vector<const crypto::public_key *> ptrs; ptrs.push_back(&pkey);
    crypto::generate_ring_signature((const crypto::hash &)ki, ki, ptrs, eph, 0, &sig);
    hexout("ring_sig", &sig, 64);
    /* The gate `wallet2::import_key_images` puts every record through, run
     * here by the implementation that puts it there.
     *
     * Generating a signature and reproducing its bytes proves two signers
     * agree. It does not prove the *verifier* accepts them, and the verifier
     * is what decides whether an import succeeds or throws "signature check
     * failed". That check is one line and it costs nothing, and without it the
     * claim "another wallet will accept this file" rests on reading
     * wallet2.cpp rather than on running it. */
    printf("ring_ok %d\n", crypto::check_ring_signature((const crypto::hash &)ki, ki, ptrs, &sig) ? 1 : 0);
    data += std::string((const char *)&ki, 32);
    data += std::string((const char *)&sig, 64);
  }
  hexout("plaintext", data.data(), data.size());

  // encrypt_with_view_secret_key, authenticated
  crypto::chacha_iv iv = crypto::rand<crypto::chacha_iv>();
  std::string ct;
  ct.resize(data.size() + sizeof(iv) + sizeof(crypto::signature));
  crypto::chacha20(data.data(), data.size(), ck, iv, &ct[sizeof(iv)]);
  memcpy(&ct[0], &iv, sizeof(iv));
  crypto::hash h;
  crypto::cn_fast_hash(ct.data(), ct.size() - sizeof(crypto::signature), h);
  crypto::signature &osig = *(crypto::signature *)&ct[ct.size() - sizeof(crypto::signature)];
  crypto::generate_signature(h, view_pub, view_sec, osig);
  /* And the envelope's own signature, through Monero's `check_signature`. The
   * vault has its own verifier for this one now; this is the other half of
   * that contract, so neither implementation is the other's only witness. */
  printf("outer_ok %d\n", crypto::check_signature(h, view_pub, osig) ? 1 : 0);

  std::string file = std::string(KEY_IMAGE_EXPORT_FILE_MAGIC, strlen(KEY_IMAGE_EXPORT_FILE_MAGIC)) + ct;
  hexout("iv", &iv, 8);
  hexout("file", file.data(), file.size());
  printf("magic_len %zu\n", strlen(KEY_IMAGE_EXPORT_FILE_MAGIC));
  return 0;
}
