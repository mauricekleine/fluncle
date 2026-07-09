"""Generate a Fluncle pixel sprite, the proven way (the recipe that made the rocket).

An AI render is a MOCK; the on-spec sprite comes from the post-process. The three things
that make a sprite read as clearly as the reference packs:

  1. PER-SPRITE PALETTE SUBSET. Quantize each sprite to ONLY the colours it should
     use (a mailbox = cream + black + red, NO gold), never the whole 16-colour set —
     so an accent can't creep into a highlight. This is the cohesion lever.
  2. MAGENTA KEY + CROP. Render on flat #FF00FF, key it out, and CROP to the subject's
     bounding box. No white-buffer trick (that left a halo); the crop trims the edge.
  3. HD RESOLUTION + OUTLINE. Render at ~40 px logical width (not ~16 — that starves the
     form) and wrap the silhouette in a deterministic 1 px dark contour (add_outline).
     The resolution gives the form room; the contour is the "pop" every reference sprite has.

Usage (key from the environment ONLY — never commit a key):

    GEMINI_API_KEY="$(op read 'op://<vault>/GEMINI_API_KEY/credential')" \
      UV_CACHE_DIR=/tmp/uv-cache uv run --with pillow \
      python packages/skills/fluncle-sprites/scripts/generate_sprite.py ufo

PNG name == the sprite id; output lands in packages/sprites/assets/<collection>/<id>.png
(the @fluncle/sprites canonical home; the web build mirrors it to public/). The sprite
is stored small (its logical width) and the browser upscales it crisply with
`image-rendering: pixelated`. Always taste-gate the sprite next to its family (view the
PNGs upscaled with nearest-neighbor) before fanning out.
"""

import base64
import io
import json
import os
import sys
import urllib.error
import urllib.request

from PIL import Image

MODEL = "gemini-3.1-flash-image"
URL = f"https://generativelanguage.googleapis.com/v1/models/{MODEL}:generateContent"
ASSETS = "packages/sprites/assets"  # per-sprite "collection" (default "galaxy") picks the subdir


def hexes(*hs):
    return [tuple(int(h[i : i + 2], 16) for i in (1, 3, 5)) for h in hs]


# Canon ramps (DESIGN.md / references/palette.md). Compose a per-sprite SUBSET below.
CREAMS = hexes("#fffbf2", "#f4ead7", "#b7ab95", "#6e6657")  # the light body
BLACKS = hexes("#090a0b", "#10100d", "#171611")  # warm outline / shadow
GOLDS = hexes("#ffd057", "#f5b800", "#b88a00", "#7a5c00")  # eclipse gold (One-Sun accent)
GOLD1 = hexes("#f5b800")  # a single gold note
REDS = hexes("#ffa18f", "#ff6b57", "#b23c2e", "#7a2418")  # re-entry red (heat accent)
COOL = hexes("#46527a")  # cool counter-accent (sparing)
TEAL = hexes("#3a5f5c")  # cool counter-accent (sparing)

# Shared scaffold — restate ALL constants every prompt (they don't carry). A LOCKED 3/4
# camera with a PINNED FACING: like a tidy sprite sheet, every object faces the SAME way —
# front toward the lower-left, receding to the upper-right (a top-right→bottom-left axis).
# One upper-left light, MAGENTA key (no white buffer — it haloed); the bans kill blur.
TAIL = (
    ", detailed 16-bit pixel-art game icon, a uniform THREE-QUARTER VIEW where EVERY object "
    "faces the SAME way — angled so its front faces toward the LOWER-LEFT of the frame and the "
    "form recedes toward the UPPER-RIGHT (a consistent top-right-to-bottom-left orientation, "
    "like one tidy sprite sheet), seen from slightly above — a single centered object, no "
    "scene, no ground, cel-shaded volume in a few clear value steps with strong dark edges, "
    "one soft light from the UPPER-LEFT, on a solid flat pure magenta #FF00FF background. Sharp "
    "clean pixels, no blurry anti-aliasing, no gradient banding, no dither, no drop shadow, no "
    "text, no logos, no UI."
)

