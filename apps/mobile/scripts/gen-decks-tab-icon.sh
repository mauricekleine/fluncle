#!/usr/bin/env bash

set -euo pipefail
cd "$(dirname "$0")/.."
stardust="#b7ab95"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

magick -size 108x108 xc:none \
	-fill none -stroke "$stardust" -strokewidth 6.5 \
	-draw "translate 23,54 circle 0,0 0,16" \
	-draw "translate 85,54 circle 0,0 0,16" \
	-draw "roundrectangle 45,38 63,70 5,5" \
	-fill "$stardust" -stroke none \
	-draw "translate 23,54 circle 0,0 0,5.5" \
	-draw "translate 85,54 circle 0,0 0,5.5" \
	-draw "roundrectangle 50,50 58,58 2,2" \
	"$tmp/icon.png"

magick "$tmp/icon.png" -resize 28x28 assets/decks-tab-icon.png
magick "$tmp/icon.png" -resize 56x56 assets/decks-tab-icon@2x.png
magick "$tmp/icon.png" -resize 84x84 assets/decks-tab-icon@3x.png
echo "wrote assets/decks-tab-icon{,@2x,@3x}.png"
