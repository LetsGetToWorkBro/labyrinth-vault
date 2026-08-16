/*
 * Ask Monero's own consensus verifier what it thinks of a transaction we built.
 *
 * ## The claim this is for
 *
 * `docs/monero-send.md` has a section called "The verification frontier,
 * stated exactly", and until now it ended in the same place twice:
 *
 *   - CLSAG "round-trips and survives every tamper", because the Monero
 *     project ships no fixed CLSAG vector at all. Our prover and our verifier
 *     agreed with each other and with nothing else.
 *   - The Bulletproof+ verifier is anchored to real mainnet proofs, which is
 *     solid, and the *prover* is judged only by that verifier. Better than a
 *     closed loop, still not an outside opinion on a proof we made.
 *
 * The transactions this vault builds have therefore never been looked at by
 * Monero. This harness is that look. It links `ringct/rctSigs.cpp` and calls
 * the two functions a daemon calls on a transaction arriving from the network:
 *
 *   rct::verRctSemanticsSimple      the Bulletproof+ range proofs, and that
 *                                   the input commitments balance the output
 *                                   commitments plus the fee
 *   rct::verRctNonSemanticsSimple   every CLSAG, against the ring the chain
 *                                   says those key offsets point at
 *
 * plus `parse_and_validate_tx_from_blob`, which is the deserializer consensus
 * runs, and `get_transaction_hash` and `get_transaction_weight`, which are
 * where the txid and the number the fee is priced against actually come from.
 *
 * ## What it still is not
 *
 * A node does more than this. It checks that the ring members exist and are
 * old enough, that the key images are unspent, that the version and unlock
 * time suit the current fork, and that the fee clears the dynamic minimum.
 * Every one of those is a question about chain state, and none of them can be
 * answered without a chain. What is left over -- the deserialization, the
 * range proofs, the balance, the signatures -- is the part that is a question
 * about the bytes, and it is the part this repository writes.
 *
 * ## Where the ring comes from, and why that matters
 *
 * A transaction does not carry its ring. It carries *offsets*: the global
 * index of the first ring member, then deltas. A node turns those into keys by
 * looking them up on the chain, and then verifies the signature against what
 * it found -- not against what the signer believed.
 *
 * So this harness does the same thing. It is handed a table of
 * `globalIndex -> (one-time key, amount commitment)` standing in for the
 * chain, and it builds the ring by decoding the transaction's own offsets with
 * Monero's `relative_output_offsets_to_absolute` and looking each one up. If
 * the signer and the table disagree about any ring member, the signature fails
 * -- which is exactly what the "wrong-ring" case in the fixture demonstrates,
 * and it is the reason this is not simply handing the verifier back the ring
 * the signer used.
 *
 * The dozen lines that put the ring and the message into `rctSig` mirror
 * `Blockchain::expand_transaction_2`. That function is a static member of a
 * class that owns the block database, so linking it would mean linking lmdb's
 * blockchain layer and RandomX for a harness that verifies one transaction.
 * The values it assigns come from Monero's own `relative_output_offsets_to_absolute`
 * and `get_transaction_prefix_hash`; only the assignment is ours, and getting
 * it wrong makes verification fail rather than spuriously succeed.
 *
 * ## Usage
 *
 *   verifytx <file>
 *
 * where the file is lines of:
 *
 *   tx <hex>                                the raw transaction
 *   out <globalIndex> <key> <commitment>    one row of the stand-in chain
 */
#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "cryptonote_basic/cryptonote_basic.h"
#include "cryptonote_basic/cryptonote_format_utils.h"
#include "device/device.hpp"
#include "misc_log_ex.h"
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

static bool unhex(const std::string &s, std::string &out) {
  if (s.size() % 2) return false;
  out.clear();
  out.reserve(s.size() / 2);
  for (size_t i = 0; i < s.size(); i += 2) {
    unsigned byte;
    if (sscanf(s.c_str() + i, "%2x", &byte) != 1) return false;
    out += (char)byte;
  }
  return true;
}

