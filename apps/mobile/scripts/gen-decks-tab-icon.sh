#!/usr/bin/env bash
# Regenerate the Decks tab bar icon — a DJ rig in Phosphor's grammar: two turntable
# platters (circle + spindle dot, Phosphor's vinyl-record doubled) flanking the mixer (a
# rounded rect with its fader knob). Wired WITHOUT renderingMode="original", so the iOS
# tab bar template-tints it exactly like its four SF-symbol siblings (stardust idle, gold
# selected) — the 2026-07-13 ruling after the always-gold disc experiment: every trigger
# obeys the bar's tint; the centre SLOT is the prominence. The glyph is drawn in Stardust
# rather than black: iOS templates purely by the alpha channel (the colour is ignored),
# while Android renders src images in their ORIGINAL colours — black would vanish on the
# dark bar, Stardust reads as the idle tint.
#
# The glyph is drawn with ImageMagick primitives rather than an SVG on purpose: magick's
# internal MSVG renderer silently drops stroked <path> elements, so a stroked-SVG source
# rasterises empty. A native tab icon is a bitmap; iOS reads its point size from the @Nx
# scale suffixes (Metro resolves all three off one require()), so ~28pt = 28/56/84 px —
# the labelled-item size. Master is drawn at 108px and downscaled for clean antialiasing.
# Requires ImageMagick.
set -euo pipefail
cd "$(dirname "$0")/.."
stardust="#b7ab95"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Two platters + spindle dots flanking the mixer + its knob (stroke ≈ the SF regular
# weight at tab size). The mixer is what makes it read "decks" and not a pair of eyes.
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
