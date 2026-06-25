"""Generate a Fluncle pixel sprite as part of the one consistent family.

The deterministic spine of the Sprite System (see ../SKILL.md): an AI render is
only a high-res MOCK; the clean, on-spec sprite comes from the POST-process —
HSV chroma-key -> per-cell downscale to the 32x32 logical grid -> quantize to the
fixed Sprite Palette -> nearest-neighbour upscale to 256x256. AI gets ~70%; this
gets the non-negotiable last 30%.

Builds on packages/media/scripts/generate-earth-sprites.py, upgraded per the
research: a #00FF00 key + white-buffer, HSV keying (not RGB), per-CELL downscale
(majority colour, not single-point sampling), and the flat-front constants baked
into every prompt.

Usage (key read from the environment ONLY — never commit a key):

    GEMINI_API_KEY="$(op read 'op://Fluncle/GEMINI_API_KEY/credential')" \
      UV_CACHE_DIR=/tmp/uv-cache uv run --with pillow --with numpy \
      python packages/skills/fluncle-sprites/scripts/generate_sprite.py \
      web.newsletter ssh.rave dns.zone

PNG file name == the sprite id; output lands in packages/sprites/assets/earth/<id>.png
(the @fluncle/sprites canonical home; the web build mirrors it to public/). Change OUT
for the galaxy collection. Always taste-gate in /sprites before calling a sprite done.
"""

import base64
import io
import os
import sys
import urllib.request

import numpy as np
from PIL import Image

# ── fixed rails (see ../SKILL.md — never vary; they go in EVERY prompt) ─────────
CANVAS = 256          # output px (square)
LOGICAL = 32          # logical pixel grid (8px blocks at 256); 64 is the finer alt
GEN = 1024            # generation resolution (integer multiple of LOGICAL)
KEY_HEX = "#00ff00"   # solid chroma key; the model paints the subject over this

MODEL = "gemini-3.1-flash-image"
URL = f"https://generativelanguage.googleapis.com/v1/models/{MODEL}:generateContent"
OUT = "packages/sprites/assets/earth"  # the canonical home; the web build mirrors it to public/


def hexes(*hs):
    return [tuple(int(h[i : i + 2], 16) for i in (1, 3, 5)) for h in hs]


# The Sprite Palette (references/palette.md). Quantization snaps every pixel to
# the nearest of these, so a sprite cannot drift off-palette.
SPRITE_PALETTE = hexes(
    "#fffbf2", "#f4ead7", "#b7ab95", "#6e6657",   # cream — the default light body
    "#ffd057", "#f5b800", "#b88a00", "#7a5c00",   # eclipse gold — one-sun accent (<=10%)
    "#ffa18f", "#ff6b57", "#b23c2e", "#7a2418",   # re-entry red — heat accent
    "#46527a", "#3a5f5c",                          # cool counter-accents (sparing)
    "#171611", "#10100d", "#090a0b",               # warm blacks — outline / deep shadow
)

# Per-surface subject lines. The model never sees the surface id, only the
# subject. Extend this for the full registry set; keep each to ONE clear object.
SUBJECTS = {
    "web.newsletter": "a classic suburban mailbox with the flag raised, cream body, red flag",
    "web.home": "a record-sleeve archive crate of vinyl records seen head-on",
    "ssh.rave": "a chunky retro CRT computer terminal, cream casing, dark screen",
    "dns.zone": "a vintage telephone switchboard panel with patch cables",
    "subdomain.onion": "a single whole onion bulb",
    "web.radio": "a small portable transistor radio with an antenna",
    "web.mixtapes": "a vinyl record turntable seen head-on",
}

# Shared prompt scaffold — restate ALL constants every time (they don't carry).
TAIL = (
    ", 8-bit NES-era pixel art, FLAT FRONT VIEW, single object, no scene, no ground, "
    "chunky low-resolution pixels on a ~32px logical grid, one warm light from the "
    "UPPER-LEFT, bold cream body that stands out, palette limited to cream #f4ead7, "
    "gold #f5b800, red #ff6b57 and warm near-black #090a0b outline, centered, fills "
    "~80% of the frame, on a solid flat pure green #00FF00 background with a 2px white "
    "outline buffer around the subject. CRITICAL: NO anti-aliasing, no gradients, no "
    "noise, no dithering, no drop shadow, no text, no logos, no UI."
)


