#!/usr/bin/env bash
# Fluncle's Helm — THE SHIM BUILD. Mac-only, on demand. Compiles the one Swift
# file (swiftc -O), assembles "Fluncle's Helm.app" under dist/ with its Info.plist
# and a composed .icns (the falling-figure mark on a Deep Field tile), and ad-hoc
# codesigns it. CI never runs this — ubuntu runners have no swiftc — and it is not
# a turbo task, so it stays out of the deploy gate. Re-runnable.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

APP_NAME="Fluncle's Helm"
EXE_NAME="FluncleHelmShim"
DIST="$HERE/dist"
APP="$DIST/$APP_NAME.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

FIGURE="$REPO_ROOT/apps/web/public/fluncle-transparant.png" # the cutout
STARFIELD="$REPO_ROOT/apps/web/public/fluncle.png"          # the figure on stars
DEEP_FIELD="#090a0b"
ECLIPSE_GOLD="#f5b800"

echo "helm-shim: cleaning $APP"
rm -rf "$APP"
mkdir -p "$MACOS" "$RESOURCES"

echo "helm-shim: compiling main.swift (swiftc -O)"
swiftc -O \
  -framework AppKit -framework WebKit \
  -o "$MACOS/$EXE_NAME" \
  "$HERE/main.swift"

echo "helm-shim: Info.plist"
cp "$HERE/Info.plist" "$CONTENTS/Info.plist"

# --- The icon -------------------------------------------------------------------
# Compose the falling figure prominent on a Deep Field rounded tile (macOS grid:
# an 824-body with 100px margins on a 1024 canvas), a whisper of the real
# starfield behind it, and one faint Eclipse-Gold bloom (One Sun Rule — gold as
# light, not paint). ImageMagick does the composite; sips + iconutil do the icns.
# No ImageMagick? Fall back to the starfield avatar squared into the iconset.
echo "helm-shim: composing AppIcon.icns"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET"
MASTER="$TMP/icon_1024.png"

if command -v magick >/dev/null 2>&1; then
  BODY=824
  RADIUS=180
  # Deep Field ground.
  magick -size ${BODY}x${BODY} "xc:$DEEP_FIELD" "$TMP/body.png"
  # A sparse, procedural starfield screened over it — real points of light, no
  # ghost of the source figure, no tiling seam.
  magick -size ${BODY}x${BODY} xc:black -seed 11 +noise Random -colorspace Gray \
    -threshold 99.4% -blur 0x0.5 -evaluate multiply 0.7 "$TMP/stars.png"
  magick "$TMP/body.png" "$TMP/stars.png" -compose screen -composite "$TMP/ground.png"
  # ONE faint gold bloom behind the figure — a small, dim, blurred core screened
  # in as light, never a field (DESIGN.md One Sun Rule: gold is light, not paint).
  magick -size 460x460 radial-gradient:"#2c2000"-"#000000" -blur 0x40 "$TMP/glowcore.png"
  magick -size ${BODY}x${BODY} xc:black "$TMP/glowcore.png" -gravity center -geometry +0+40 \
    -compose over -composite "$TMP/glow.png"
  magick "$TMP/ground.png" "$TMP/glow.png" -compose screen -composite "$TMP/lit.png"
  # The falling figure, prominent and centered (a touch low).
  magick "$FIGURE" -resize 600x600 "$TMP/figure.png"
  magick "$TMP/lit.png" "$TMP/figure.png" -gravity center -geometry +0+20 -compose over -composite "$TMP/composed.png"
  # Round to the macOS tile, then seat it on the 1024 canvas with the grid margin.
  magick -size ${BODY}x${BODY} xc:none -draw "roundrectangle 0,0,$((BODY-1)),$((BODY-1)),$RADIUS,$RADIUS" "$TMP/mask.png"
  magick "$TMP/composed.png" "$TMP/mask.png" -alpha set -compose DstIn -composite "$TMP/rounded.png"
  magick -size 1024x1024 xc:none "$TMP/rounded.png" -gravity center -compose over -composite "$MASTER"
else
  echo "helm-shim: no ImageMagick — falling back to the starfield avatar (squared)"
  sips -z 1024 1024 "$STARFIELD" --out "$MASTER" >/dev/null
fi

# The ten iconset renditions, straight off the master.
while read -r sz name; do
  sips -z "$sz" "$sz" "$MASTER" --out "$ICONSET/$name.png" >/dev/null
done <<'SIZES'
16 icon_16x16
32 icon_16x16@2x
32 icon_32x32
64 icon_32x32@2x
128 icon_128x128
256 icon_128x128@2x
256 icon_256x256
512 icon_256x256@2x
512 icon_512x512
1024 icon_512x512@2x
SIZES

iconutil -c icns "$ICONSET" -o "$RESOURCES/AppIcon.icns"

# --- Sign -----------------------------------------------------------------------
echo "helm-shim: ad-hoc codesign"
codesign --force --sign - "$APP"

echo
echo "helm-shim: built $APP"
echo "Install it (not run for you):"
echo "  cp -R \"$APP\" /Applications/"