# GAMEPLAY exceptions to the 3/4 facing — VERTICAL, head-on, symmetric, NOT angled, because
# the player moves along that axis: a craft taking off UP gets a front view (pf); the playable
# ship flies away from the viewer (rear view, pointing up/away, pr).
TAIL_FRONT = (
    ", detailed 16-bit pixel-art game icon, a FRONT VIEW with the object standing vertically "
    "and pointing straight UP, seen head-on and symmetric with its nose at the top facing the "
    "viewer, centered, NOT tilted and NOT rotated to three-quarter — a single object, no scene, "
    "no ground, cel-shaded volume in a few clear value steps with strong dark edges, one soft "
    "light from the UPPER-LEFT, on a solid flat pure magenta #FF00FF background. Sharp clean "
    "pixels, no blurry anti-aliasing, no gradient banding, no dither, no drop shadow, no text, "
    "no logos, no UI."
)
TAIL_REAR = (
    ", detailed 16-bit pixel-art game icon, a REAR VIEW seen from directly behind with the craft "
    "pointing straight UP and AWAY from the viewer, vertical and symmetric — you see its back, "
    "with the engine exhausts nearest the viewer at the bottom and the nose pointing away at the "
    "top, centered, NOT tilted and NOT rotated to three-quarter — a single object, no scene, no "
    "ground, cel-shaded volume in a few clear value steps with strong dark edges, one soft light "
    "from the UPPER-LEFT, on a solid flat pure magenta #FF00FF background. Sharp clean pixels, "
    "no blurry anti-aliasing, no gradient banding, no dither, no drop shadow, no text, no logos, "
    "no UI."
)

# Resolution is the make-or-read lever: ~16 px starves the form, ~40 px lets the outline +
# shading land (the reference HD-pixel-art look). ADD_OUTLINE dilates the silhouette by 1 px
# in the shared darkest warm-black — the crisp contour every reference sprite carries.
ADD_OUTLINE = True
OUTLINE_RGB = (9, 10, 11)  # #090a0b — the BLACKS spine's darkest, always in every subset


def p(subject):
    return "pixel art game sprite of " + subject + TAIL


def pf(subject):  # takeoff craft — front view, pointing straight up (the takeoff axis)
    return "pixel art game sprite of " + subject + TAIL_FRONT


def pr(subject):  # playable ship — rear view, pointing straight up/away (the player's POV)
    return "pixel art game sprite of " + subject + TAIL_REAR


# Per-sprite spec: w = logical width (~40 px HD; browser-upscaled crisp); palette = the
# SUBSET (the gold-creep fix); prompt = subject + its colour story with an explicit
# "<accent> only on X" / "no gold". Today's set is the Galaxy game's five sprites; new
# entries follow the same shape (an optional "collection" picks the assets/ subdir).
SPRITES = {
    "asteroid": {
        "collection": "galaxy",
        "w": 44,
        "palette": CREAMS + BLACKS,
        "prompt": p(
            "a chunky space asteroid, a lumpy cream and warm-grey boulder with several dark "
            "round craters, only cream and warm greys"
        ),
    },
    "earth": {
        "collection": "galaxy",
        "w": 42,
        "palette": COOL + TEAL + CREAMS + BLACKS,
        "prompt": p(
            "the planet Earth as a round globe, deep cool-blue oceans with cream-and-teal "
            "continents and a soft cream highlight on the upper-left, blue and teal only on the "
            "planet"
        ),
    },
    "roadster": {
        "collection": "galaxy",
        "w": 46,
        "palette": REDS + CREAMS + BLACKS,
        "prompt": p(
            "a sleek red convertible sports car seen from the side, a glossy red body with "
            "cream and warm-grey wheels and windshield and a small cream interior, the car body "
            "is red"
        ),
    },
    "ship": {  # PLAYABLE entity — the rear "piloting" camera (pr), nose pointing away
        "collection": "galaxy",
        "w": 42,
        "palette": CREAMS + BLACKS + GOLD1 + REDS,
        "prompt": pr(
            "a sleek small spaceship fighter, a cream and warm-grey hull with swept-back wings "
            "and gold wing edges and a dark cockpit, twin engine thrusters glowing warm at the "
            "tail, gold only on the wing edges, red only on the engine glow"
        ),
    },
    "ufo": {
        "collection": "galaxy",
        "w": 46,
        "palette": CREAMS + BLACKS + TEAL,
        "prompt": p(
            "a classic flying saucer UFO, a cream and warm-grey metallic disc with a domed glass "
            "top and a row of small dark-teal lights underneath, teal only on the lights"
        ),
    },
}


