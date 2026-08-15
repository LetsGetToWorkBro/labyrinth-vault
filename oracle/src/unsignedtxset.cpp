/*
 * A real `unsigned_tx_set`, serialized by Monero's own binary archive.
 *
 * This includes `wallet/wallet2.h` and uses the actual `wallet2::unsigned_tx_set`,
 * `tx_construction_data`, `tx_source_entry` and `tx_destination_entry`. None of
 * the layout is transcribed here, which is the point: a harness that
 * re-declared those structs would be testing my reading of a header, and the
 * whole reason this rig exists is to test against Monero rather than against
 * my reading of Monero.
 *
 * It prints two things:
 *
 *   archive <hex>     the bytes `binary_archive<true>` produced
 *   meaning <json>    what was put in, field by field
 *
 * The TypeScript in src/keys/monerounsigned.ts has to turn the first into the
 * second. That is a stronger test than a round trip, because a round trip only
 * proves a reader and a writer agree with each other.
 *
 * Everything is filled with counted-up bytes and round numbers so the output
 * is reproducible and so a field read at the wrong offset lands on an
 * obviously wrong value rather than on plausible noise.
 *
 * ## The one thing worth staring at
 *
 * `tx_source_entry::amount` is `FIELD(amount)` and `tx_destination_entry::amount`
 * is `VARINT_FIELD(amount)`. Same type, same name, two different encodings:
 * eight fixed little-endian bytes in one, a varint in the other. A reader that
 * gets that backwards still parses, still produces amounts, and is wrong. The
 * amounts below are chosen so the two encodings have different lengths, so
 * that mistake desynchronises the stream instead of hiding.
 */

#include <cstdio>
#include <cstring>
#include <sstream>
#include <string>

#include "wallet/wallet2.h"
#include "serialization/binary_archive.h"
#include "crypto/chacha.h"

static std::string hex(const std::string &s) {
    static const char *d = "0123456789abcdef";
    std::string out;
    out.reserve(s.size() * 2);
    for (unsigned char c : s) { out += d[c >> 4]; out += d[c & 15]; }
    return out;
}

static std::string hex(const void *p, size_t n) {
    return hex(std::string((const char *)p, n));
}

/** Counted-up bytes, offset by `seed`, so every field is distinguishable. */
static crypto::public_key key_of(unsigned seed) {
    crypto::public_key k;
    for (size_t i = 0; i < sizeof(k); i++) ((unsigned char *)&k)[i] = (unsigned char)(seed + i);
    return k;
}

static rct::key rct_key_of(unsigned seed) {
    rct::key k;
    for (size_t i = 0; i < sizeof(k); i++) k.bytes[i] = (unsigned char)(seed + i);
    return k;
}

