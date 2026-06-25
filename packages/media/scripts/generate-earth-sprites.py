"""Generate the Earth overworld prop sprites via Gemini image-gen, then quantize
each to a per-prop canon-ramp subset and key out the background.

The bespoke 8-bit device sprites for Fluncle's Earth overworld (the doors into
each surface). The renderer falls back to the procedural char-grid sprites until
these PNGs land (apps/web/src/game/earth/*), so this is safe to re-run / iterate,
and the frames are taste-gated — view them in /earth before shipping. PNG file
name == the prop id (the renderer loads /earth/<propId>.png).

Usage (reads the key from the environment only — never commit a key):

    GEMINI_API_KEY="$(op read 'op://Fluncle/GEMINI_API_KEY/credential')" \
      UV_CACHE_DIR=/tmp/uv-cache uv run --with pillow \
      python packages/media/scripts/generate-earth-sprites.py [crt boombox ...]

Per-prop palette subsets keep gold confined to the door/accent (One Sun Rule,
≤~10% of a sprite) and tell each object's colour story. Canon ramp only; no
green field (the CRT/terminal/onion sprout use the dim canon teal). See
docs/galaxy-sprites.md + docs/earth-overworld.md.
"""

import base64
import io
import json
import os
import sys
import urllib.error
import urllib.request

from PIL import Image

API_KEY = os.environ["GEMINI_API_KEY"]
MODEL = "gemini-3.1-flash-image"
URL = f"https://generativelanguage.googleapis.com/v1/models/{MODEL}:generateContent"
OUT = "apps/web/public/earth"


def hexes(*hs):
    return [tuple(int(h[i : i + 2], 16) for i in (1, 3, 5)) for h in hs]


CREAMS = hexes("#fffbf2", "#f4ead7", "#b7ab95", "#6e6657")
BLACKS = hexes("#090a0b", "#10100d", "#171611")
GOLDS = hexes("#ffd057", "#f5b800", "#b88a00", "#7a5c00")
GOLD1 = hexes("#f5b800")
REDS = hexes("#ffa18f", "#ff6b57", "#b23c2e", "#7a2418")
COOL = hexes("#46527a", "#3a5f5c")
TEAL = hexes("#3a5f5c")

# Shared prompt scaffolding — top-down-ish device on a magenta key, no text.
TAIL = (
    ", chunky low-resolution NES-style pixels, centered, fills most of the frame, "
    "on a solid flat pure magenta #FF00FF background, no gradient, no shadow, no "
    "text, no logos, no UI."
)


def p(subject):
    return "8-bit pixel art game sprite of " + subject + TAIL


