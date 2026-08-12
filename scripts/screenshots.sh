#!/usr/bin/env bash
#
# Walk the App Store shot list on a booted Simulator, one screen at a time.
#
# You drive the app; this drives the camera. It prints what to navigate to,
# waits for Enter, captures, checks the result is a size App Store Connect
# will actually accept, and writes it where `fastlane deliver` looks for it.
#
#   ./scripts/screenshots.sh              # the vault, 6.9-inch
#   ./scripts/screenshots.sh --retake 3   # just shot 3, after you fix it
#   ./scripts/screenshots.sh --list       # print the shot list and stop
#
# ## Why a script rather than six ⌘S presses
#
# Not the capturing, which is easy. The two things that go wrong later:
#
#   - **Size.** App Store Connect rejects a screenshot whose pixel dimensions
#     are not exactly one of the accepted sets, and it tells you at upload,
#     after you have taken all six and closed the Simulator. A 6.9-inch shot
#     from a 6.1-inch device looks completely normal until then. This checks
#     each capture as it is taken.
#   - **Order.** `deliver` uploads screenshots in filename order, which is the
#     order a person sees them on the store page. Six files named after what
#     is in them sort alphabetically into nonsense. They are numbered here.
#
# It deliberately does not automate the navigation. Driving the app would mean
# a UI test target, coordinates that rot at the next layout change, and a
# maintenance burden for something done once a release. Six Enters is cheaper.

set -euo pipefail

DEVICE_CLASS="APP_IPHONE_69"
OUT="fastlane/vault/screenshots/en-US"

# Sizes App Store Connect accepts for the 6.9-inch class, portrait. The 6.5
# and 6.7-inch sets are accepted for that class too on current devices, but a
# mismatch between what you *meant* to shoot and what you shot is the failure
# this catches, so the script names what it found rather than guessing.
ACCEPTED="1320x2868 1290x2796"

# The shot list from docs/shipping.md. Each entry is `label|instruction`.
SHOTS=(
  "launch-self-test|Force-quit and relaunch the app. Capture the launch screen while the self-test is running or just after it passes."
  "home|Unlock into the home screen. This is the one a person sees most, so it is the one the store page leads with."
  "demo-review|SIGN tab, then WALK A DEMO TRANSACTION. Stop on the READ BEFORE SIGNING screen with the DEMO badge and the destination visible."
  "demo-approve|Scroll the review to the bottom so the lever arms, continue, and capture the approve screen."
  "signed-qr|Complete the hold-to-sign. Capture the animating signed-transaction QR."
  "airgap|Settings, then the airgap diagnostic. It states the build's half of the claim and hands the radios to the person, which is the honest screen and worth showing."
)

usage() { sed -n '3,20p' "$0" | sed 's|^# \{0,1\}||'; exit 0; }

RETAKE=""
for arg in "$@"; do
  case "$arg" in
    --list)
      for i in "${!SHOTS[@]}"; do
        printf '%d. %s\n   %s\n' "$((i + 1))" "${SHOTS[$i]%%|*}" "${SHOTS[$i]#*|}"
      done
      exit 0
      ;;
    --retake) RETAKE="next" ;;
    --help|-h) usage ;;
    *)
      if [ "$RETAKE" = "next" ]; then RETAKE="$arg"; else
        echo "unknown argument: $arg" >&2; exit 2
      fi
      ;;
  esac
done

command -v xcrun >/dev/null || { echo "xcrun is missing; this needs a Mac with Xcode." >&2; exit 1; }

booted=$(xcrun simctl list devices booted | grep -E '\(Booted\)' | head -1 || true)
if [ -z "$booted" ]; then
  echo "No Simulator is booted. Open one and run the vault first." >&2
  exit 1
fi
echo "Simulator: $(echo "$booted" | sed 's/^ *//')"

case "$booted" in
  *"Pro Max"*|*"Plus"*) ;;
  *)
    # Not fatal: the size check below is the real gate, and somebody may be
    # deliberately shooting a second class. But say it now rather than after
    # six captures.
    echo
    echo "WARNING: this does not look like a Pro Max or Plus device, and the"
    echo "6.9-inch class is the one App Store Connect requires. Screenshots"
    echo "from a smaller device will be rejected at upload."
    echo
    ;;
esac

mkdir -p "$OUT"

# `sips` ships with macOS, so there is no dependency to install for this.
dimensions() { sips -g pixelWidth -g pixelHeight "$1" | awk '/pixel/ {printf "%s", $2 "x"}' | sed 's/x$//' | awk -F'x' '{print $2 "x" $1}'; }

capture() {
  local index="$1" label="$2" instruction="$3"
  local path
  path=$(printf '%s/%02d-%s.png' "$OUT" "$index" "$label")

  echo
  echo "────────────────────────────────────────────────────────────"
  printf 'Shot %d of %d: %s\n\n' "$index" "${#SHOTS[@]}" "$label"
  echo "$instruction" | fold -s -w 60
  echo
  read -r -p "Enter to capture, s to skip: " answer
  if [ "$answer" = "s" ]; then
    echo "skipped"
    return 0
  fi

  xcrun simctl io booted screenshot --type=png "$path" >/dev/null 2>&1

  local size
  size=$(dimensions "$path")
  if echo "$ACCEPTED" | grep -qw "$size"; then
    echo "  saved $path  ($size)"
  else
    echo
    echo "  REJECTED: $path is ${size}."
    echo "  App Store Connect accepts one of: $ACCEPTED"
    echo "  The capture was kept so you can look at it, but it will not upload."
    echo "  Boot a 6.9-inch device (iPhone 17 Pro Max or 16 Pro Max) and retake."
    echo
    return 1
  fi
}

failed=0
for i in "${!SHOTS[@]}"; do
  index=$((i + 1))
  [ -n "$RETAKE" ] && [ "$RETAKE" != "$index" ] && continue
  label="${SHOTS[$i]%%|*}"
  instruction="${SHOTS[$i]#*|}"
  capture "$index" "$label" "$instruction" || failed=$((failed + 1))
done

echo
echo "────────────────────────────────────────────────────────────"
ls -1 "$OUT" 2>/dev/null | sed 's/^/  /'
echo
if [ "$failed" -gt 0 ]; then
  echo "$failed shot(s) are the wrong size. Retake with: $0 --retake N"
  exit 1
fi
echo "Shot list complete. Upload with:  fastlane deliver --app_identifier vision.labyrinth.vault"
echo "Device class for these: $DEVICE_CLASS"