static bool unhex32(const std::string &s, void *out) {
  std::string bytes;
  if (!unhex(s, bytes) || bytes.size() != 32) return false;
  memcpy(out, bytes.data(), 32);
  return true;
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: verifytx <file>\n");
    return 2;
  }
  /* Both verifiers say *why* they refused, at log level 1, and then throw the
   * reason away. Off by default so the fixture stays clean; on with
   * VERIFYTX_LOG=1, which is the difference between "rejected" and a debugging
   * session. It earned this on its first run. */
  if (getenv("VERIFYTX_LOG")) {
    mlog_configure("", true);
    mlog_set_log_level(2);
  }

  FILE *in = fopen(argv[1], "r");
  if (!in) {
    fprintf(stderr, "verifytx: cannot open %s\n", argv[1]);
    return 2;
  }

  std::string tx_hex;
  /* The stand-in for the chain: what is at each global output index. */
  std::map<uint64_t, rct::ctkey> chain;

  char *line = NULL;
  size_t cap = 0;
  while (getline(&line, &cap, in) > 0) {
    std::string text(line);
    while (!text.empty() && (text.back() == '\n' || text.back() == '\r')) text.pop_back();
    if (text.empty()) continue;
    char kind[16] = {0}, a[256] = {0}, b[256] = {0};
    unsigned long long index = 0;
    if (sscanf(text.c_str(), "%15s", kind) != 1) continue;
    if (!strcmp(kind, "tx")) {
      tx_hex = text.substr(3);
    } else if (!strcmp(kind, "out")) {
      if (sscanf(text.c_str(), "%15s %llu %255s %255s", kind, &index, a, b) != 4) {
        fprintf(stderr, "verifytx: bad out line: %s\n", text.c_str());
        return 2;
      }
      rct::ctkey entry;
      if (!unhex32(a, entry.dest.bytes) || !unhex32(b, entry.mask.bytes)) {
        fprintf(stderr, "verifytx: out %llu is not two 32-byte hex values\n", index);
        return 2;
      }
      chain[(uint64_t)index] = entry;
    }
  }
  free(line);
  fclose(in);

  std::string blob;
  if (tx_hex.empty() || !unhex(tx_hex, blob)) {
    fprintf(stderr, "verifytx: no usable tx line\n");
    return 2;
  }
  printf("blob_bytes %zu\n", blob.size());

  cryptonote::transaction tx;
  crypto::hash txid, prefix_hash;
  if (!cryptonote::parse_and_validate_tx_from_blob(blob, tx, txid, prefix_hash)) {
    /* A legitimate answer, not a harness failure: consensus refused to
     * deserialize these bytes, and the fixture should say so. */
    printf("parsed 0\n");
    printf("semantics_ok 0\nnon_semantics_ok 0\n");
    return 0;
  }
  printf("parsed 1\n");
  printf("txid %s\n", hex(&txid, 32).c_str());
  printf("prefix_hash %s\n", hex(&prefix_hash, 32).c_str());
  printf("version %" PRIu64 "\n", (uint64_t)tx.version);
  printf("unlock_time %" PRIu64 "\n", tx.unlock_time);
  printf("rct_type %d\n", (int)tx.rct_signatures.type);
  printf("inputs %zu\n", tx.vin.size());
  printf("outputs %zu\n", tx.vout.size());
  printf("fee %" PRIu64 "\n", tx.rct_signatures.txnFee);
  printf("weight %" PRIu64 "\n", cryptonote::get_transaction_weight(tx));

  /* The reconstruction a daemon does before it can verify anything: the
   * message is the prefix hash, and the ring is whatever the chain holds at
   * the offsets the transaction names. Mirrors Blockchain::expand_transaction_2;
   * see the header of this file for why it is not linked. */
  rct::rctSig &rv = tx.rct_signatures;
  rv.message = rct::hash2rct(prefix_hash);
  rv.mixRing.resize(tx.vin.size());
  for (size_t n = 0; n < tx.vin.size(); n++) {
    const cryptonote::txin_to_key *input = boost::get<cryptonote::txin_to_key>(&tx.vin[n]);
    if (!input) {
      fprintf(stderr, "verifytx: input %zu is not a txin_to_key\n", n);
      return 2;
    }
    const std::vector<uint64_t> absolute =
        cryptonote::relative_output_offsets_to_absolute(input->key_offsets);
    printf("key_image %s\n", hex(&input->k_image, 32).c_str());
    std::string indices;
    rv.mixRing[n].clear();
    for (const uint64_t index : absolute) {
      auto found = chain.find(index);
      if (found == chain.end()) {
        /* The chain does not have what the transaction points at. A node would
         * reject the transaction here; there is nothing to verify against. */
        printf("missing_output %" PRIu64 "\n", index);
        printf("semantics_ok 0\nnon_semantics_ok 0\n");
        return 0;
      }
      rv.mixRing[n].push_back(found->second);
      indices += (indices.empty() ? "" : ",") + std::to_string(index);
    }
    printf("ring %zu %s\n", n, indices.c_str());

    /* The key image is not stored inside the signature. It is already in the
     * input, so the serializer leaves it out and `expand_transaction_2` puts
     * it back before verifying. Forgetting this makes every CLSAG fail with no
     * hint as to why, which is exactly what it did here for an afternoon. */
    if (n < rv.p.CLSAGs.size()) rv.p.CLSAGs[n].I = rct::ki2rct(input->k_image);
  }

  /* The message every CLSAG in the transaction is actually over. It is not the
   * prefix hash: `verRctNonSemanticsSimple` runs `get_pre_mlsag_hash`, which
   * folds the prefix hash together with the hash of the rct base and the hash
   * of the range proofs. Printed because when a signature is refused, "did the
   * two sides agree on what was signed" is the first question, and answering
   * it from a rejection alone is impossible. */
  printf("pre_mlsag_hash %s\n",
         hex(rct::get_pre_mlsag_hash(rv, hw::get_device("default")).bytes, 32).c_str());
  for (size_t n = 0; n < rv.p.pseudoOuts.size(); n++) {
    printf("pseudo_out %s\n", hex(rv.p.pseudoOuts[n].bytes, 32).c_str());
  }

  /* Both verifiers, separately, because they fail for different reasons and
   * the reason is the interesting part. Semantics is the range proofs and the
   * balance; non-semantics is the signatures against the ring. */
  int semantics = 0, non_semantics = 0;
  try {
    semantics = rct::verRctSemanticsSimple(rv) ? 1 : 0;
  } catch (const std::exception &e) {
    fprintf(stderr, "verifytx: verRctSemanticsSimple threw: %s\n", e.what());
  }
  try {
    non_semantics = rct::verRctNonSemanticsSimple(rv) ? 1 : 0;
  } catch (const std::exception &e) {
    fprintf(stderr, "verifytx: verRctNonSemanticsSimple threw: %s\n", e.what());
  }
  printf("semantics_ok %d\n", semantics);
  printf("non_semantics_ok %d\n", non_semantics);
  return 0;
}
