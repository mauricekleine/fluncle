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
      python packages/skills/fluncle-sprites/scripts/generate_sprite.py comms_mailbox

PNG name == the sprite id; output lands in packages/sprites/assets/earth/<id>.png
(the @fluncle/sprites canonical home; the web build mirrors it to public/). The sprite
is stored small (its logical width) and the browser upscales it crisply with
`image-rendering: pixelated`. Always taste-gate in /sprites before fanning out.
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
ASSETS = "packages/sprites/assets"  # per-sprite "collection" (default "earth") picks the subdir


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

# Two GAMEPLAY exceptions to the 3/4 facing — both VERTICAL, head-on, symmetric, NOT angled,
# because the player moves along that axis: a launch rocket takes off UP (front view, nose up,
# pf), and the playable ship flies away from the viewer (rear view, pointing up/away, pr).
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


def pf(subject):  # launch rocket — front view, pointing straight up (the takeoff axis)
    return "pixel art game sprite of " + subject + TAIL_FRONT


def pr(subject):  # playable ship — rear view, pointing straight up/away (the player's POV)
    return "pixel art game sprite of " + subject + TAIL_REAR


# Per-sprite spec: w = logical width (~40 px HD; browser-upscaled crisp); palette = the
# SUBSET (the gold-creep fix); prompt = subject + its colour story with an explicit
# "<accent> only on X" / "no gold". This is the full registry set — every distinct sprite
# the /sprites registry grid maps a surface to. comms_mailbox calibrates the family.
SPRITES = {
    "comms_mailbox": {  # web.newsletter, cron.newsletter
        "w": 40,
        "palette": CREAMS + BLACKS + REDS,
        "prompt": p(
            "a classic mailbox on a post, a cream and warm-grey body, a small red flag raised "
            "on the side, red only on the flag"
        ),
    },
    "crt": {  # ssh.rave
        "w": 40,
        "palette": CREAMS + BLACKS + TEAL + GOLD1,
        "prompt": p(
            "a chunky retro CRT computer monitor on a stand, a cream and warm-grey casing, a "
            "dim dark-teal screen with faint scanlines, a tiny gold power light"
        ),
    },
    "launch_rocket": {  # web.galaxy, subdomain.galaxy (variant A — the canonical hero)
        "w": 26,
        "palette": CREAMS + BLACKS + REDS + GOLD1,
        "prompt": pf(
            "a slender narrow rocket ship, a thin streamlined cream-white hull MUCH taller than "
            "it is wide, a sharp pointed red cone nose, a small round dark porthole high on the "
            "hull, three slim red fins at the base, a short warm-gold flame beneath, sleek and "
            "elegant, not chubby, no launch tower, no stand, no face"
        ),
    },
    "docs_manual": {  # web.docs
        "w": 46,
        "palette": CREAMS + BLACKS + REDS,
        "prompt": p(
            "an open hardcover book lying flat, cream pages with a few faint grey text lines, "
            "a warm-grey cover, a single thin red ribbon bookmark down the middle, red only on "
            "the ribbon, no gold"
        ),
    },
    "privacy_lock": {  # web.privacy
        "w": 40,
        "palette": CREAMS + BLACKS + GOLD1,
        "prompt": p(
            "a closed padlock, a chunky cream and warm-grey body with a small dark keyhole, a "
            "gold metal shackle arching over the top, gold only on the shackle"
        ),
    },
    "stories_reel": {  # web.stories (clapperboard — the reel read as a magnifier)
        "w": 44,
        "palette": CREAMS + BLACKS + REDS,
        "prompt": p(
            "a film clapperboard slate, a cream and warm-grey slate with a hinged clapper bar "
            "on top carrying diagonal black-and-cream stripes, a few faint grey text lines on "
            "the slate, a single small red dot, red only on the dot"
        ),
    },
    "home_beacon": {  # web.home (stout lighthouse — widened to match the family weight)
        "w": 30,
        "palette": CREAMS + BLACKS + REDS,
        "prompt": p(
            "a stout lighthouse beacon, a wide chunky cream and warm-grey tower with a broad "
            "base and horizontal banding, a glowing red lamp room at the top, red only on the "
            "lamp, no gold"
        ),
    },
    "status_panel": {  # web.status (a round gauge — a PERFECT circle, the dial IS the icon)
        "w": 36,
        "palette": CREAMS + BLACKS + REDS + GOLD1,
        "prompt": p(
            "a single round analog gauge shaped as a PERFECT CIRCLE with equal width and "
            "height, a cream face with bold dark tick marks evenly around the full rim, a thin "
            "gold bezel ring around the circle, one red needle pointing up from a small center "
            "hub, red only on the needle, gold only on the bezel, a clean perfect circle not an "
            "oval, centered with a small even margin"
        ),
    },
    "edge_switchboard": {  # dns.zone, subdomain.dig (bold cables — not a dot grid)
        "w": 42,
        "palette": CREAMS + BLACKS + GOLD1,
        "prompt": p(
            "a vintage telephone switchboard, a cream and warm-grey upright panel with two rows "
            "of large round dark jack sockets and exactly three thick curved patch cables "
            "looping between them, small brass-gold plug tips, gold only on the plug tips, "
            "clean and uncluttered"
        ),
    },
    "edge_terminal": {  # mcp.server
        "w": 42,
        "palette": CREAMS + BLACKS + TEAL + GOLD1,
        "prompt": p(
            "a retro desktop computer terminal, a cream and warm-grey monitor on a box with a "
            "separate keyboard in front, a dim dark-teal screen, a tiny gold power light, "
            "teal only on the screen, gold only on the light"
        ),
    },
    "edge_onion": {  # subdomain.onion (the Tor onion)
        "w": 34,
        "palette": CREAMS + BLACKS + REDS + TEAL,
        "prompt": p(
            "a single onion bulb, cream and warm-grey layered skin with thin red-brown layer "
            "lines, a small teal-green sprout at the top, red-brown only on the layer lines, "
            "teal only on the sprout"
        ),
    },
    "found_chest": {  # subdomain.found (the R2 media zone — the vault of recovered findings)
        "w": 42,
        "palette": CREAMS + BLACKS + GOLD1,
        "prompt": p(
            "an old treasure chest, a closed cream and warm-grey wooden chest with a domed lid, "
            "gold metal corner bands and a gold clasp lock on the front, gold only on the bands "
            "and the clasp"
        ),
    },
    "radio": {  # web.radio, subdomain.radio
        "w": 44,
        "palette": CREAMS + BLACKS + GOLD1,
        "prompt": p(
            "a chunky retro tabletop radio, a cream and warm-grey body with a round speaker "
            "grille, a round gold tuning dial, and a thin antenna, gold only on the dial"
        ),
    },
    "edge_fusebox": {  # subdomain.status (open box, a few BIG breakers + one bold light)
        "w": 38,
        "palette": CREAMS + BLACKS + REDS + GOLD1,
        "prompt": p(
            "an open electrical fuse box, a cream and warm-grey box with its door open showing "
            "one column of four big dark breaker switches and a single bright red indicator "
            "light at the top, red only on the light, gold only on a small label, bold and clear"
        ),
    },
    "landing_board": {  # web.about (a notice board on legs)
        "w": 42,
        "palette": CREAMS + BLACKS + REDS,
        "prompt": p(
            "a notice board on two legs, a cream pinned board in a warm-grey frame with a few "
            "small pinned note cards, a single red pushpin, red only on the pushpin"
        ),
    },
    "landing_logbook": {  # web.log (a closed ledger — distinct from the open book)
        "w": 38,
        "palette": CREAMS + BLACKS + GOLD1,
        "prompt": p(
            "a closed leather-bound logbook ledger standing upright, a cream and warm-grey "
            "cover with a gold corner clasp and a thin ribbon bookmark, gold only on the clasp"
        ),
    },
    "turntable": {  # web.mixtapes
        "w": 46,
        "palette": CREAMS + BLACKS + GOLD1,
        "prompt": p(
            "a DJ turntable seen from above, a cream and warm-grey deck with a round black "
            "vinyl record with a cream label, and a slim gold tonearm resting on the record, "
            "gold only on the tonearm"
        ),
    },
    # launch_rocket (above) is variant A — the canonical hero. These are the other two
    # keepers from that pass: alternate rockets in the family, available for other surfaces,
    # the games, or fleet variety.
    "rocket_riveted": {  # variant B — retro riveted, mid-band
        "w": 30,
        "palette": CREAMS + BLACKS + REDS + GOLD1,
        "prompt": pf(
            "a slim detailed retro rocket ship, a narrow cream-white riveted hull MUCH taller "
            "than wide, a red cone nose, a thin red band around the midsection, a small round "
            "dark porthole near the top, four slim fins at the base in cream and red, a short "
            "gold flame, sleek and elegant, not chubby, no stand, no face"
        ),
    },
    "rocket_capsule": {  # variant C — minimalist capsule
        "w": 24,
        "palette": CREAMS + BLACKS + REDS + GOLD1,
        "prompt": pf(
            "a minimalist sleek rocket, a narrow smooth cream-white capsule body MUCH taller "
            "than wide, a simple red pointed tip and two clean symmetric red fins, a single "
            "small round dark window high up, a thin warm flame at the base, a very clean simple "
            "iconic shape, not chubby, no stand, no face"
        ),
    },
    # --- Earth-overworld game props (the rest of the earth collection, brought to HD).
    "boombox": {
        "w": 46,
        "palette": CREAMS + BLACKS + REDS,
        "prompt": p(
            "a retro boombox stereo, a cream and warm-grey body with two round speaker grilles, "
            "a cassette deck in the middle, a carry handle on top, a few small red buttons, red "
            "only on the buttons"
        ),
    },
    "comms_camcorder": {
        "w": 42,
        "palette": CREAMS + BLACKS + REDS,
        "prompt": p(
            "a retro handheld video camcorder, a cream and warm-grey body with a dark round "
            "lens at the front and a small viewfinder, a single red record dot, red only on the "
            "record dot"
        ),
    },
    "comms_pager": {
        "w": 30,
        "palette": CREAMS + BLACKS + TEAL,
        "prompt": p(
            "a chunky 90s pager, a cream and warm-grey body with a small dark-teal LCD screen "
            "and two buttons, teal only on the screen"
        ),
    },
    "comms_polaroids": {
        "w": 40,
        "palette": CREAMS + BLACKS + TEAL,
        "prompt": p(
            "two overlapping instant photos fanned in a small stack, cream polaroid frames with "
            "a dim dark-teal photo area inside each, teal only on the photo area"
        ),
    },
    "comms_robot": {
        "w": 32,
        "palette": CREAMS + BLACKS + TEAL + REDS,
        "prompt": p(
            "a cute little retro robot standing, a boxy cream and warm-grey body, a round head "
            "with two dark eyes, a small antenna with a red bulb on top, a dark-teal chest "
            "panel, teal only on the chest, red only on the antenna bulb"
        ),
    },
    "floppy": {
        "w": 40,
        "palette": CREAMS + BLACKS + GOLD1,
        "prompt": p(
            "a 3.5 inch floppy disk seen flat, a cream and warm-grey square with a metal shutter "
            "across the top and a paper label below, a small gold write-protect tab, gold only "
            "on the tab"
        ),
    },
    "landing_lens": {
        "w": 40,
        "palette": CREAMS + BLACKS + GOLD1,
        "prompt": p(
            "a magnifying glass, a round empty glass lens with a thin gold rim and a warm-grey "
            "handle angled down, a soft cream glint across the glass, gold only on the rim"
        ),
    },
    "landing_monolith": {
        "w": 24,
        "palette": CREAMS + BLACKS + TEAL,
        "prompt": p(
            "a tall standing black monolith slab, a smooth dark obelisk taller than wide with a "
            "thin cream edge highlight and faint glowing dark-teal cracks down its face, teal "
            "only on the cracks"
        ),
    },
    "landing_nokia": {
        "w": 26,
        "palette": CREAMS + BLACKS + TEAL,
        "prompt": p(
            "a classic 90s candybar mobile phone, a cream and warm-grey body with a small "
            "dark-teal screen, a grid keypad, and a short stubby antenna, teal only on the screen"
        ),
    },
    # --- Galaxy game sprites (a separate collection — written to assets/galaxy/).
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
        out_dir = f"{ASSETS}/{spec.get('collection', 'earth')}"
        os.makedirs(out_dir, exist_ok=True)
        print(f".. {name}: generating", flush=True)
        img = process(generate(spec["prompt"]), spec["w"], spec["palette"])
        img.save(f"{out_dir}/{name}.png")
        print(f"   -> {out_dir}/{name}.png {img.size}  (PILOT it: gate + view in /sprites)")


if __name__ == "__main__":
    main(sys.argv[1:] or list(SPRITES))
