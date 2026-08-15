#!/usr/bin/env bash
#
# Set up the Bitcoin half of the oracle: Electrum and Coinkite's BBQr, in
# Python, at the commits oracle/PINNED.json names.
#
#   ./oracle/btc.sh          clone and pip-install both
#
# Then `node oracle/btc-emit.mjs --check` regenerates the two Bitcoin fixtures
# and diffs them against the tree.
#
# Same reasoning as build.sh: this is not in `npm test`. It clones two
# repositories and installs a dozen Python packages, and the fixtures are
# committed so that the ordinary run needs none of it.

set -euo pipefail
cd "$(dirname "$0")/.."

WORK="oracle/.work"
ELECTRUM_COMMIT=$(node -e "console.log(require('./oracle/PINNED.json').bitcoin.electrum.commit)")

say() { printf '\noracle: %s\n' "$1"; }

mkdir -p "$WORK"

if [ ! -d "$WORK/electrum/electrum" ]; then
  say "fetching electrum"
  rm -rf "$WORK/electrum"
  git clone --filter=blob:none --sparse https://github.com/spesmilo/electrum.git "$WORK/electrum"
  git -C "$WORK/electrum" sparse-checkout set electrum
fi
git -C "$WORK/electrum" fetch --depth 1 origin "$ELECTRUM_COMMIT" 2>/dev/null || true
git -C "$WORK/electrum" checkout -q "$ELECTRUM_COMMIT"
say "electrum at $ELECTRUM_COMMIT"

if [ ! -d "$WORK/bbqr/python" ]; then
  say "fetching the BBQr reference"
  rm -rf "$WORK/bbqr"
  git clone --depth 1 https://github.com/coinkite/BBQr.git "$WORK/bbqr"
fi

# Electrum's package imports a lot before it will hand over base_encode. These
# are import-time dependencies only; nothing here talks to a network.
say "installing python dependencies"
pip install --quiet aiohttp aiohttp_socks aiorpcx electrum_ecc dnspython jsonpatch electrum_aionostr

say "ready. now: node oracle/btc-emit.mjs --check"
