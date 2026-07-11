#!/usr/bin/env -S uv run --with fonttools --with brotli --script
"""Cut the Satori font family: static, latin-subset TTFs with the One Box Rule baked in.

WHY THIS EXISTS
---------------
The OG cards (`routes/api/og.$logId.ts`, `routes/api/og.set.ts`) and the mixtape cover
(`lib/server/mixtape-cover.ts`) render through workers-og → Satori → resvg, inside a
Cloudflare Worker. Three facts collide there:

  1. Satori does NOT read woff2. It takes TTF/OTF/WOFF only — so `public/fonts/*.woff2`,
     the faces the web app ships, are unusable as-is.
  2. A Worker has no system fonts, no `assets` binding (see `wrangler.jsonc`), and cannot
     fetch its own origin (that loops to the SPA fallback). So the bytes must be IN the
     bundle.
  3. Satori has no `@font-face`. It reads each TTF's own `hhea`/`OS/2` tables, which means
     the CSS `ascent-override` / `descent-override` that implement DESIGN.md's One Box Rule
     in `styles.css` CANNOT reach it.

DESIGN.md's own answer to (3) is "fix the font, not the elements" — so this script bakes the
normalised metrics INTO the cuts. Every face is re-tabled so `ascent − descent == cap height`,
putting the cap band exactly on the box centre. Satori then optically centres mixed-face,
mixed-size text with no per-element nudges, exactly as the browser does.

Satori also synthesizes nothing: no faux-bold, no interpolation. One buffer per weight, and
the markup may only ask for a weight that is registered.

WHAT IT PRODUCES
----------------
`src/lib/server/fonts/*.ttf` — four static, latin+latin-ext-subset TTFs, plus the upstream
OFL licences (SIL OFL 1.1 requires the licence travel with the font).

    Oxanium 400 / 800        — the brand: marks, mastheads, and ALL coordinates/numerals
    Space Grotesk 400 / 700  — the body: titles, artist lines, meta lines (700 is its ceiling)

They are imported as base64 data-URIs by `src/lib/server/og-fonts.ts` (Vite `?inline`), so
they land in the Worker bundle as bytes with no runtime fetch.

RUN IT
------
    apps/web/scripts/cut-satori-fonts.py            # rewrites src/lib/server/fonts/
    apps/web/scripts/cut-satori-fonts.py --verify   # read the tables back, assert, print

Re-run it to add a weight or a face: add a row to CUTS and rerun. The upstream variable fonts
are fetched from google/fonts at cut time and never committed (only the cuts are).
"""

from __future__ import annotations

import argparse
import io
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from fontTools.subset import Subsetter, Options
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

# --- The ratified One Box metrics (DESIGN.md §3, "The One Box Rule") ------------------
#
# Both faces are normalised to the SAME 1.25em box, cut so that (ascent − descent) equals
# that face's own cap height — which puts the cap band on the box centre. These are the
# numbers `styles.css` already sets as ascent-override/descent-override for the browser;
# they are RATIFIED, not derived here. Keep the two in lockstep.
ASCENT = {"Oxanium": 0.97, "Space Grotesk": 0.975}
DESCENT = {"Oxanium": 0.28, "Space Grotesk": 0.275}

# The upstream variable fonts (SIL OFL 1.1), fetched at cut time.
UPSTREAM = {
    "Oxanium": {
        "font": "https://raw.githubusercontent.com/google/fonts/main/ofl/oxanium/Oxanium%5Bwght%5D.ttf",
        "license": "https://raw.githubusercontent.com/google/fonts/main/ofl/oxanium/OFL.txt",
    },
    "Space Grotesk": {
        "font": "https://raw.githubusercontent.com/google/fonts/main/ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf",
        "license": "https://raw.githubusercontent.com/google/fonts/main/ofl/spacegrotesk/OFL.txt",
    },
}


@dataclass(frozen=True)
class Cut:
    family: str
    weight: int
    filename: str