def generate(prompt: str) -> bytes:
    body = json.dumps({"contents": [{"parts": [{"text": prompt}]}]}).encode()
    req = urllib.request.Request(
        URL,
        data=body,
        headers={"Content-Type": "application/json", "x-goog-api-key": os.environ["GEMINI_API_KEY"]},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as err:
        print("Gemini API error:", err.read().decode()[:600], file=sys.stderr)
        raise
    for cand in data.get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                return base64.b64decode(inline["data"])
    raise RuntimeError("no image in response: " + json.dumps(data)[:400])


def is_bg(px) -> bool:
    r, g, b = px[0], px[1], px[2]
    return r > 150 and b > 120 and g < 110  # magenta-ish


def nearest(px, palette):
    r, g, b = px
    return min(palette, key=lambda c: (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2)


def add_outline(img: Image.Image) -> Image.Image:
    """Wrap the opaque silhouette in a 1 px dark contour (the reference-sprite pop).

    Pads 1 px so the outline isn't clipped, then paints every transparent pixel that
    touches an opaque one (8-neighbour) in the shared darkest warm-black.
    """
    pad = Image.new("RGBA", (img.width + 2, img.height + 2), (0, 0, 0, 0))
    pad.paste(img, (1, 1))
    src = pad.load()
    W, H = pad.size
    solid = [[src[x, y][3] >= 128 for y in range(H)] for x in range(W)]
    out = pad.copy()
    op = out.load()
    for y in range(H):
        for x in range(W):
            if solid[x][y]:
                continue
            if any(
                0 <= x + dx < W and 0 <= y + dy < H and solid[x + dx][y + dy]
                for dx in (-1, 0, 1)
                for dy in (-1, 0, 1)
            ):
                op[x, y] = (*OUTLINE_RGB, 255)
    return out


def process(raw: bytes, w: int, palette) -> Image.Image:
    img = Image.open(io.BytesIO(raw)).convert("RGBA")
    px = img.load()
    W, H = img.size
    minx, miny, maxx, maxy = W, H, 0, 0
    for y in range(H):
        for x in range(W):
            if is_bg(px[x, y]):
                px[x, y] = (0, 0, 0, 0)
            else:
                minx, miny, maxx, maxy = min(minx, x), min(miny, y), max(maxx, x), max(maxy, y)
    if maxx <= minx:
        raise RuntimeError("keyed image is empty — was the background magenta?")
    img = img.crop((minx, miny, maxx + 1, maxy + 1))  # crop trims any edge halo
    img = img.resize((w, max(1, round(img.height * (w / img.width)))), Image.LANCZOS)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    sp, op = img.load(), out.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = sp[x, y]
            if a < 110:
                continue
            op[x, y] = (*nearest((r, g, b), palette), 255)  # snap to the SUBSET only
    return add_outline(out) if ADD_OUTLINE else out


def main(names):
    for name in names:
        spec = SPRITES.get(name)
        if not spec:
            print(f"!! no SPRITES entry for '{name}' — add {{w, palette subset, prompt}}")
            continue
        out_dir = f"{ASSETS}/{spec.get('collection', 'galaxy')}"
        os.makedirs(out_dir, exist_ok=True)
        print(f".. {name}: generating", flush=True)
        img = process(generate(spec["prompt"]), spec["w"], spec["palette"])
        img.save(f"{out_dir}/{name}.png")
        print(f"   -> {out_dir}/{name}.png {img.size}  (PILOT it: gate + view it next to the family)")


if __name__ == "__main__":
    main(sys.argv[1:] or list(SPRITES))
