#!/usr/bin/env bash
# Regenerate the Mix tab bar icon — a full Eclipse Gold disc (#f5b800, One Sun) with a
# "merge two strands into one, flowing down" arrow KNOCKED OUT (transparent, so the tab
# bar shows through: the Instagram-style prominent centre item). It is drawn original-
# colour and wired renderingMode="original" in app/(tabs)/_layout.tsx, so it stays gold
# whether the tab is selected or not.
#
# The glyph is drawn with ImageMagick primitives rather than an SVG on purpose: magick's
# internal MSVG renderer silently drops stroked <path> elements, so a stroked-SVG source
# rasterises empty. A native tab icon is a bitmap; iOS reads its point size from the @Nx
# scale suffixes (Metro resolves all three off one require()), so ~28pt = 28/56/84 px.
# Master is drawn at 108px and downscaled for clean antialiasing. Requires ImageMagick.
set -euo pipefail
cd "$(dirname "$0")/.."
gold="#f5b800"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# The merge-arrow glyph (black = the knockout shape), on a 108 canvas.
magick -size 108x108 xc:none -fill none -stroke "#000000" -strokewidth 10.5 \
  -draw "stroke-linecap round stroke-linejoin round line 33,35 54,57 line 75,35 54,57 line 54,53 54,75 polyline 45,66 54,76 63,66" \
  "$tmp/glyph.png"
# The gold disc, and the disc with the glyph punched out (DstOut).
magick -size 108x108 xc:none -fill "$gold" -draw "translate 54,54 circle 0,0 0,50" "$tmp/disc.png"
magick "$tmp/disc.png" "$tmp/glyph.png" -compose DstOut -composite "$tmp/icon.png"

magick "$tmp/icon.png" -resize 28x28 assets/mix-tab-icon.png
magick "$tmp/icon.png" -resize 56x56 assets/mix-tab-icon@2x.png
magick "$tmp/icon.png" -resize 84x84 assets/mix-tab-icon@3x.png
echo "wrote assets/mix-tab-icon{,@2x,@3x}.png"