# One buffer per weight — Satori synthesizes nothing. These are exactly the weights the
# three render surfaces ask for; adding a weight to the markup means adding it here first.
CUTS = [
    Cut("Oxanium", 400, "oxanium-400.ttf"),
    Cut("Oxanium", 800, "oxanium-800.ttf"),
    Cut("Space Grotesk", 400, "space-grotesk-400.ttf"),
    Cut("Space Grotesk", 700, "space-grotesk-700.ttf"),
]

# The subset: the union of the `latin` and `latin-ext` unicode-ranges the web app's
# @font-face rules declare (styles.css). Both, not just latin — an OG card has no
# second subset to fall back to and no system font behind it, so a track title carrying
# a "ł" or a "ř" would render as a blank .notdef box. The union is the safety net.
UNICODES = (
    # latin
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,"
    "U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD,"
    # latin-ext
    "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,"
    "U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"
)

USE_TYPO_METRICS = 1 << 7  # OS/2.fsSelection bit 7

OUT_DIR = Path(__file__).resolve().parent.parent / "src" / "lib" / "server" / "fonts"


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url) as response:  # noqa: S310 — fixed https literals above
        return response.read()


def patch_metrics(font: TTFont, family: str) -> None:
    """Bake the One Box Rule into the font's own tables.

    Satori reads hhea/OS/2 directly, so this is the only place the override can live. Set
    BOTH metric families (hhea and OS/2 sTypo*/usWin*) and flip USE_TYPO_METRICS, so every
    consumer — Satori, a browser, Windows — reads the same box.
    """
    upm = font["head"].unitsPerEm
    ascent = round(ASCENT[family] * upm)
    descent = round(DESCENT[family] * upm)

    hhea = font["hhea"]
    hhea.ascender = ascent
    hhea.descender = -descent
    hhea.lineGap = 0

    os2 = font["OS/2"]
    os2.sTypoAscender = ascent
    os2.sTypoDescender = -descent
    os2.sTypoLineGap = 0
    os2.usWinAscent = ascent
    os2.usWinDescent = descent
    os2.fsSelection |= USE_TYPO_METRICS


def cut(cut: Cut, variable: bytes) -> bytes:
    font = TTFont(io.BytesIO(variable))

    # 1. Pin the variable axis → a static instance at this weight.
    font = instancer.instantiateVariableFont(font, {"wght": cut.weight}, updateFontNames=True)

    # 2. Latin + latin-ext only.
    options = Options()
    options.drop_tables += ["DSIG"]
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.recalc_bounds = True
    subsetter = Subsetter(options=options)
    subsetter.populate(unicodes=parse_unicodes(UNICODES))
    subsetter.subset(font)

    # 3. Bake the normalised metrics (after the subset, so nothing recalculates them away).
    patch_metrics(font, cut.family)

    buffer = io.BytesIO()
    font.save(buffer)
    return buffer.getvalue()


def parse_unicodes(spec: str) -> list[int]:
    codepoints: list[int] = []

    for part in spec.split(","):
        part = part.strip().removeprefix("U+")

        if "-" in part:
            start, end = part.split("-")
            codepoints.extend(range(int(start, 16), int(end, 16) + 1))
        else:
            codepoints.append(int(part, 16))

    return codepoints


def deepest_glyph(font: TTFont, codepoints: set[int]) -> tuple[int, str]:
    """The lowest yMin among the glyphs reachable from `codepoints`, and its character."""
    glyf, cmap = font["glyf"], font.getBestCmap()
    reachable = [
        (glyf[name].yMin, codepoint)
        for codepoint, name in cmap.items()
        if codepoint in codepoints and glyf[name].numberOfContours
    ]

    return min(reachable) if reachable else (0, 0)


LATIN = set(parse_unicodes(UNICODES.split("U+0100-02BA")[0].rstrip(",")))