int main() {
    tools::wallet2::unsigned_tx_set txs;

    // ---- one transaction, with two ring members and two destinations -------
    tools::wallet2::tx_construction_data tx;

    cryptonote::tx_source_entry src;
    for (unsigned i = 0; i < 2; i++) {
        rct::ctkey ck;
        ck.dest = rct_key_of(0x10 + i * 0x40);
        ck.mask = rct_key_of(0x30 + i * 0x40);
        src.outputs.push_back(std::make_pair(1000000ull + i, ck));
    }
    src.real_output = 1;
    src.real_out_tx_key = key_of(0x80);
    src.real_out_additional_tx_keys.push_back(key_of(0xa0));
    src.real_output_in_tx_index = 3;
    /* Fixed eight bytes on the wire. Deliberately large enough that a varint
     * of the same value would be nine bytes, not eight. */
    src.amount = 3000000000000ull;
    src.rct = true;
    src.mask = rct_key_of(0xc0);
    /* `tx_source_entry::multisig_kLRki` has no default initialiser, so a
     * freshly constructed source carries whatever was on the stack, and
     * `FIELD(multisig_kLRki)` serializes all 128 bytes of it. Two runs of this
     * harness therefore produced two different archives until this line
     * existed, which `node oracle/emit.mjs --check` caught the first time it
     * was pointed at this fixture.
     *
     * A real wallet writes zeroes here for a single-signature spend. Setting
     * them explicitly is what makes the fixture reproducible, and it is also
     * what the reader in monerounsigned.ts is entitled to expect. */
    memset(&src.multisig_kLRki, 0, sizeof(src.multisig_kLRki));
    tx.sources.push_back(src);

    cryptonote::tx_destination_entry change;
    change.amount = 500000000000ull;          // varint on the wire
    change.addr.m_spend_public_key = key_of(0x01);
    change.addr.m_view_public_key = key_of(0x21);
    change.is_subaddress = false;
    change.is_integrated = false;
    tx.change_dts = change;

    cryptonote::tx_destination_entry pay;
    pay.original = "4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2684Rge";
    pay.amount = 2400000000000ull;
    pay.addr.m_spend_public_key = key_of(0x41);
    pay.addr.m_view_public_key = key_of(0x61);
    pay.is_subaddress = true;
    pay.is_integrated = false;

    tx.splitted_dsts.push_back(pay);
    tx.splitted_dsts.push_back(change);
    tx.dests.push_back(pay);

    tx.selected_transfers.push_back(7);
    tx.selected_transfers.push_back(9);
    tx.extra = std::vector<uint8_t>{0x01, 0x02, 0x03, 0x04, 0x05};
    tx.unlock_time = 0;
    tx.use_rct = true;
    tx.use_view_tags = true;
    tx.rct_config = { rct::RangeProofPaddedBulletproof, 4 };
    tx.subaddr_account = 2;
    tx.subaddr_indices.insert(0);
    tx.subaddr_indices.insert(5);

    txs.txes.push_back(tx);

    // ---- one exported transfer --------------------------------------------
    tools::wallet2::exported_transfer_details etd;
    etd.m_pubkey = key_of(0x11);
    etd.m_internal_output_index = 1;
    etd.m_global_output_index = 987654;
    etd.m_tx_pubkey = key_of(0x31);
    etd.m_flags.flags = 0;
    etd.m_flags.m_rct = 1;
    etd.m_flags.m_key_image_request = 1;
    etd.m_amount = 3000000000000ull;
    etd.m_additional_tx_keys.push_back(key_of(0x51));
    etd.m_subaddr_index_major = 2;
    etd.m_subaddr_index_minor = 5;

    std::get<0>(txs.new_transfers) = 12;
    std::get<1>(txs.new_transfers) = 13;
    std::get<2>(txs.new_transfers).push_back(etd);

    // ---- serialize ---------------------------------------------------------
    std::stringstream ss;
    binary_archive<true> ar(ss);
    if (!::serialization::serialize(ar, txs)) {
        fprintf(stderr, "unsignedtxset: serialize failed\n");
        return 1;
    }
    const std::string blob = ss.str();

    printf("archive %s\n", hex(blob).c_str());

    /* And the whole file as wallet2 writes it. `dump_tx_to_str` wraps the
     * archive in `encrypt_with_view_secret_key`, which is the same envelope
     * the key-image export uses: a CryptoNight-derived ChaCha20 key, an
     * 8-byte IV, and a signature made with the view secret key over
     * cn_fast_hash(iv || ciphertext). Reproduced here from the same primitives
     * rather than by instantiating a wallet2, which would need a daemon.
     *
     * The RNG is the counter stub, so the IV and the signature nonce are
     * reproducible; see oracle/src/rng-counter.c. */
    crypto::secret_key view_sec;
    for (size_t i = 0; i < sizeof(view_sec); i++)
        ((unsigned char *)&view_sec)[i] = (unsigned char)(0x71 + i);
    /* Reduce it so it is a valid scalar. */
    sc_reduce32((unsigned char *)&view_sec);
    crypto::public_key view_pub;
    crypto::secret_key_to_public_key(view_sec, view_pub);

    crypto::chacha_key ck;
    crypto::generate_chacha_key(&view_sec, sizeof(view_sec), ck, 1);

    crypto::chacha_iv iv = crypto::rand<crypto::chacha_iv>();
    std::string ct;
    ct.resize(blob.size() + sizeof(iv) + sizeof(crypto::signature));
    crypto::chacha20(blob.data(), blob.size(), ck, iv, &ct[sizeof(iv)]);
    memcpy(&ct[0], &iv, sizeof(iv));
    crypto::hash h;
    crypto::cn_fast_hash(ct.data(), ct.size() - sizeof(crypto::signature), h);
    crypto::generate_signature(h, view_pub, view_sec,
        *(crypto::signature *)&ct[ct.size() - sizeof(crypto::signature)]);

    const char *PREFIX = "Monero unsigned tx set\005";
    std::string file = std::string(PREFIX, strlen(PREFIX)) + ct;
    printf("viewSecret %s\n", hex(&view_sec, 32).c_str());
    printf("chachaKey %s\n", hex(ck.data(), 32).c_str());
    printf("file %s\n", hex(file).c_str());

    // ---- and say what it means --------------------------------------------
    printf("meaning {");
    printf("\"txes\":[{");
    printf("\"sources\":[{");
    printf("\"ringSize\":%zu,", src.outputs.size());
    printf("\"outputs\":[");
    for (size_t i = 0; i < src.outputs.size(); i++) {
        printf("%s{\"index\":%llu,\"dest\":\"%s\",\"mask\":\"%s\"}", i ? "," : "",
               (unsigned long long)src.outputs[i].first,
               hex(src.outputs[i].second.dest.bytes, 32).c_str(),
               hex(src.outputs[i].second.mask.bytes, 32).c_str());
    }
    printf("],");
    printf("\"realOutput\":%llu,", (unsigned long long)src.real_output);
    printf("\"realOutTxKey\":\"%s\",", hex(&src.real_out_tx_key, 32).c_str());
    printf("\"realOutAdditionalTxKeys\":[\"%s\"],", hex(&src.real_out_additional_tx_keys[0], 32).c_str());
    printf("\"realOutputInTxIndex\":%llu,", (unsigned long long)src.real_output_in_tx_index);
    printf("\"amount\":\"%llu\",", (unsigned long long)src.amount);
    printf("\"rct\":%s,", src.rct ? "true" : "false");
    printf("\"mask\":\"%s\"", hex(src.mask.bytes, 32).c_str());
    printf("}],");

    auto dest_json = [&](const cryptonote::tx_destination_entry &d) {
        printf("{\"original\":\"%s\",\"amount\":\"%llu\",\"spendPublic\":\"%s\","
               "\"viewPublic\":\"%s\",\"isSubaddress\":%s,\"isIntegrated\":%s}",
               d.original.c_str(), (unsigned long long)d.amount,
               hex(&d.addr.m_spend_public_key, 32).c_str(),
               hex(&d.addr.m_view_public_key, 32).c_str(),
               d.is_subaddress ? "true" : "false",
               d.is_integrated ? "true" : "false");
    };

    printf("\"changeDts\":"); dest_json(tx.change_dts); printf(",");
    printf("\"splittedDsts\":[");
    for (size_t i = 0; i < tx.splitted_dsts.size(); i++) { if (i) printf(","); dest_json(tx.splitted_dsts[i]); }
    printf("],");
    printf("\"selectedTransfers\":[7,9],");
    printf("\"extra\":\"%s\",", hex(tx.extra.data(), tx.extra.size()).c_str());
    printf("\"unlockTime\":\"%llu\",", (unsigned long long)tx.unlock_time);
    printf("\"useRct\":%s,", tx.use_rct ? "true" : "false");
    printf("\"useViewTags\":%s,", tx.use_view_tags ? "true" : "false");
    printf("\"rctType\":%d,", (int)tx.rct_config.range_proof_type);
    printf("\"bpVersion\":%d,", tx.rct_config.bp_version);
    printf("\"dests\":["); dest_json(tx.dests[0]); printf("],");
    printf("\"subaddrAccount\":%u,", tx.subaddr_account);
    printf("\"subaddrIndices\":[0,5]");
    printf("}],");

    printf("\"newTransfers\":{\"first\":12,\"second\":13,\"details\":[{");
    printf("\"pubkey\":\"%s\",", hex(&etd.m_pubkey, 32).c_str());
    printf("\"internalOutputIndex\":%llu,", (unsigned long long)etd.m_internal_output_index);
    printf("\"globalOutputIndex\":%llu,", (unsigned long long)etd.m_global_output_index);
    printf("\"txPubkey\":\"%s\",", hex(&etd.m_tx_pubkey, 32).c_str());
    printf("\"flags\":%u,", (unsigned)etd.m_flags.flags);
    printf("\"amount\":\"%llu\",", (unsigned long long)etd.m_amount);
    printf("\"additionalTxKeys\":[\"%s\"],", hex(&etd.m_additional_tx_keys[0], 32).c_str());
    printf("\"subaddrMajor\":%u,", etd.m_subaddr_index_major);
    printf("\"subaddrMinor\":%u", etd.m_subaddr_index_minor);
    printf("}]}");
    printf("}\n");

    return 0;
}
