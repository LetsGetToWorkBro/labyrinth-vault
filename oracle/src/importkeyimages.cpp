/*
 * Hand a key-image export file to Monero's own wallet and see what it says.
 *
 * The other harnesses in this directory compile Monero's *crypto*: a few
 * thousand lines of curve arithmetic, linked directly. This one compiles
 * Monero's *wallet* -- wallet2.cpp and the hundred-odd translation units it
 * drags behind it -- so that the function under test is the real
 * `tools::wallet2::import_key_images(filename, spent, unspent)`, the one Cake,
 * Feather and `monero-wallet-cli` all call when somebody imports a file that
 * came off a cold wallet.
 *
 * ## Why this is worth the build
 *
 * `oracle/src/keyimage.cpp` already runs `crypto::check_ring_signature` over
 * every record, so the per-record gate is verified by Monero's own verifier.
 * What that cannot show is the part of `import_key_images` that has nothing to
 * do with cryptography:
 *
 *     const transfer_details &td = m_transfers[n + offset];
 *
 * Records are paired with outputs *by position*. Record 0 is checked against
 * the wallet's transfer at `offset`, record 1 against `offset + 1`, and so on.
 * Nothing in the file names an output. Get the order wrong, or write the wrong
 * offset, and the file is still perfectly well-formed and every signature in
 * it is still valid -- it just describes different outputs than the ones the
 * importing wallet checks it against, and the import fails.
 *
 * That is a claim about wallet2.cpp, and until this harness existed the only
 * evidence for it was that I had read wallet2.cpp. Now the evidence is that
 * wallet2 accepts a file whose records are in the right order and rejects the
 * same records in the wrong one.
 *
 * ## The wallet on the receiving end
 *
 * A watch-only wallet, because that is who imports one of these files. It
 * knows the view secret, so it can open the envelope; it knows the account's
 * public keys, so it can tell whether the file is for this account; and it
 * cannot compute key images for itself, which is the entire reason the file
 * exists.
 *
 * Its outputs are put there through `import_outputs`, which is public API.
 * That call insists each output really belongs to the account -- it re-derives
 * the one-time key from the transaction public key and the view secret and
 * refuses anything that does not match -- so the outputs here are built the
 * way a real transaction builds them, by `generate_key_derivation` and
 * `derive_public_key` from Monero's own crypto. `describe` prints them; the
 * vault re-derives the same keys from the same account and writes the file.
 *
 * On a watch-only wallet `import_outputs` fills in a placeholder key image for
 * each output, because deriving the real one needs the spend secret.
 * `import_key_images` sees the placeholder does not match the record and runs
 * the ring signature check, which is exactly the path a real import takes.
 *
 * ## What "ok" means here, and what it does not
 *
 * With records that check out, `import_key_images` gets past every offline
 * gate and then asks a daemon which of the key images are already spent. There
 * is no daemon here and there is not meant to be, so the call ends in
 * `no_connection_to_daemon`. That outcome is the good one: reaching the
 * network means the magic, the envelope signature, the account match, the
 * offset bound, the record count and every ring signature were all accepted
 * first, and the wallet's transfers have already been written.
 *
 * So the harness prints the key image sitting in each of the wallet's
 * transfers afterwards. That is the observation the whole build is for: not
 * "no exception was thrown" but "record n landed on transfer n + offset".
 *
 * ## Usage
 *
 *   importkeyimages describe <viewSec> <spendSec> <count> <pad>
 *   importkeyimages import   <viewSec> <spendSec> <count> <pad> <file>
 *
 *   viewSec, spendSec   the account. Both are needed: the view secret opens
 *                       the envelope, and the spend secret is only used for
 *                       its public key -- so a caller can point a *different*
 *                       account at a file and watch it be refused.
 *   count               outputs the file's records are supposed to be for.
 *   pad                 outputs to put in front of those, so a file written
 *                       with a non-zero offset can be aimed at the transfers
 *                       it means.
 *   file                the key-image export to import.
 *
 * Both subcommands build the same wallet and the same outputs from the same
 * arguments, so what `describe` prints is what `import` will be holding.
 */
#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "wallet/wallet2.h"
#include "cryptonote_basic/cryptonote_format_utils.h"

