#!/usr/bin/env bash
# Fluncle Lens Web Store screenshots — reproducible 1280×800 listing shots.
#
# The store wants 1280×800 (or 640×400) JPEG or 24-bit PNG, no alpha. This builds
# the extension, serves dist/ locally, and drives headless Chrome to capture three
# framed scenes (the popup over the cosmos, the on-page hover card, the privacy
# posture) straight from the extension's real CSS — so the shots can never drift
# from the product. Output: store-assets/screenshot-{1,2,3}.png (1280×800, no alpha).
#
# Requires Google Chrome and ImageMagick. Run from anywhere:
#   bash apps/extension/scripts/make-screenshots.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="$(dirname "$HERE")"
DIST="$EXT/dist"
OUT="$EXT/store-assets"
PORT=4731
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

mkdir -p "$OUT"

# Fresh build so the scene pages and CSS are current.
bun run "$HERE/build.ts"

# Stage the scene scaffolding into dist (gitignored) and the cover backdrop.
cp "$HERE/store-scene.html" "$DIST/_store.html"
cp "$HERE/store-scene.js" "$DIST/_store.js"
cp "$EXT/../web/public/fluncle-cover-no-text.png" "$DIST/_cover.png"

# Serve dist over http (Chrome won't load file:// fonts/CSS reliably for fonts).
python3 -m http.server "$PORT" --directory "$DIST" >/dev/null 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true; rm -f "$DIST/_store.html" "$DIST/_store.js" "$DIST/_cover.png"' EXIT
sleep 1

shoot() {
  local scene="$1" out="$2"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 --window-size=1280,800 \
    --screenshot="$out" "http://localhost:${PORT}/_store.html?scene=${scene}" \
    >/dev/null 2>&1
  # Headless at scale 2 yields 2560×1600; normalize to 1280×800, strip alpha (the
  # store rejects alpha on PNG), 24-bit.
  magick "$out" -resize 1280x800 -background "#090a0b" -alpha remove -alpha off \
    -strip PNG24:"$out"
}

shoot 1 "$OUT/screenshot-1.png"
shoot 2 "$OUT/screenshot-2.png"
shoot 3 "$OUT/screenshot-3.png"

echo "Screenshots → store-assets/screenshot-{1,2,3}.png (1280×800, 24-bit, no alpha)"
