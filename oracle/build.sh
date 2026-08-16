#!/usr/bin/env bash
#
# Build the oracle: Monero's own crypto, compiled here, so the fixtures in
# test/fixtures can be regenerated rather than believed.
#
#   ./oracle/build.sh            fetch the pinned Monero and build both harnesses
#   ./oracle/build.sh --check    build, then verify against the published vectors
#
# Everything lands in oracle/.work/, which is git-ignored. Nothing here runs in
# `npm test`: it needs a Monero checkout and boost headers, and a test suite
# that fetched half a gigabyte of C++ would be a test suite people skip. The
# fixtures are committed instead, and this is how somebody checks them.
#
# See oracle/README.md for why any of this exists.

set -euo pipefail
cd "$(dirname "$0")/.."

PINNED="oracle/PINNED.json"
TAG=$(node -e "console.log(require('./$PINNED').tag)")
COMMIT=$(node -e "console.log(require('./$PINNED').commit)")
WORK="oracle/.work"
XMR="$WORK/monero"

say() { printf '\noracle: %s\n' "$1"; }

# --- the upstream, at the pinned tag and nowhere else -----------------------
if [ ! -d "$XMR/src/crypto" ]; then
  say "fetching monero $TAG"
  mkdir -p "$WORK"
  rm -rf "$XMR"
  git clone --depth 1 --branch "$TAG" --filter=blob:none --sparse \
    https://github.com/monero-project/monero.git "$XMR"
  # wallet2.h drags in most of the tree. The unsignedtxset harness includes it
  # so that it uses Monero's actual unsigned_tx_set rather than a transcription
  # of the struct, which is the whole reason that harness is worth having. The
  # importkeyimages harness goes further and *links* wallet2.cpp, which is why
  # db_drivers (lmdb, for ringdb.h) and translations are here too.
  git -C "$XMR" sparse-checkout set src contrib/epee tests/hash \
    external/easylogging++ external/boost external/db_drivers translations
fi

GOT=$(git -C "$XMR" rev-parse HEAD)
if [ "$GOT" != "$COMMIT" ]; then
  echo "oracle: checkout is $GOT, PINNED.json says $COMMIT" >&2
  echo "oracle: refusing to build against a different Monero than the one vendored" >&2
  exit 1
fi
say "monero $TAG at $COMMIT"

# rapidjson is a submodule rather than a directory, so the sparse checkout does
# not bring it, and wallet2.cpp includes it. The commit comes out of the pinned
# Monero's own tree, read *after* the check above, so "the pinned Monero"
# means the same thing here as it does upstream and a wrong checkout cannot
# name a rapidjson of its own.
RAPIDJSON="$WORK/rapidjson"
RAPIDJSON_COMMIT=$(git -C "$XMR" ls-tree HEAD external/rapidjson | awk '{print $3}')
if [ ! -d "$RAPIDJSON/include" ]; then
  say "fetching rapidjson $RAPIDJSON_COMMIT"
  rm -rf "$RAPIDJSON"
  git clone -q --filter=blob:none https://github.com/Tencent/rapidjson.git "$RAPIDJSON"
fi
git -C "$RAPIDJSON" checkout -q "$RAPIDJSON_COMMIT"

INC="-I$XMR/src -I$XMR/src/crypto -I$XMR/contrib/epee/include -Ioracle/src/shim"
# The unsignedtxset harness needs more of the tree than the crypto harnesses do.
WIDE="-I$XMR/src -I$XMR/contrib/epee/include -I$XMR/external/easylogging++ -I$XMR/external -Ioracle/src/shim"
OBJ="$WORK/obj"
mkdir -p "$OBJ"

# --- Monero's C, compiled as C -----------------------------------------------
# NO_AES picks the portable CryptoNight, which is the one vendor/cryptonight
# ships, so the oracle and the app are running the same code path and not two
# that merely agree on four vectors.
CFILES="crypto-ops crypto-ops-data chacha keccak hash blake256 groestl jh skein
        oaes_lib aesb hash-extra-blake hash-extra-groestl hash-extra-jh
        hash-extra-skein slow-hash tree-hash"
for f in $CFILES; do
  [ "$OBJ/$f.o" -nt "$XMR/src/crypto/$f.c" ] 2>/dev/null && continue
  gcc -O2 -c -DNO_AES -DFORCE_USE_HEAP $INC -o "$OBJ/$f.o" "$XMR/src/crypto/$f.c"