def verify(path: Path, family: str) -> bool:
    """Read the cut's real tables back and assert the box is what we claim it is."""
    font = TTFont(path)
    upm = font["head"].unitsPerEm
    hhea, os2 = font["hhea"], font["OS/2"]

    cap = os2.sCapHeight  # the face's OWN cap height, untouched by the patch
    box = hhea.ascender + hhea.descender  # descender is negative → ascent − |descent|

    # DESIGN.md's "check the deepest descender still fits" is scoped to latin — that is the
    # range it quotes (Oxanium .207em, Grotesk .200em). Assert exactly that, and report the
    # latin-ext tail separately (see WARN below).
    latin_low, latin_char = deepest_glyph(font, LATIN)
    all_low, all_char = deepest_glyph(font, set(parse_unicodes(UNICODES)))

    checks = [
        ("ascent − descent == cap height", box == cap, f"{box} vs {cap}"),
        ("hhea == OS/2 sTypo", (hhea.ascender, hhea.descender, hhea.lineGap)
         == (os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap), "matched"),
        ("usWin == the same box", (os2.usWinAscent, os2.usWinDescent) == (hhea.ascender, -hhea.descender), "matched"),
        ("USE_TYPO_METRICS set", bool(os2.fsSelection & USE_TYPO_METRICS), f"fsSelection=0x{os2.fsSelection:04x}"),
        ("deepest latin descender fits", latin_low >= hhea.descender,
         f"{latin_low} ({chr(latin_char)!r}) >= {hhea.descender}"),
        ("not variable", "fvar" not in font, "static"),
    ]

    ok = all(passed for _, passed, _ in checks)
    kb = path.stat().st_size / 1024
    print(f"\n  {path.name}  ({family}, upm {upm}, {kb:.1f} kB, {len(font.getGlyphOrder())} glyphs)")
    print(f"    hhea  ascender {hhea.ascender:>5}  descender {hhea.descender:>5}  lineGap {hhea.lineGap}")
    print(f"    OS/2  sTypo {os2.sTypoAscender:>5} / {os2.sTypoDescender:>5}   usWin {os2.usWinAscent} / {os2.usWinDescent}")
    print(f"    cap height {cap} ({cap / upm:.3f} em)   box {box / upm:.3f} em")

    for label, passed, detail in checks:
        print(f"    {'PASS' if passed else 'FAIL'}  {label}  ({detail})")

    # The latin-ext tail. Space Grotesk's comma-below accents (Ģ Ķ Ļ Ņ Ŗ) hang 0.017em past
    # the box at weight 700. Advisory, not a failure: nothing on these cards clips a line box
    # (the only overflow:hidden is the card frame, 64px from any glyph), and shrinking the
    # descent to fit a Latvian cedilla would move the cap band off centre for every OTHER
    # glyph — trading the rule for the exception.
    if all_low < hhea.descender:
        print(f"    WARN  latin-ext overshoot: {chr(all_char)!r} yMin {all_low} vs descent "
              f"{hhea.descender} ({(all_low - hhea.descender) / upm:+.3f} em) — cosmetic, unclipped")

    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="verify the committed cuts; do not re-cut")
    args = parser.parse_args()

    if not args.verify:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        variables = {family: fetch(source["font"]) for family, source in UPSTREAM.items()}

        for spec in CUTS:
            (OUT_DIR / spec.filename).write_bytes(cut(spec, variables[spec.family]))
            print(f"cut  {spec.filename}")

        for family, source in UPSTREAM.items():
            name = f"OFL-{family.replace(' ', '')}.txt"
            (OUT_DIR / name).write_bytes(fetch(source["license"]))
            print(f"cut  {name}")

    print("\nverifying the cuts against their real tables (fontTools, not the renderer):")
    ok = all(verify(OUT_DIR / spec.filename, spec.family) for spec in CUTS)
    print("\n" + ("all cuts on the box." if ok else "SOME CUTS ARE OFF THE BOX."))

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
