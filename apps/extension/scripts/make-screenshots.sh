#!/usr/bin/env bash

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="$(dirname "$HERE")"
DIST="$EXT/dist"
OUT="$EXT/store-assets"
PORT=4731
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

mkdir -p "$OUT"

bun run "$HERE/build.ts"

cp "$HERE/store-scene.html" "$DIST/_store.html"
cp "$HERE/store-scene.js" "$DIST/_store.js"
cp "$EXT/../web/public/fluncle-cover-no-text.png" "$DIST/_cover.png"

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

	magick "$out" -resize 1280x800 -background "#090a0b" -alpha remove -alpha off \
		-strip PNG24:"$out"
}

shoot 1 "$OUT/screenshot-1.png"
shoot 2 "$OUT/screenshot-2.png"
shoot 3 "$OUT/screenshot-3.png"

echo "Screenshots → store-assets/screenshot-{1,2,3}.png (1280×800, 24-bit, no alpha)"