done
gcc -O2 -c $INC -o "$OBJ/memwipe.o" "$XMR/contrib/epee/src/memwipe.c"

# --- our stubs ---------------------------------------------------------------
# rng-counter replaces Monero's RNG with a byte counter, which is the only
# reason a signature can be compared against a second implementation at all.
gcc -O2 -c $INC -o "$OBJ/rng-counter.o" oracle/src/rng-counter.c
gcc -O2 -c $INC -o "$OBJ/unreachable.o" oracle/src/unreachable.c
g++ -O2 -std=c++17 -c $INC -o "$OBJ/mlock-stub.o" oracle/src/mlock-stub.cpp

# --- Monero's C++ ------------------------------------------------------------
g++ -O2 -std=c++17 -c $INC -o "$OBJ/crypto.o" "$XMR/src/crypto/crypto.cpp"

# --- the two harnesses -------------------------------------------------------
say "linking harnesses"
gcc -O2 -DNO_AES -DFORCE_USE_HEAP $INC -o "$WORK/cryptonight" oracle/src/cryptonight.c \
  "$OBJ"/{crypto-ops,crypto-ops-data,chacha,keccak,hash,blake256,groestl,jh,skein,oaes_lib,aesb}.o \
  "$OBJ"/hash-extra-{blake,groestl,jh,skein}.o \
  "$OBJ"/{slow-hash,tree-hash,memwipe,unreachable}.o -lm