def prompt_for(subject: str) -> str:
    return "pixel art game sprite of " + subject + TAIL


# ── AI render (Gemini) — returns the raw high-res mock over the green key ───────
def generate(subject: str) -> Image.Image:
    body = {
        "contents": [{"parts": [{"text": prompt_for(subject)}]}],
        "generationConfig": {"responseModalities": ["IMAGE"]},
    }
    req = urllib.request.Request(
        f"{URL}?key={os.environ['GEMINI_API_KEY']}",
        data=__import__("json").dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = __import__("json").load(resp)
    for part in data["candidates"][0]["content"]["parts"]:
        if "inlineData" in part:
            raw = base64.b64decode(part["inlineData"]["data"])
            return Image.open(io.BytesIO(raw)).convert("RGB").resize((GEN, GEN), Image.LANCZOS)
    raise RuntimeError("no image in Gemini response")


# ── post-process (the deterministic 30%) ───────────────────────────────────────
def chroma_key_hsv(rgb: Image.Image) -> np.ndarray:
    """Drop the green key in HSV (robust to the AA fringe the white buffer caught).
    Returns an HxWx4 uint8 RGBA array."""
    arr = np.asarray(rgb.convert("RGB"), dtype=np.float32)
    hsv = np.asarray(rgb.convert("HSV"), dtype=np.float32)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    # green key ~ hue 85 (of 255). Mask greenish + saturated + bright pixels.
    green = (np.abs(h - 85) < 28) & (s > 90) & (v > 90)
    alpha = np.where(green, 0, 255).astype(np.uint8)
    rgba = np.dstack([arr.astype(np.uint8), alpha])
    return rgba


def downscale_per_cell(rgba: np.ndarray, logical: int = LOGICAL) -> np.ndarray:
    """Rebuild a clean logical-res sprite: per grid CELL take the dominant opaque
    colour (majority vote), not a single sample point — that kills edge-AA noise."""
    H = rgba.shape[0]
    cell = H // logical
    out = np.zeros((logical, logical, 4), dtype=np.uint8)
    for y in range(logical):
        for x in range(logical):
            block = rgba[y * cell : (y + 1) * cell, x * cell : (x + 1) * cell].reshape(-1, 4)
            opaque = block[block[:, 3] > 128]
            if len(opaque) < (cell * cell) * 0.35:   # mostly transparent -> empty cell
                continue
            # majority colour among opaque pixels (quantize coarsely first to vote)
            keys = (opaque[:, :3] // 16).astype(np.int32)
            flat = keys[:, 0] * 4096 + keys[:, 1] * 64 + keys[:, 2]
            vals, counts = np.unique(flat, return_counts=True)
            win = vals[counts.argmax()]
            sel = flat == win
            out[y, x, :3] = opaque[sel][:, :3].mean(axis=0).astype(np.uint8)
            out[y, x, 3] = 255
    return out


def quantize(rgba: np.ndarray, palette) -> np.ndarray:
    """Snap every opaque pixel to the nearest Sprite-Palette colour (alpha kept)."""
    pal = np.array(palette, dtype=np.int32)
    out = rgba.copy()
    opaque = rgba[..., 3] > 128
    px = rgba[opaque][:, :3].astype(np.int32)
    d = ((px[:, None, :] - pal[None, :, :]) ** 2).sum(axis=2)
    out[opaque, :3] = pal[d.argmin(axis=1)].astype(np.uint8)
    return out


def build(subject: str) -> Image.Image:
    raw = generate(subject)
    rgba = chroma_key_hsv(raw)
    small = downscale_per_cell(rgba)
    snapped = quantize(small, SPRITE_PALETTE)
    img = Image.fromarray(snapped, "RGBA")
    return img.resize((CANVAS, CANVAS), Image.NEAREST)   # nearest-neighbour ONLY


def main(ids):
    os.makedirs(OUT, exist_ok=True)
    for sid in ids:
        subject = SUBJECTS.get(sid)
        if not subject:
            print(f"!! no SUBJECTS entry for '{sid}' — add one, keep it ONE clear object")
            continue
        print(f".. {sid}: {subject}")
        out = os.path.join(OUT, f"{sid}.png")
        build(subject).save(out)
        print(f"   -> {out}  (now PILOT it: gate + view in /sprites before fanning out)")


if __name__ == "__main__":
    main(sys.argv[1:] or list(SUBJECTS))
