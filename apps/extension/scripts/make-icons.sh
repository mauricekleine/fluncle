#!/usr/bin/env bash

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="$(dirname "$HERE")"

WEB_PUBLIC="$(cd "$EXT/../web/public" && pwd)"
VARIANTS="$EXT/icons-variants"
ICONS="$EXT/icons"

COSMONAUT="$WEB_PUBLIC/fluncle-transparant.png"
COVER="$WEB_PUBLIC/fluncle-cover-no-text.png"

DEEP_FIELD="#090a0b"

DEFAULT="${1:-a}"

mkdir -p "$VARIANTS" "$ICONS"

build_a() {
	magick "$COSMONAUT" -trim +repage \
		-resize 104x104 -background none -gravity center -extent 120x120 \
		"$VARIANTS/_fig.png"

	magick -size 128x128 xc:none \
		-fill "$DEEP_FIELD" -draw "circle 64,64 64,4" \
		\( -size 128x128 xc:none -fill none -stroke "#f5b80077" -strokewidth 2 \
		-draw "circle 64,64 64,7" \) -compose over -composite \
		"$VARIANTS/_disc.png"

	magick "$VARIANTS/_disc.png" "$VARIANTS/_fig.png" -gravity center -compose over -composite \
		PNG32:"$VARIANTS/icon128-a.png"

	rm -f "$VARIANTS/_fig.png" "$VARIANTS/_disc.png"
}

build_b() {
	magick -size 96x96 xc:black -fill white -draw "circle 48,48 48,4" -alpha off \
		"$VARIANTS/_mask.png"
	magick "$COVER" -crop 620x620+560+40 +repage -resize 96x96 PNG32:"$VARIANTS/_crop.png"
	magick "$VARIANTS/_crop.png" "$VARIANTS/_mask.png" -alpha off -compose CopyOpacity -composite -compose over \
		-background none -gravity center -extent 128x128 PNG32:"$VARIANTS/icon128-b.png"
	rm -f "$VARIANTS/_mask.png" "$VARIANTS/_crop.png"
}

build_c() {
	magick -size 96x96 xc:black -fill white -draw "roundrectangle 0,0 95,95 18,18" -alpha off \
		"$VARIANTS/_mask.png"
	magick "$COVER" -crop 620x620+560+40 +repage -resize 96x96 PNG32:"$VARIANTS/_crop.png"
	magick "$VARIANTS/_crop.png" "$VARIANTS/_mask.png" -alpha off -compose CopyOpacity -composite -compose over \
		-background none -gravity center -extent 128x128 PNG32:"$VARIANTS/icon128-c.png"
	rm -f "$VARIANTS/_mask.png" "$VARIANTS/_crop.png"
}

build_a
build_b
build_c

echo "Variants → icons-variants/icon128-{a,b,c}.png"

CHOSEN="$VARIANTS/icon128-$DEFAULT.png"
if [[ ! -f "$CHOSEN" ]]; then
	echo "Unknown variant '$DEFAULT' (expected a|b|c)" >&2
	exit 1
fi

cp "$CHOSEN" "$ICONS/icon128.png"
for size in 48 32 16; do
	pad=$((size / 8))
	art=$((size - 2 * pad))
	magick "$CHOSEN" -trim +repage -resize "${art}x${art}" \
		-background none -gravity center -extent "${size}x${size}" \
		PNG32:"$ICONS/icon${size}.png"
done

echo "Wired set (variant $DEFAULT) → icons/icon{16,32,48,128}.png"
