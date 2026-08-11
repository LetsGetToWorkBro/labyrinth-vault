#!/usr/bin/env bash
#
# A Swift toolchain on Linux, verified rather than trusted.
#
# `scripts/swift-check.sh` compiles the platform-free half of the app and runs
# its tests. It skips, loudly, when there is no `swift` on PATH, which is the
# normal state of a fresh Linux container. This puts one there.
#
# ## Why this is not four lines of curl
#
# Because a toolchain is the most dangerous thing you can install. Every byte
# of this repository eventually passes through a compiler, and a compromised
# compiler produces a signing device that looks correct and is not. That is not
# a hypothetical about this project specifically, it is the oldest published
# attack on trusting trust, and the answer to it is not to skip the check
# because the download came from a plausible URL.
#
# So there are two checks and they do different jobs:
#
#   - **The signature** proves the Swift project made this tarball. Verified
#     against the release signing key, whose fingerprint is pinned below.
#   - **The digest** proves it is the same tarball the code in this repository
#     was checked against. A signature alone would happily accept a different,
#     genuine, newer build with different behavior.
#
# Either failing stops the script. There is no flag to skip them.
#
# ## Why a tarball and not a package manager
#
# There is no apt repository for Swift on Ubuntu. The tarball from swift.org is
# the official channel, and `swiftly` is a downloader that would put a second
# unverified thing between here and there.
#
#   ./scripts/install-swift.sh
#   export PATH=/opt/swift/usr/bin:$PATH
#
# Roughly 840 MB down and 2 GB on disk. It takes a couple of minutes and it is
# a per-container cost: nothing here writes outside /opt/swift and a scratch
# directory.

set -euo pipefail

# ---------------------------------------------------------------------------
# What is pinned
#
# Bumping the version means bumping the digest, and the way to get the new one
# honestly is to let this script fail and read the digest out of the error,
# having satisfied yourself the signature passed first. The signature check
# happens before the digest check for exactly that reason.

VERSION="6.1.2"
PLATFORM="ubuntu24.04"
PLATFORM_PATH="ubuntu2404"
SHA256="d749d5fe2d6709ee988e96b16f02bca7b53304d09925e31063fd5ec56019de9f"

# The Swift 6.x release signing key, as swift.org publishes it. Spaces removed
# so it can be compared against gpg's output without reformatting either.
KEY_FINGERPRINT="52BB7E3DE28A71BE22EC05FFEF80A866B47A981F"

PREFIX="${SWIFT_PREFIX:-/opt/swift}"
NAME="swift-${VERSION}-RELEASE-${PLATFORM}"
BASE="https://download.swift.org/swift-${VERSION}-release/${PLATFORM_PATH}/swift-${VERSION}-RELEASE"

say() { printf '  %s\n' "$*"; }
die() { printf '\ninstall-swift: %s\n' "$*" >&2; exit 1; }

echo
echo "install-swift: Swift ${VERSION} for ${PLATFORM}"
echo

# ---------------------------------------------------------------------------
# Already here?

if [ -x "${PREFIX}/usr/bin/swift" ]; then
  have=$("${PREFIX}/usr/bin/swift" --version 2>/dev/null | head -1 || true)
  case "$have" in
    *"${VERSION}"*)
      say "already installed: ${have}"
      say "PATH: export PATH=${PREFIX}/usr/bin:\$PATH"
      echo
      exit 0
      ;;
    *)
      say "found a different toolchain (${have}), replacing it"
      ;;
  esac
fi

command -v curl >/dev/null || die "curl is needed to download the toolchain."
command -v gpg  >/dev/null || die "gpg is needed to verify the toolchain, and this script does not skip that."

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# ---------------------------------------------------------------------------
# Fetch

say "downloading ${NAME}.tar.gz"
curl -fsSL --retry 3 -o "${work}/toolchain.tar.gz" "${BASE}/${NAME}.tar.gz" \
  || die "the download failed."
say "downloading its signature"
curl -fsSL --retry 3 -o "${work}/toolchain.tar.gz.sig" "${BASE}/${NAME}.tar.gz.sig" \
  || die "the signature could not be fetched, so nothing can be verified."

# ---------------------------------------------------------------------------
# Verify, signature first
#
# Into a throwaway keyring rather than the caller's. Importing a signing key
# into somebody's real keyring as a side effect of a build script is a rude
# thing to do and makes the next verification harder to reason about.

export GNUPGHOME="${work}/gnupg"
mkdir -p "$GNUPGHOME"
chmod 700 "$GNUPGHOME"

say "fetching the Swift release keys"
curl -fsSL --retry 3 -o "${work}/keys.asc" https://swift.org/keys/all-keys.asc \
  || die "the Swift signing keys could not be fetched."
gpg --quiet --import "${work}/keys.asc" 2>/dev/null || die "those keys did not import."

say "checking the signature"
verify=$(gpg --status-fd 1 --verify "${work}/toolchain.tar.gz.sig" "${work}/toolchain.tar.gz" 2>/dev/null || true)
case "$verify" in
  *"GOODSIG"*) ;;
  *) die "the signature on that tarball is not good. Stopping." ;;
esac

# The fingerprint arrives on the VALIDSIG line, in a position that has moved
# between gpg versions, so it is matched anywhere in the status output rather
# than picked out by field number.
case "$verify" in
  *"${KEY_FINGERPRINT}"*) say "signed by ${KEY_FINGERPRINT}" ;;
  *) die "signed by a key this script does not pin. Expected ${KEY_FINGERPRINT}." ;;
esac

say "checking the digest"
actual=$(sha256sum "${work}/toolchain.tar.gz" | cut -d' ' -f1)
if [ "$actual" != "$SHA256" ]; then
  die "that is a genuine Swift build and not the one this repository pins.
             expected ${SHA256}
             got      ${actual}
             If you meant to move to a new toolchain, change both VERSION and
             SHA256 in this script in the same commit."
fi
say "digest matches"

# ---------------------------------------------------------------------------
# Install

say "unpacking into ${PREFIX}"
rm -rf "${PREFIX}"
mkdir -p "${PREFIX}"
tar xzf "${work}/toolchain.tar.gz" -C "${PREFIX}" --strip-components=1

"${PREFIX}/usr/bin/swift" --version >/dev/null 2>&1 || die "the unpacked toolchain does not run."

echo
say "$(${PREFIX}/usr/bin/swift --version 2>/dev/null | head -1)"
say "PATH: export PATH=${PREFIX}/usr/bin:\$PATH"
say "then: npm run swift:check"
echo
