#!/usr/bin/env bash
#
# Everything a compiler can say about the Swift, without Xcode.
#
# Two tiers, because Swift here is two different things.
#
#   1. The platform-free model — the transaction shapes, the refusal model, the
#      passphrase encoding. These import Foundation and nothing else, so they
#      are a real SwiftPM target that really builds and whose tests really run,
#      on Linux or macOS. That is `swift build` and `swift test`.
#
#   2. Everything that imports SwiftUI, JavaScriptCore, CryptoKit or CoreImage.
#      Those frameworks are Apple's and exist nowhere else, so off a Mac the
#      most any tool can do is parse them: syntax, balanced braces, well-formed
#      declarations. Not types, not exhaustiveness, not whether a call exists.
#      This script says "parsed" rather than "checked" for exactly that reason.
#
# The distinction is the point. Before tier 1 existed, `Refusal.detail` was a
# non-exhaustive switch missing five of its nine cases — a compile error that
# nothing in this repository could see, because nothing in this repository
# compiled Swift. Tier 2 would not have caught it either. Moving a file from
# tier 2 to tier 1 is how it becomes genuinely checked, and the way to do that
# is to give it no Apple imports.
#
#   ./scripts/swift-check.sh
#
# Exits 0 and says so if there is no Swift toolchain: this runs inside
# `npm test`, and a missing optional toolchain should not read like a failure.
# It is not silent about it either — a skipped check that looks like a passing
# one is worse than no check.

set -euo pipefail
cd "$(dirname "$0")/.."

# A toolchain put here by scripts/install-swift.sh is on nobody's PATH. Finding
# it anyway is the difference between a check that runs and a check that runs
# when somebody remembers to export something first.
if ! command -v swift >/dev/null 2>&1 && [ -x "${SWIFT_PREFIX:-/opt/swift}/usr/bin/swift" ]; then
  PATH="${SWIFT_PREFIX:-/opt/swift}/usr/bin:$PATH"
  export PATH
fi

if ! command -v swift >/dev/null 2>&1; then
  echo "swift-check: no Swift toolchain on PATH, so this is being skipped."
  echo "             ./scripts/install-swift.sh puts one in place, checked"
  echo "             against the Swift project's signature and a pinned digest."
  echo "             (Everything else in the suite still ran.)"
  exit 0
fi

echo "swift-check: $(swift --version 2>&1 | head -1)"

# ---------------------------------------------------------------------------
# Tier 1: real compilation, real tests.

echo
echo "  [1/3] building the platform-free model"
swift build 2>&1 | sed 's/^/        /'

echo "  [2/3] running its tests"
swift test 2>&1 | grep -E "Executed|error:|failed" | sed 's/^/        /'

# ---------------------------------------------------------------------------
# Tier 2: parse-only over the Apple-only sources.

echo "  [3/3] parsing the sources only Xcode can build"

apple_only=()
while IFS= read -r file; do
  # The tier-1 files are compiled above; parsing them again proves nothing.
  if grep -qE '^import (SwiftUI|Combine|JavaScriptCore|CryptoKit|CoreImage|UIKit|Security)' "$file"; then
    apple_only+=("$file")
  fi
done < <(find ios -name '*.swift' | sort)

if [ ${#apple_only[@]} -eq 0 ]; then
  echo "        found nothing to parse, which means this check stopped working"
  exit 1
fi

failed=0
for file in "${apple_only[@]}"; do
  if ! output=$(swiftc -parse "$file" 2>&1); then
    echo "        FAILED $file"
    echo "$output" | sed 's/^/          /'
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo
  echo "swift-check: parse errors above."
  exit 1
fi

echo "        parsed ${#apple_only[@]} files (syntax only, so Xcode still has to type-check them)"
echo
echo "swift-check: model compiled and tested; the rest parsed."