SPRITES = {
    # ── Workshop ─────────────────────────────────────────────────────────────
    "crt": {
        "w": 18,
        "palette": CREAMS + BLACKS + TEAL + GOLD1,
        "prompt": p(
            "a chunky retro CRT computer monitor on a small stand, cream and warm-grey "
            "plastic casing, a dim dark-teal phosphor screen with faint scanlines, a tiny "
            "gold power light"
        ),
    },
    "boombox": {
        "w": 22,
        "palette": CREAMS + BLACKS + GOLDS + REDS,
        "prompt": p(
            "a wide 1980s cassette boombox, cream and warm-grey body, two round speaker "
            "grilles with thin gold rims, a central cassette window with a small red tape "
            "line, a dark carry handle, gold used only on the speaker rims"
        ),
    },
    "floppy": {
        "w": 16,
        "palette": CREAMS + BLACKS + GOLD1,
        "prompt": p(
            "a single 3.5 inch floppy disk seen face-on, dark warm-black plastic shell, a "
            "cream paper label across the top with one thin gold stripe, a metal shutter"
        ),
    },
    "turntable": {
        "w": 22,
        "palette": CREAMS + BLACKS + GOLDS,
        "prompt": p(
            "a DJ turntable seen from a high angle, dark warm-black deck body, a cream "
            "platter with a center spindle, a thin gold tonearm reaching across, two small "
            "control knobs, gold only on the tonearm"
        ),
    },
    "radio": {
        "w": 18,
        "palette": CREAMS + BLACKS + GOLDS,
        "prompt": p(
            "a small vintage table radio, cream and warm-wood body, a round gold tuning "
            "dial, a cream speaker grille, a thin antenna, gold only on the dial"
        ),
    },
    # ── Edge ─────────────────────────────────────────────────────────────────
    "edge_onion": {
        "w": 18,
        "palette": CREAMS + BLACKS + TEAL + REDS,
        "prompt": p(
            "a single papery onion bulb, warm cream and tan layered skin with thin curved "
            "seam lines, two slim dark-teal green sprout shoots at the top, a few thin "
            "red-brown root hairs at the bottom, no gold"
        ),
    },
    "edge_switchboard": {
        "w": 20,
        "palette": CREAMS + BLACKS + GOLDS,
        "prompt": p(
            "a vintage telephone switchboard cabinet, dark warm-black casing, rows of small "
            "cream patch sockets, a few thin gold patch cables hanging, a round rotary dial, "
            "gold only on the cables"
        ),
    },
    "edge_fusebox": {
        "w": 18,
        "palette": CREAMS + BLACKS + TEAL + GOLD1,
        "prompt": p(
            "a small server rack / fuse box, dark warm-black chassis, stacked panels with a "
            "row of tiny dim-teal blinking status lights and one small gold power light, a "
            "cream ventilation grille"
        ),
    },
    "edge_terminal": {
        "w": 18,
        "palette": CREAMS + BLACKS + TEAL,
        "prompt": p(
            "a small boxy retro computer terminal / friendly robot head, dark warm-black "
            "chassis, a cream face screen with a faint dim-teal scanline grid, two short "
            "antenna prongs on top, a cream keypad below"
        ),
    },
    # ── Landing ──────────────────────────────────────────────────────────────
    "landing_logbook": {
        "w": 18,
        "palette": CREAMS + BLACKS + GOLD1,
        "prompt": p(
            "a thick recovered logbook / leather journal lying slightly open, dark warm "
            "cover boards, cream pages, one thin gold spine stripe, gold only on the spine"
        ),
    },
    "landing_monolith": {
        "w": 16,
        "palette": CREAMS + BLACKS + COOL,
        "prompt": p(
            "an upright standing-stone monolith slab, dark warm-stone surface with a faint "
            "cool-blue cover-art glint down the face, cream highlights along one edge"
        ),
    },
    "landing_board": {
        "w": 18,
        "palette": CREAMS + BLACKS,
        "prompt": p(
            "a small wooden notice board on two posts, dark warm-wood frame, a cream paper "
            "notice pinned to it"
        ),
    },
    "landing_nokia": {
        "w": 13,
        "palette": CREAMS + BLACKS + TEAL,
        "prompt": p(
            "a single chunky 1990s brick mobile phone (Nokia style) standing upright in "
            "tall portrait orientation, clearly taller than it is wide, one phone only, "
            "cream and warm-grey body, a small dim-teal rectangular screen near the top, a "
            "simple grid keypad below, a short antenna nub on top"
        ),
    },
    "landing_lens": {
        "w": 16,
        "palette": CREAMS + BLACKS + COOL,
        "prompt": p(
            "a round magnifying glass standing on a small stand, cream and warm-grey handle "
            "and rim, a faint cool-blue glass lens"
        ),
    },
    # ── Comms ────────────────────────────────────────────────────────────────
    "comms_mailbox": {
        "w": 16,
        "palette": CREAMS + BLACKS + REDS,
        "prompt": p(
            "a classic mailbox on a post, cream and warm-grey body, a small red flag raised "
            "on the side, red only on the flag"
        ),
    },
    "comms_pager": {
        "w": 14,
        "palette": CREAMS + BLACKS + TEAL,
        "prompt": p(
            "a small handheld pager / CB radio with a belt clip, cream and warm-grey body, a "
            "small dim-teal screen, a short antenna"
        ),
    },
    "comms_camcorder": {
        "w": 18,
        "palette": CREAMS + BLACKS + REDS,
        "prompt": p(
            "a boxy retro camcorder / handheld TV camera, cream and warm-grey body, a dark "
            "round lens, a tiny red recording tally light, red only on the tally light"
        ),
    },
    "comms_polaroids": {
        "w": 18,
        "palette": CREAMS + BLACKS + COOL,
        "prompt": p(
            "a small cluster of three or four pinned polaroid photos overlapping, cream "
            "photo borders, dark warm photo contents with a faint cool-blue tint"
        ),
    },
    "comms_robot": {
        "w": 18,
        "palette": CREAMS + BLACKS + TEAL + GOLD1,
        "prompt": p(
            "a small friendly boxy robot NPC, cream and warm-grey body, two round dim-teal "
            "eyes, a short antenna with a tiny gold tip, stubby arms"
        ),
    },
    # ── Launch ───────────────────────────────────────────────────────────────
    "launch_rocket": {
        "w": 16,
        "palette": CREAMS + BLACKS + REDS + GOLD1,
        "prompt": p(
            "a classic upright cartoon rocket on a small dark launch gantry, cream and "
            "off-white body, a red nose cone and red fin tips, a small round porthole, a "
            "tiny gold flame hint at the base"
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
    os.makedirs(OUT, exist_ok=True)
    for name in sys.argv[1:] or list(SPRITES):
        spec = SPRITES[name]
        print(f"generating {name}…", flush=True)
        img = process(generate(spec["prompt"]), spec["w"], spec["palette"])
        img.save(f"{OUT}/{name}.png")
        print(f"  wrote {OUT}/{name}.png {img.size}", flush=True)


if __name__ == "__main__":
    main()