g++ -O2 -std=c++17 $INC -o "$WORK/keyimage" oracle/src/keyimage.cpp \
  "$OBJ"/*.o -lm -lpthread

# This one includes wallet/wallet2.h, so it uses Monero's real unsigned_tx_set,
# tx_construction_data, tx_source_entry and tx_destination_entry. Nothing about
# the layout is transcribed. It needs boost_serialization and openssl because
# wallet2.h reaches them transitively, not because this harness uses either.
g++ -O1 -std=c++17 $WIDE -o "$WORK/unsignedtxset" oracle/src/unsignedtxset.cpp \
  "$OBJ"/*.o -lm -lpthread -lboost_serialization -lssl -lcrypto

say "built $WORK/cryptonight, $WORK/keyimage and $WORK/unsignedtxset"

# =============================================================================
# The wallet
#
# Everything above compiles Monero's crypto: a few thousand lines, a handful of
# translation units, seconds to build. What follows compiles Monero's *wallet*,
# so that `oracle/src/importkeyimages.cpp` can call the real
# `tools::wallet2::import_key_images` on a file this repository wrote. That is
# the difference between "our records pass Monero's signature verifier" and
# "Monero's wallet imports our file", and the second one is what the product
# actually claims.
#
# It is a much heavier build: about a hundred translation units and a few
# minutes on a laptop. It is also the reason for the extra host dependencies
# listed in PINNED.json. Everything below is cached in oracle/.work/wobj, so a
# second run is quick.
# =============================================================================

missing=""
for header in /usr/include/unbound.h /usr/include/sodium.h \
              /usr/include/boost/filesystem.hpp /usr/include/boost/program_options.hpp \
              /usr/include/boost/regex.hpp; do
  [ -f "$header" ] || missing="$missing $header"
done
if [ -n "$missing" ]; then
  echo "oracle: the wallet build needs headers this machine does not have:$missing" >&2
  echo "oracle: on Debian or Ubuntu:" >&2
  echo "oracle:   apt-get install libunbound-dev libsodium-dev libboost-filesystem-dev \\" >&2
  echo "oracle:     libboost-program-options-dev libboost-regex-dev libboost-thread-dev \\" >&2
  echo "oracle:     libboost-chrono-dev libboost-date-time-dev" >&2
  exit 1
fi

# --- the headers cmake would have generated -----------------------------------
# Three files that a normal Monero build produces at configure time. Each is
# made the way cmake makes it, from Monero's own template or Monero's own
# generator, rather than hand-written to look right.
GEN="$WORK/generated"
mkdir -p "$GEN/crypto/wallet"
# src/crypto/wallet/CMakeLists.txt: with the internal ("cn") crypto backend,
# which is the default and the one vendor/cryptonight matches, ops.h is
# configured from empty.h.in and is empty.
cp "$XMR/src/crypto/wallet/empty.h.in" "$GEN/crypto/wallet/ops.h"
# translations/generate_translations_header.c, run with no .qm files, which is
# what a build without Qt's lrelease produces: an empty embedded-file table.
if [ ! -x "$WORK/gen-translations" ]; then
  gcc -O1 -w -o "$WORK/gen-translations" "$XMR/translations/generate_translations_header.c"
fi
(cd "$GEN" && "$(cd "$OLDPWD/$WORK" && pwd)/gen-translations" >/dev/null)
# src/version.cpp.in, with the two values cmake substitutes for a git build.
sed -e "s/@VERSIONTAG@/$(echo "$COMMIT" | cut -c1-9)/" \
    -e "s/@VERSION_IS_RELEASE@/false/" \
    "$XMR/src/version.cpp.in" > "$GEN/version.cpp"

WOBJ="$WORK/wobj"
mkdir -p "$WOBJ"
WALL="-I$XMR/src -I$XMR/contrib/epee/include -I$XMR/external/easylogging++ -I$XMR/external \
      -I$XMR/external/db_drivers/liblmdb -I$RAPIDJSON/include -I$GEN -Ioracle/src/shim"
# -w because upstream at -O1 is loud and none of it is ours to fix. -O1 rather
# than -O2 because this is a hundred translation units of template-heavy C++
# and none of it is on a hot path.
WCXX="-O1 -std=c++17 -w -DAUTO_INITIALIZE_EASYLOGGINGPP"
WCC="-O2 -w -DNO_AES -DFORCE_USE_HEAP"

# Monero's C. Same NO_AES as above, for the same reason.
WALLET_C="src/crypto/crypto-ops.c src/crypto/crypto-ops-data.c src/crypto/chacha.c
  src/crypto/keccak.c src/crypto/hash.c src/crypto/blake256.c src/crypto/groestl.c
  src/crypto/jh.c src/crypto/skein.c src/crypto/oaes_lib.c src/crypto/aesb.c
  src/crypto/hash-extra-blake.c src/crypto/hash-extra-groestl.c src/crypto/hash-extra-jh.c
  src/crypto/hash-extra-skein.c src/crypto/slow-hash.c src/crypto/tree-hash.c
  src/crypto/hmac-keccak.c src/crypto/random.c src/common/aligned.c
  src/ringct/rctCryptoOps.c contrib/epee/src/memwipe.c
  external/db_drivers/liblmdb/mdb.c external/db_drivers/liblmdb/midl.c"

# Monero's C++. This is the set the linker turned out to need, arrived at by
# starting from wallet2.cpp and adding whatever came up undefined; nothing here
# is optional and nothing here is a substitute for anything.
#
# multisig/ is in the list because wallet2.cpp calls into it and the link fails
# without it. It says nothing about what this product offers: the vault signs
# single-signature only, and test/app-wiring.test.ts holds it to that.
WALLET_CXX="src/wallet/wallet2.cpp src/wallet/node_rpc_proxy.cpp src/wallet/ringdb.cpp
  src/wallet/wallet_rpc_payments.cpp src/wallet/wallet_args.cpp
  src/wallet/message_store.cpp src/wallet/message_transporter.cpp
  src/cryptonote_basic/account.cpp src/cryptonote_basic/cryptonote_basic_impl.cpp
  src/cryptonote_basic/cryptonote_format_utils.cpp
  src/cryptonote_basic/cryptonote_format_utils_basic.cpp
  src/cryptonote_basic/difficulty.cpp src/cryptonote_basic/hardfork.cpp
  src/cryptonote_basic/merge_mining.cpp src/cryptonote_basic/miner.cpp
  src/cryptonote_core/cryptonote_tx_utils.cpp src/cryptonote_core/tx_sanity_check.cpp
  src/ringct/rctOps.cpp src/ringct/rctSigs.cpp src/ringct/rctTypes.cpp
  src/ringct/bulletproofs.cc src/ringct/bulletproofs_plus.cc src/ringct/multiexp.cc
  src/device/device.cpp src/device/device_default.cpp src/device/log.cpp
  src/device_trezor/device_trezor.cpp
  src/multisig/multisig.cpp src/multisig/multisig_account.cpp
  src/multisig/multisig_account_kex_impl.cpp src/multisig/multisig_clsag_context.cpp
  src/multisig/multisig_kex_msg.cpp src/multisig/multisig_tx_builder_ringct.cpp
  src/mnemonics/electrum-words.cpp src/hardforks/hardforks.cpp
  src/checkpoints/checkpoints.cpp
  src/common/base58.cpp src/common/combinator.cpp src/common/command_line.cpp
  src/common/dns_utils.cpp src/common/error.cpp src/common/expect.cpp
  src/common/i18n.cpp src/common/notify.cpp src/common/password.cpp
  src/common/perf_timer.cpp src/common/pruning.cpp src/common/spawn.cpp
  src/common/threadpool.cpp src/common/util.cpp
  src/net/dandelionpp.cpp src/net/error.cpp src/net/http.cpp src/net/i2p_address.cpp
  src/net/parse.cpp src/net/resolve.cpp src/net/socks.cpp src/net/socks_connect.cpp
  src/net/tor_address.cpp
  src/rpc/rpc_payment_signature.cpp src/rpc/rpc_version_str.cpp
  src/crypto/crypto.cpp
  contrib/epee/src/abstract_http_client.cpp contrib/epee/src/buffer.cpp
  contrib/epee/src/byte_slice.cpp contrib/epee/src/byte_stream.cpp
  contrib/epee/src/connection_basic.cpp contrib/epee/src/file_io_utils.cpp
  contrib/epee/src/hex.cpp contrib/epee/src/http_auth.cpp contrib/epee/src/http_base.cpp
  contrib/epee/src/int-util.cpp contrib/epee/src/levin_base.cpp
  contrib/epee/src/misc_language.cpp contrib/epee/src/mlocker.cpp contrib/epee/src/mlog.cpp
  contrib/epee/src/net_helper.cpp contrib/epee/src/net_parse_helpers.cpp
  contrib/epee/src/net_ssl.cpp contrib/epee/src/net_utils_base.cpp
  contrib/epee/src/network_throttle.cpp contrib/epee/src/network_throttle-detail.cpp
  contrib/epee/src/parserse_base_utils.cpp contrib/epee/src/portable_storage.cpp
  contrib/epee/src/string_tools.cpp contrib/epee/src/wipeable_string.cpp
  external/easylogging++/easylogging++.cc"

say "compiling monero's wallet (this is the slow part)"
for f in $WALLET_C; do
  o="$WOBJ/$(echo "$f" | tr '/' '_').o"
  [ -f "$o" ] && [ "$o" -nt "$XMR/$f" ] && continue
  gcc $WCC $WALL -c -o "$o" "$XMR/$f"
done
for f in $WALLET_CXX; do
  o="$WOBJ/$(echo "$f" | tr '/' '_').o"
  [ -f "$o" ] && [ "$o" -nt "$XMR/$f" ] && continue
  echo "  $f"
  g++ $WCXX $WALL -c -o "$o" "$XMR/$f"
done
g++ $WCXX $WALL -c -o "$WOBJ/version.o" "$GEN/version.cpp"
g++ $WCXX $WALL -c -o "$WOBJ/wallet-unreachable.o" oracle/src/wallet-unreachable.cpp
g++ $WCXX $WALL -c -o "$WOBJ/importkeyimages.o" oracle/src/importkeyimages.cpp

say "linking importkeyimages"
g++ -o "$WORK/importkeyimages" "$WOBJ"/*.o \
  -lboost_serialization -lboost_filesystem -lboost_system -lboost_thread \
  -lboost_chrono -lboost_regex -lboost_program_options -lboost_date_time \
  -lssl -lcrypto -lunbound -lsodium -lpthread -lm -ldl

say "built $WORK/importkeyimages"

# --- the check ---------------------------------------------------------------
if [ "${1:-}" = "--check" ]; then
  say "checking against tests/hash/tests-slow.txt"
  fail=0
  while read -r want data; do
    got=$("$WORK/cryptonight" "$data")
    if [ "$got" = "$want" ]; then echo "  ok   $want"
    else echo "  FAIL want=$want got=$got"; fail=1; fi
  done < "$XMR/tests/hash/tests-slow.txt"
  [ "$fail" = 0 ] || { echo "oracle: CryptoNight does not match Monero's own vectors" >&2; exit 1; }
  say "all four official vectors match"
fi
