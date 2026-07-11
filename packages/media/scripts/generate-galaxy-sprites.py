"""Generate the Galaxy frontier sprites via Gemini image-gen, then quantize each
to a per-sprite canon-ramp subset and key out the background.

The bespoke 8-bit sprites for Fluncle's Galaxy (apps/web/src/game/*). The
renderer falls back to procedural sprites until these PNGs land, so this is safe
to re-run / iterate, and the frames are taste-gated — view them before shipping.

Usage (reads the key from the environment only — never commit a key):

    GEMINI_API_KEY="$(op read 'op://<your-vault>/GEMINI_API_KEY/password')" \
      UV_CACHE_DIR=/tmp/uv-cache uv run --with pillow \
      python packages/media/scripts/generate-galaxy-sprites.py [roadster ufo asteroid]

Per-sprite palette subsets keep set-dressing OFF gold (One Sun Rule) and tell
each body's colour story. See docs/galaxy-sprites.md.
"""

import base64
import io
import json
import os
import sys
import urllib.request

from PIL import Image

API_KEY = os.environ["GEMINI_API_KEY"]
MODEL = "gemini-3.1-flash-image"
URL = f"https://generativelanguage.googleapis.com/v1/models/{MODEL}:generateContent"
# The SOURCE OF TRUTH for sprites — NOT `apps/web/public/galaxy`, which is a GENERATED mirror:
# `apps/web/scripts/copy-sprites.ts` overwrites it on every `dev` boot and pre-`build`, and
# .gitignore ignores the PNGs there. Writing to the mirror means your freshly-generated sprite
# is silently destroyed by the next build and never committed. Write to the package instead;
# the mirror is produced from it.
OUT = "packages/sprites/assets/galaxy"


def hexes(*hs):
    return [tuple(int(h[i : i + 2], 16) for i in (1, 3, 5)) for h in hs]


CREAMS = hexes("#fffbf2", "#f4ead7", "#b7ab95", "#6e6657")
BLACKS = hexes("#10100d", "#171611")
REDS = hexes("#ffa18f", "#ff6b57", "#b23c2e", "#7a2418")
COOL = hexes("#46527a", "#3a5f5c")

SPRITES = {
    "roadster": {
        "w": 30,
        "palette": REDS + CREAMS + BLACKS,
        "prompt": (
            "8-bit pixel art game sprite of a sleek convertible sports car (a derelict "
            "space roadster) seen from a high three-quarter rear angle, tumbling in deep "
            "space, chunky low-resolution NES-style pixels, glossy cherry-red and "
            "coral-red body (#ff6b57) with a small cream windshield and headlights and "
            "dark wheels, no driver, centered, fills most of the frame, on a solid flat "
            "pure magenta #FF00FF background, no gradient, no shadow, no text, no logos."
        ),
    },
    "ufo": {
        "w": 30,
        "palette": CREAMS + COOL + BLACKS,
        "prompt": (
            "8-bit pixel art game sprite of a classic flying saucer UFO seen from a slight "
            "low front angle, chunky low-resolution NES-style pixels, cream and off-white "
            "metallic dome and disc with a row of dim teal underglow lights along the rim, "
            "centered, on a solid flat pure magenta #FF00FF background, no gradient, no "
            "shadow, no text."
        ),
    },
    "asteroid": {
        "w": 26,
        "palette": CREAMS + BLACKS,
        "prompt": (
            "8-bit pixel art game sprite of a single lumpy irregular space asteroid rock, "
            "chunky low-resolution NES-style pixels, cream and warm grey dusty tones with "
            "darker crater shadows and a few lighter chips, no other objects, centered, "
            "fills most of the frame, on a solid flat pure magenta #FF00FF background, no "
            "gradient, no shadow, no text."
        ),
    },
}


def generate(prompt):
    body = json.dumps({"contents": [{"parts": [{"text": prompt}]}]}).encode()
    req = urllib.request.Request(
        URL,
        data=body,
        headers={"Content-Type": "application/json", "x-goog-api-key": API_KEY},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        print("API error body:", e.read().decode()[:600], file=sys.stderr)
        raise
    for cand in data.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                return base64.b64decode(inline["data"])
    raise RuntimeError("no image part in response: " + json.dumps(data)[:400])


def is_bg(px):
    r, g, b = px[0], px[1], px[2]
    return r > 150 and b > 120 and g < 110  # magenta-ish


def nearest(px, palette):
    r, g, b = px
    return min(palette, key=lambda c: (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2)


def process(raw, target_w, palette):
    img = Image.open(io.BytesIO(raw)).convert("RGBA")
    px = img.load()
    w, h = img.size
    minx, miny, maxx, maxy = w, h, 0, 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if is_bg((r, g, b)):
                px[x, y] = (0, 0, 0, 0)
            else:
                minx, miny, maxx, maxy = min(minx, x), min(miny, y), max(maxx, x), max(maxy, y)
    if maxx <= minx:
        raise RuntimeError("keyed image is empty (background not magenta?)")
    img = img.crop((minx, miny, maxx + 1, maxy + 1))
    scale = target_w / img.width
    img = img.resize((target_w, max(1, round(img.height * scale))), Image.LANCZOS)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    sp, op = img.load(), out.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = sp[x, y]
            if a < 110:
                continue
            qr, qg, qb = nearest((r, g, b), palette)
            op[x, y] = (qr, qg, qb, 255)
    return out


def main():
    for name in sys.argv[1:] or list(SPRITES):
        spec = SPRITES[name]
        print(f"generating {name}…", flush=True)
        img = process(generate(spec["prompt"]), spec["w"], spec["palette"])
        img.save(f"{OUT}/{name}.png")
        print(f"  wrote {OUT}/{name}.png {img.size}", flush=True)


if __name__ == "__main__":
    main()
