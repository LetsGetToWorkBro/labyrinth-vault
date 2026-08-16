/*
 * The two things a person actually holds, encoded by Monero rather than by us.
 *
 * ## Why these two and not something else
 *
 * `test/monero.test.ts` checks the address encoder and the seed phrase
 * thoroughly, and every one of those checks is a round trip: encode then
 * decode, split then rejoin, the checksum word is at the index the checksum
 * function names. That is exactly the shape of test that let two mistakes live
 * in CLSAG for months -- an encoder and a decoder that make the same mistake
 * agree perfectly with each other and with nothing else.
 *
 * The consequences here are worse than a rejected transaction.
 *
 *   - A wrong **address** is money sent where nobody can spend it. And the
 *     watch-only companion derives its address from the same code, so it would
 *     agree, and the mistake would be invisible on both screens until somebody
 *     compared with a third wallet.
 *
 *   - A wrong **seed phrase** is worse still, because it fails silently and
 *     late. The whole point of twenty-five words is that they restore in
 *     Feather, in Cake, in monero-wallet-cli. A phrase that only this app can
 *     read is not a backup, it is a decoration, and the person finds out on
 *     the day the phone is gone.
 *
 * One real anchor existed before this: `KNOWN_ADDRESS`, the Monero project's
 * donation address, which anchors *parsing* one mainnet standard address.
 * Nothing anchored encoding, nothing anchored stagenet or testnet, nothing
 * anchored subaddresses or integrated addresses, and nothing at all anchored
 * the seed phrase.
 *
 * ## What this prints
 *
 * Given a spend secret and a network, everything Monero's own code makes of
 * it: the deterministic view secret, the standard address, subaddresses at
 * several indices, an integrated address, and the twenty-five English words.
 * It also reads its own address back through `get_account_address_from_str`
 * and prints the keys that came out, so a reader can see the encoder and the
 * decoder are Monero's on both ends.
 *
 * ## Usage
 *
 *   address <spendSecret> <mainnet|stagenet|testnet> <paymentIdHex16>
 */
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "common/util.h"
#include "cryptonote_basic/account.h"
#include "cryptonote_basic/cryptonote_basic_impl.h"
#include "cryptonote_basic/subaddress_index.h"
#include "device/device.hpp"
#include "mnemonics/electrum-words.h"
#include "wipeable_string.h"

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

static bool unhex(const char *s, void *out, size_t n) {
  if (strlen(s) != 2 * n) return false;
  for (size_t i = 0; i < n; i++) {
    unsigned byte;
    if (sscanf(s + 2 * i, "%2x", &byte) != 1) return false;
    ((unsigned char *)out)[i] = (unsigned char)byte;
  }
  return true;
}