static void hexout(const char *label, const void *p, size_t n) {
  printf("%s ", label);
  for (size_t i = 0; i < n; i++) printf("%02x", ((const unsigned char *)p)[i]);
  printf("\n");
}

static void hexcat(std::string &out, const void *p, size_t n) {
  static const char *d = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) {
    unsigned char c = ((const unsigned char *)p)[i];
    out += d[c >> 4];
    out += d[c & 15];
  }
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

/**
 * A transaction secret, from counted-up bytes.
 *
 * Fixed rather than random so that `describe` and `import` agree and so that
 * the fixture regenerates byte for byte. The top byte is masked to keep the
 * value below the group order without needing a reduction, which would only
 * be one more thing to get subtly wrong in a test fixture.
 */
static crypto::secret_key tx_secret(unsigned seed) {
  crypto::secret_key s;
  for (size_t i = 0; i < sizeof(s); i++) ((unsigned char *)&s)[i] = (unsigned char)(seed * 37 + i * 7 + 1);
  ((unsigned char *)&s)[31] &= 0x0f;
  return s;
}

/** One output, made the way a transaction makes one: R = rG, P = Hs(rA||i)G + B. */
struct made_output {
  crypto::public_key tx_pub;
  size_t index;
  size_t outs_in_tx;
  crypto::public_key one_time_key;
};

static made_output make_output(const cryptonote::account_public_address &address, unsigned seed) {
  const crypto::secret_key r = tx_secret(seed);
  made_output made;
  crypto::secret_key_to_public_key(r, made.tx_pub);
  /* Three outputs per transaction and ours in a rotating slot, so that the
   * derivation index is not always zero. An index read as zero when it is not
   * produces a key that does not belong to anybody, which is a mistake worth
   * making impossible to hide. */
  made.outs_in_tx = 3;
  made.index = seed % 3;
  crypto::key_derivation derivation;
  if (!crypto::generate_key_derivation(address.m_view_public_key, r, derivation)) abort();
  if (!crypto::derive_public_key(derivation, made.index, address.m_spend_public_key, made.one_time_key)) abort();
  return made;
}

/**
 * One output, shaped the way a wallet's own scan would have shaped it.
 *
 * The transaction is Monero's `transaction_prefix` and the transaction public
 * key goes in through `add_tx_pub_key_to_extra`, so `get_public_key()` and
 * `get_tx_pub_key_from_received_outs` read it the way they read a real one.
 * The other outputs in the transaction are somebody else's: they are there so
 * the output index is a real index into a real vector.
 */
static tools::wallet2::transfer_details transfer_for(const made_output &made, uint64_t position) {
  tools::wallet2::transfer_details td = AUTO_VAL_INIT(td);
  td.m_block_height = 1000 + position;
  td.m_tx = cryptonote::transaction_prefix();
  td.m_tx.version = 2;
  td.m_tx.unlock_time = 0;
  for (size_t i = 0; i < made.outs_in_tx; i++) {
    cryptonote::tx_out out;
    out.amount = 0;
    cryptonote::txout_to_key target;
    if (i == made.index) {
      target.key = made.one_time_key;
    } else {
      // Somebody else's output. Any point off this account will do.
      crypto::secret_key_to_public_key(tx_secret((unsigned)(900 + position * 8 + i)), target.key);
    }
    out.target = target;
    td.m_tx.vout.push_back(out);
  }
  cryptonote::add_tx_pub_key_to_extra(td.m_tx, made.tx_pub);
  td.m_txid = cryptonote::get_transaction_prefix_hash(td.m_tx);
  td.m_internal_output_index = made.index;
  td.m_global_output_index = 500000 + position;
  td.m_spent = false;
  td.m_frozen = false;
  td.m_spent_height = 0;
  td.m_key_image = crypto::key_image{};
  td.m_mask = rct::identity();
  td.m_amount = 1000000000000ull;
  td.m_rct = true;
  td.m_key_image_known = false;
  td.m_key_image_request = true;
  td.m_key_image_partial = false;
  td.m_pk_index = 0;
  td.m_subaddr_index = {0, 0};
  return td;
}

