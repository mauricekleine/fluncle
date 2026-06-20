#!/usr/bin/env bash
# Fluncle Lens icon generator — reproducible store + in-extension icons.
#
# Chrome Web Store guidance: the 128×128 store icon is 96×96 of art centered in
# 16px of transparent padding on every side, no hard edge, legible on light AND
# dark store chrome, delivered as PNG. We render three candidate 128s for Maurice
# to choose between, then fan the chosen one out to the 16/32/48/128 set the
# manifest loads.
#
# Requires ImageMagick (`magick`). Run from anywhere:
#   bash apps/extension/scripts/make-icons.sh [a|b|c]
#
# Outputs:
#   icons-variants/   the three 128×128 candidates (a/b/c) for review
#   icons/            the wired set (16/32/48/128), built from the chosen variant
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="$(dirname "$HERE")"
# The canonical brand art lives in the web app's public dir — read it there rather
# than duplicating the (multi-MB) cover into the extension.
WEB_PUBLIC="$(cd "$EXT/../web/public" && pwd)"
VARIANTS="$EXT/icons-variants"
ICONS="$EXT/icons"

COSMONAUT="$WEB_PUBLIC/fluncle-transparant.png"   # the floating uncle, on transparency
COVER="$WEB_PUBLIC/fluncle-cover-no-text.png"     # the full Nostalgic Cosmos cover (no text)

# The deep-field ground, so a variant reads on a light store background too.
DEEP_FIELD="#090a0b"

# Which variant the manifest ships by default until Maurice picks. a|b|c.
DEFAULT="${1:-a}"

mkdir -p "$VARIANTS" "$ICONS"

# ── Variant A: the cosmonaut mark, gold deep-field disc ───────────────────────
# The transparent cosmonaut, trimmed and centered on a circular deep-field disc
# with a faint gold rim — the floating-uncle brand mark as a clean coin. The
# 96px-art / 16px-padding rule is for SQUARE icons; a circular coin's corners are
# transparent anyway, so it runs nearly edge to edge — the disc is ~120px with a
# small safety margin, the figure scaled to fill it.
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

# ── Variant B: circular crop of the cover mark ────────────────────────────────
# A circular porthole onto the cover's cosmonaut + eclipse corner — the full
# Nostalgic Cosmos scene, masked to a 96px coin, 16px transparent padding.
build_b() {
  magick -size 96x96 xc:black -fill white -draw "circle 48,48 48,4" -alpha off \
    "$VARIANTS/_mask.png"
  magick "$COVER" -crop 620x620+560+40 +repage -resize 96x96 PNG32:"$VARIANTS/_crop.png"
  magick "$VARIANTS/_crop.png" "$VARIANTS/_mask.png" -alpha off -compose CopyOpacity -composite -compose over \
    -background none -gravity center -extent 128x128 PNG32:"$VARIANTS/icon128-b.png"
  rm -f "$VARIANTS/_mask.png" "$VARIANTS/_crop.png"
}

# ── Variant C: rounded-square crop of the cover mark ──────────────────────────
# The same cover window, masked to a rounded square (radius 18) — the "album
# tile" read, 96px art inside 16px padding.
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

# ── Fan the chosen variant out to the manifest icon set ───────────────────────
CHOSEN="$VARIANTS/icon128-$DEFAULT.png"
if [[ ! -f "$CHOSEN" ]]; then
  echo "Unknown variant '$DEFAULT' (expected a|b|c)" >&2
  exit 1
fi

cp "$CHOSEN" "$ICONS/icon128.png"
for size in 48 32 16; do
  pad=$(( size / 8 ))            # the 16/128 padding ratio, kept proportional
  art=$(( size - 2 * pad ))
  magick "$CHOSEN" -trim +repage -resize "${art}x${art}" \
    -background none -gravity center -extent "${size}x${size}" \
    PNG32:"$ICONS/icon${size}.png"
done

echo "Wired set (variant $DEFAULT) → icons/icon{16,32,48,128}.png"