int main(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr, "usage: address <spendSecret> <mainnet|stagenet|testnet> <paymentIdHex16>\n");
    return 2;
  }
  crypto::secret_key spend_secret;
  if (!unhex(argv[1], &spend_secret, 32)) {
    fprintf(stderr, "address: the spend secret must be 64 hex characters\n");
    return 2;
  }
  cryptonote::network_type nettype;
  if (!strcmp(argv[2], "mainnet")) nettype = cryptonote::MAINNET;
  else if (!strcmp(argv[2], "stagenet")) nettype = cryptonote::STAGENET;
  else if (!strcmp(argv[2], "testnet")) nettype = cryptonote::TESTNET;
  else {
    fprintf(stderr, "address: unknown network %s\n", argv[2]);
    return 2;
  }
  crypto::hash8 payment_id;
  if (!unhex(argv[3], &payment_id, 8)) {
    fprintf(stderr, "address: the payment id must be 16 hex characters\n");
    return 2;
  }

  /* `create_from_keys` would take a view secret; `generate` derives it the
   * deterministic way, which is the rule the vault follows: the view secret is
   * the reduced Keccak of the spend secret. Asking Monero for it rather than
   * asserting it is the point. */
  cryptonote::account_base account;
  account.generate(spend_secret, true /* recover */, false /* two_random */);
  const cryptonote::account_keys &keys = account.get_keys();

  printf("spend_secret %s\n", hex(&keys.m_spend_secret_key, 32).c_str());
  printf("view_secret %s\n", hex(&keys.m_view_secret_key, 32).c_str());
  printf("spend_public %s\n", hex(&keys.m_account_address.m_spend_public_key, 32).c_str());
  printf("view_public %s\n", hex(&keys.m_account_address.m_view_public_key, 32).c_str());

  const std::string address =
      cryptonote::get_account_address_as_str(nettype, false, keys.m_account_address);
  printf("address %s\n", address.c_str());
  printf("integrated %s\n",
         cryptonote::get_account_integrated_address_as_str(nettype, keys.m_account_address, payment_id).c_str());

  /* A spread of indices rather than one: (0,0) is the main address and is a
   * special case in every implementation, (0,1) and (1,0) separate the two
   * halves of the index, and a large minor catches a varint or an endianness
   * mistake that small numbers hide. */
  const std::pair<uint32_t, uint32_t> INDICES[] = {{0, 0}, {0, 1}, {1, 0}, {2, 3}, {0, 1000}};
  hw::device &hwdev = hw::get_device("default");
  for (const auto &index : INDICES) {
    const cryptonote::subaddress_index at{index.first, index.second};
    const cryptonote::account_public_address sub = hwdev.get_subaddress(keys, at);
    /* (0,0) is the main address and Monero encodes it with the standard tag,
     * not the subaddress tag, which is a distinction an implementation can
     * easily lose. */
    const bool is_subaddress = !(index.first == 0 && index.second == 0);
    printf("subaddress %u %u %s %s %s\n", index.first, index.second,
           hex(&sub.m_spend_public_key, 32).c_str(), hex(&sub.m_view_public_key, 32).c_str(),
           cryptonote::get_account_address_as_str(nettype, is_subaddress, sub).c_str());
  }

  /* The twenty-five words, from Monero's own wordlist and Monero's own
   * checksum. `bytes_to_words` takes the *spend* secret, which is the whole
   * seed: everything else is derived from it. */
  epee::wipeable_string words;
  if (!crypto::ElectrumWords::bytes_to_words(keys.m_spend_secret_key, words, "English")) {
    fprintf(stderr, "address: Monero would not turn this secret into words\n");
    return 1;
  }
  printf("mnemonic %s\n", std::string(words.data(), words.size()).c_str());

  /* And back, because a phrase that does not restore is not a phrase. This is
   * Monero reading Monero, so a reader can tell a broken harness from a broken
   * implementation without running anything. */
  crypto::secret_key restored;
  std::string language;
  const bool round_trip =
      crypto::ElectrumWords::words_to_bytes(words, restored, language) &&
      !memcmp(&restored, &keys.m_spend_secret_key, sizeof(restored));
  printf("mnemonic_round_trip %d\n", round_trip ? 1 : 0);
  printf("mnemonic_language %s\n", language.c_str());

  /* The address read back by Monero's own parser, so both ends of the string
   * are upstream and the fixture records what it decoded to. */
  cryptonote::address_parse_info parsed;
  if (!cryptonote::get_account_address_from_str(parsed, nettype, address)) {
    fprintf(stderr, "address: Monero would not parse the address it just wrote\n");
    return 1;
  }
  printf("parsed_spend %s\n", hex(&parsed.address.m_spend_public_key, 32).c_str());
  printf("parsed_view %s\n", hex(&parsed.address.m_view_public_key, 32).c_str());
  printf("parsed_is_subaddress %d\n", parsed.is_subaddress ? 1 : 0);
  printf("parsed_has_payment_id %d\n", parsed.has_payment_id ? 1 : 0);
  return 0;
}
