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
  # of the struct, which is the whole reason that harness is worth having.
  git -C "$XMR" sparse-checkout set src contrib/epee tests/hash external/easylogging++ external/boost
fi

GOT=$(git -C "$XMR" rev-parse HEAD)
if [ "$GOT" != "$COMMIT" ]; then
  echo "oracle: checkout is $GOT, PINNED.json says $COMMIT" >&2
  echo "oracle: refusing to build against a different Monero than the one vendored" >&2
  exit 1
fi
say "monero $TAG at $COMMIT"

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