int main(int argc, char **argv) {
  if (argc < 6) {
    fprintf(stderr, "usage: importkeyimages describe|import <viewSec> <spendSec> <count> <pad> [file]\n");
    return 2;
  }
  const std::string command = argv[1];
  const bool importing = command == "import";
  if (!importing && command != "describe") {
    fprintf(stderr, "importkeyimages: unknown command %s\n", command.c_str());
    return 2;
  }
  if (importing && argc < 7) {
    fprintf(stderr, "importkeyimages: import needs a file\n");
    return 2;
  }

  crypto::secret_key view_sec, spend_sec;
  if (!unhex(argv[2], &view_sec, 32) || !unhex(argv[3], &spend_sec, 32)) {
    fprintf(stderr, "importkeyimages: keys must be 64 hex characters\n");
    return 2;
  }
  const size_t count = (size_t)strtoul(argv[4], NULL, 10);
  const size_t pad = (size_t)strtoul(argv[5], NULL, 10);

  cryptonote::account_public_address address;
  crypto::secret_key_to_public_key(view_sec, address.m_view_public_key);
  crypto::secret_key_to_public_key(spend_sec, address.m_spend_public_key);
  hexout("view_pub", &address.m_view_public_key, 32);
  hexout("spend_pub", &address.m_spend_public_key, 32);
  printf("address %s\n",
         cryptonote::get_account_address_as_str(cryptonote::MAINNET, false, address).c_str());

  /* Padding first, then the outputs the file is about, which is the layout an
   * offset describes: the file's records start at `pad` in this list. */
  std::vector<made_output> pads, reals;
  for (size_t i = 0; i < pad; i++) pads.push_back(make_output(address, (unsigned)(200 + i)));
  for (size_t i = 0; i < count; i++) reals.push_back(make_output(address, (unsigned)(100 + i)));

  for (const made_output &made : reals) {
    std::string line;
    hexcat(line, &made.tx_pub, 32);
    line += " " + std::to_string(made.index) + " ";
    hexcat(line, &made.one_time_key, 32);
    printf("output %s\n", line.c_str());
  }

  if (!importing) return 0;

  tools::wallet2 wallet(cryptonote::MAINNET);
  // "" for the filename: build the wallet in memory and write nothing to disk.
  wallet.generate("", "", address, view_sec);

  std::vector<tools::wallet2::transfer_details> transfers;
  for (size_t i = 0; i < pads.size(); i++) transfers.push_back(transfer_for(pads[i], i));
  for (size_t i = 0; i < reals.size(); i++) transfers.push_back(transfer_for(reals[i], pads.size() + i));
  wallet.import_outputs(std::make_tuple((uint64_t)0, (uint64_t)transfers.size(), transfers));
  printf("transfers %zu\n", transfers.size());

  uint64_t spent = 0, unspent = 0;
  const char *outcome = "ok";
  std::string detail;
  try {
    const uint64_t imported = wallet.import_key_images(argv[6], spent, unspent);
    printf("imported %" PRIu64 "\n", imported);
  } catch (const tools::error::signature_check_failed &e) {
    outcome = "signature_check_failed";
    detail = e.what();
  } catch (const tools::error::no_connection_to_daemon &e) {
    /* The good outcome for a file that checks out: everything decidable
     * without a daemon was decided, and decided in the file's favour. */
    outcome = "no_connection_to_daemon";
    detail = e.what();
  } catch (const tools::error::wallet_internal_error &e) {
    outcome = "wallet_internal_error";
    detail = e.what();
  } catch (const std::exception &e) {
    outcome = "other";
    detail = e.what();
  }
  printf("outcome %s\n", outcome);
  if (!detail.empty()) {
    // One line: a newline inside a wallet error message would break the parser.
    for (char &c : detail) if (c == '\n' || c == '\r') c = ' ';
    printf("detail %s\n", detail.c_str());
  }

  /* What the wallet is holding afterwards. This is the part that shows where
   * each record landed, rather than merely that nothing objected. */
  tools::wallet2::transfer_container after;
  wallet.get_transfers(after);
  for (const auto &td : after) hexout("transfer_ki", &td.m_key_image, 32);
  return 0;
}
