#!/usr/bin/env python3
"""DECK IDENTITY — read what Rekordbox has loaded on each deck, via native macOS OCR.

This is the capture+OCR half of the live show's "what is playing" problem. It answers
IDENTITY (which track is on a deck); the MIDI mixer-state feed answers CHANGE (which deck
went live, when). It is EVENT-DRIVEN, not polling: `--watch` OCRs a deck strip only when the
cropped strip's bytes CHANGE, so a ~260ms read costs nothing between transitions.

Pipeline (no computer-use in the loop, position-independent):
  1. Find the Rekordbox window id via Quartz (window metadata — needs no capture permission).
  2. `screencapture -x -o -l <wid>` that ONE window to a temp PNG (follows the window around).
  3. Crop each deck-header strip (validated fractional rects, TOP-left origin).
  4. VNRecognizeTextRequest (accurate, language-correction OFF) over each strip.
  5. Parse {title, artist, bpm, key}; hand the JSON to the pure resolver (identity.ts).

The resolver (src/bridge/identity.ts) owns matching to the archive; this script only reads.
bpm/key are best-effort reads and COARSE GUARDS downstream — never the identity.

Requires (macOS): `pyobjc-framework-Quartz`, `pyobjc-framework-Vision`. Run under a process
that has been granted Screen Recording (System Settings > Privacy & Security). If the capture
comes back blank, that permission is missing — this script reports it rather than guessing.

Usage:
  deckwatch.py --once            # OCR both decks now, print ONE JSON object, exit
  deckwatch.py --once --deck 2   # OCR now, print ONLY deck 2 as a flat {deck,title,…} object
  deckwatch.py --watch           # emit a JSON line per deck ONLY when its strip changes
  deckwatch.py --once --debug    # include raw OCR lines + timings on stderr
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unicodedata

import Quartz
import Vision
from Foundation import NSData

# ── Deck-header crop rects ────────────────────────────────────────────────────
# Normalized (x0, y0, x1, y1), TOP-left origin, as fractions of the captured window image.
# Validated live on the 2-deck PERFORMANCE view (window 1512x949 logical -> 3024x1898 px).
DECK1 = (0.020, 0.215, 0.355, 0.278)
DECK2 = (0.553, 0.215, 0.860, 0.278)
DECK_RECTS = (DECK1, DECK2)

BPM_RE = re.compile(r"(\d{2,3}\.\d{2})")
# A Camelot key token: 1..12 then A/B. Homoglyph-folded before this runs.
KEY_CAMELOT_RE = re.compile(r"\b(\d{1,2}[ABab])\b")
# A Classic key token: a note letter, optional accidental, optional m ("Gm", "F#", "Bbm").
KEY_CLASSIC_RE = re.compile(r"\b([A-G][#b♯♭]?m?)\b")

# Vision hands back Cyrillic/Greek homoglyphs for isolated Latin capitals (a real bug seen
# live: deck 2's key came back "5А" with a Cyrillic А). Fold them to Latin.
HOMOGLYPHS = str.maketrans(
    {
        "А": "A", "В": "B", "С": "C", "Е": "E", "М": "M", "Н": "H",
        "О": "O", "Р": "P", "Т": "T", "Х": "X", "К": "K",
        "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x",
        "Α": "A", "Β": "B", "Ε": "E", "Μ": "M", "Ο": "O", "Ρ": "P",
        "Τ": "T", "Κ": "K", "Η": "H", "Χ": "X",
    }
)


def fold(s: str) -> str:
    """NFKC-normalize and fold homoglyphs to Latin."""
    return unicodedata.normalize("NFKC", s).translate(HOMOGLYPHS)


def strip_leading_punct(s: str) -> str:
    """Drop a leading deck-number badge / stray punctuation bleed ("- I See…" -> "I See…")."""
    return re.sub(r"^[^\w(]+", "", s).strip()


# ── Window discovery + capture ────────────────────────────────────────────────


def find_window():
    """Return the window id of the main Rekordbox window (largest one > 800px wide)."""
    opts = (
        Quartz.kCGWindowListOptionOnScreenOnly
        | Quartz.kCGWindowListExcludeDesktopElements
    )
    best = None
    for w in Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID):
        if "rekordbox" not in (w.get("kCGWindowOwnerName") or "").lower():
            continue
        b = w["kCGWindowBounds"]
        if b["Width"] < 800 or b["Height"] < 400:
            continue
        area = b["Width"] * b["Height"]
        if best is None or area > best[1]:
            best = (int(w["kCGWindowNumber"]), area)
    return best[0] if best else None


def capture_window(window_id: int, path: str) -> bool:
    """Capture one window to `path`. Returns False on a screencapture error."""
    r = subprocess.run(
        ["screencapture", "-x", "-o", "-l", str(window_id), path],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        print(f"deckwatch: screencapture failed: {r.stderr.strip()}", file=sys.stderr)
        return False
    return True


def load_cgimage_from_bytes(data: bytes):
    """Decode PNG bytes held IN MEMORY into a CGImage.

    Deliberately not `CGImageSourceCreateWithURL`: that yields an image whose pixels are read
    lazily from the file, so if the file is deleted before crop/OCR forces a decode, every
    strip comes back empty (a real bug — a temp file deleted before the first decode). Building
    the source from an in-memory `NSData` makes the image own its bytes; the file can go the
    instant this returns.
    """
    ns = NSData.dataWithBytes_length_(data, len(data))
    src = Quartz.CGImageSourceCreateWithData(ns, None)
    if src is None:
        return None
    return Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)


def load_cgimage(path: str):
    """Load an on-disk PNG (a committed fixture) by reading it fully into memory first."""
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return None
    return load_cgimage_from_bytes(data)


def capture_to_image(window_id: int):
    """Capture one window, read the PNG into memory, delete the file, return a CGImage.

    Returns (image, "ok") on success, or (None, reason) where reason is one of
    "capture" (screencapture failed) / "decode" (valid file, undecodable).
    """
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
        path = tf.name
    try:
        if not capture_window(window_id, path):
            return None, "capture"
        with open(path, "rb") as f:
            data = f.read()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    img = load_cgimage_from_bytes(data)
    if img is None:
        return None, "decode"
    return img, "ok"


def image_is_uniform(cgimg, sample: int = 48) -> bool:
    """True only when the image genuinely decodes to a SINGLE flat colour.

    This is the honest test for "a blank capture" (the real symptom of denied Screen
    Recording). We draw a small copy into a bitmap context WE own and inspect the actual
    pixels — never inferred from absent OCR text (a deck with no track loaded also has no
    text, and that is not a blank capture).
    """
    w = min(int(Quartz.CGImageGetWidth(cgimg)), sample)
    h = min(int(Quartz.CGImageGetHeight(cgimg)), sample)
    if w <= 0 or h <= 0:
        return True
    cs = Quartz.CGColorSpaceCreateDeviceRGB()
    buf = bytearray(w * h * 4)
    ctx = Quartz.CGBitmapContextCreate(
        buf, w, h, 8, w * 4, cs, Quartz.kCGImageAlphaPremultipliedLast
    )
    if ctx is None:
        return False  # can't prove it's blank — don't claim it is
    Quartz.CGContextDrawImage(ctx, Quartz.CGRectMake(0, 0, w, h), cgimg)
    return len(set(bytes(buf))) <= 1


def crop(img, rect):
    w, h = Quartz.CGImageGetWidth(img), Quartz.CGImageGetHeight(img)
    x0, y0, x1, y1 = rect
    r = Quartz.CGRectMake(x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h)
    return Quartz.CGImageCreateWithImageInRect(img, r)


def cgimage_png_bytes(cgimg) -> bytes:
    """Serialize a CGImage to PNG bytes — used to hash a strip so we skip OCR when unchanged."""
    data = Quartz.CFDataCreateMutable(None, 0)
    dest = Quartz.CGImageDestinationCreateWithData(data, "public.png", 1, None)
    if dest is None:
        return b""
    Quartz.CGImageDestinationAddImage(dest, cgimg, None)
    Quartz.CGImageDestinationFinalize(dest)
    return bytes(data)


# ── OCR ───────────────────────────────────────────────────────────────────────


def ocr_lines(cgimg):
    """OCR a strip; return [[text, text, ...], ...] grouped into lines (top first, L->R).

    Handles the "a title splits across several observations on one line" gotcha by binning
    observations into y-bands and ordering each band left-to-right before joining.
    """
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cgimg, None)
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setUsesLanguageCorrection_(False)
    ok, _ = handler.performRequests_error_([req], None)
    if not ok:
        return []
    obs = []
    for o in req.results() or []:
        cand = o.topCandidates_(1)
        if cand:
            bb = o.boundingBox()  # normalized, origin BOTTOM-left
            obs.append((float(bb.origin.y), float(bb.origin.x), cand[0].string()))
    if not obs:
        return []
    obs.sort(key=lambda t: -t[0])  # top (high y) first
    lines, cur, cur_y = [], [], obs[0][0]
    for y, x, txt in obs:
        if abs(y - cur_y) > 0.15:  # a new visual line
            lines.append([t for _, t in sorted(cur, key=lambda p: p[0])])
            cur, cur_y = [], y
        cur.append((x, txt))
    lines.append([t for _, t in sorted(cur, key=lambda p: p[0])])
    return lines


def parse_fields(lines):
    """Turn grouped OCR lines into {title, artist, bpm, key} (all best-effort, any may be None)."""
    if not lines:
        return None
    title = strip_leading_punct(fold(" ".join(lines[0])))
    artist = bpm = key = None
    if len(lines) > 1:
        toks = [fold(t) for t in lines[1]]
        joined = " ".join(toks)
        m = BPM_RE.search(joined)
        bpm = float(m.group(1)) if m else None
        m = KEY_CAMELOT_RE.search(joined)
        if m:
            key = m.group(1).upper()
        else:
            m = KEY_CLASSIC_RE.search(joined)
            key = m.group(1) if m else None
        # artist = leftmost token that isn't the bpm/key/time blob
        for t in toks:
            if not BPM_RE.search(t) and not t.startswith("-") and ":" not in t:
                if t.strip() and not KEY_CAMELOT_RE.fullmatch(t.strip()):
                    artist = t.strip()
                    break
    return {"artist": artist, "bpm": bpm, "key": key, "title": title}


def parse_deck(img, rect, debug=False):
    """OCR one deck strip and parse it, with a self-calibrating full-window fallback.

    LAYOUT DEPENDENCE gotcha: the rects assume the 2-deck performance view. If the parsed
    second line carries NO bpm, the crop probably missed the header — re-OCR the full window
    and pick the header structurally (the title line sitting just above a bpm-bearing line).
    """
    lines = ocr_lines(crop(img, rect))
    fields = parse_fields(lines)
    if fields and fields["bpm"] is not None:
        if debug:
            fields["_lines"] = lines
        return fields

    # Fallback: structural header selection over the whole window on the correct side.
    side = "left" if rect[0] < 0.5 else "right"
    fb = structural_header(img, side)
    if fb is not None:
        if debug:
            fb["_lines"] = fb.get("_lines", [])
            fb["_fallback"] = True
        return fb
    if debug and fields is not None:
        fields["_lines"] = lines
    return fields


def structural_header(img, side: str):
    """Full-window OCR; find a bpm-bearing line and take the line above it as the title.

    `side` restricts to the left/right half (deck 1 vs deck 2). This survives a moved/resized
    layout where the fixed crop rects no longer align.
    """
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(img, None)
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setUsesLanguageCorrection_(False)
    ok, _ = handler.performRequests_error_([req], None)
    if not ok:
        return None
    obs = []
    for o in req.results() or []:
        cand = o.topCandidates_(1)
        if not cand:
            continue
        bb = o.boundingBox()
        x, y = float(bb.origin.x), float(bb.origin.y)
        on_side = x < 0.5 if side == "left" else x >= 0.5
        if y > 0.55 and on_side:  # top band only
            obs.append((y, x, fold(cand[0].string())))
    if not obs:
        return None
    # Find the highest (topmost) line that contains a bpm; the title is the line just above it.
    obs.sort(key=lambda t: -t[0])
    bpm_idx = next((i for i, (_, _, t) in enumerate(obs) if BPM_RE.search(t)), None)
    if bpm_idx is None or bpm_idx == 0:
        return None
    by = obs[bpm_idx][0]
    title_toks = [
        (x, t) for (y, x, t) in obs if by < y < by + 0.12
    ]
    meta_toks = [t for (y, _, t) in obs if abs(y - by) <= 0.03]
    title = strip_leading_punct(" ".join(t for _, t in sorted(title_toks, key=lambda p: p[0])))
    joined = " ".join(meta_toks)
    m = BPM_RE.search(joined)
    bpm = float(m.group(1)) if m else None
    m = KEY_CAMELOT_RE.search(joined) or KEY_CLASSIC_RE.search(joined)
    key = (m.group(1).upper() if m and m.re is KEY_CAMELOT_RE else (m.group(1) if m else None))
    artist = next(
        (t for t in meta_toks if not BPM_RE.search(t) and ":" not in t and not t.startswith("-")),
        None,
    )
    return {"artist": artist, "bpm": bpm, "key": key, "title": title}


# ── Read one frame ─────────────────────────────────────────────────────────────


def read_decks(debug=False):
    """Capture + OCR both decks once. Returns (decks, strip_hashes) or (None, None) on failure."""
    wid = find_window()
    if wid is None:
        print("deckwatch: no Rekordbox window found — is it running?", file=sys.stderr)
        return None, None

    img, reason = capture_to_image(wid)
    if img is None:
        if reason == "capture":
            print("deckwatch: screencapture failed (see error above).", file=sys.stderr)
        else:
            print("deckwatch: captured a file but could not decode it.", file=sys.stderr)
        return None, None

    strips = [crop(img, r) for r in DECK_RECTS]
    hashes = [hashlib.sha1(cgimage_png_bytes(s)).hexdigest() for s in strips]

    decks = []
    any_text = False
    for i, rect in enumerate(DECK_RECTS):
        t0 = time.perf_counter()
        d = parse_deck(img, rect, debug=debug)
        if debug:
            print(f"deckwatch: deck {i + 1} OCR {(time.perf_counter() - t0) * 1000:.0f}ms",
                  file=sys.stderr)
        if d and (d.get("title") or d.get("bpm")):
            any_text = True
        decks.append(d)

    # Only DIAGNOSE if nothing was read — and say what we actually know, not a false cause.
    if not any_text:
        if image_is_uniform(img):
            # A genuinely flat image: this is the real signature of a denied capture.
            print(
                "deckwatch: capture decoded to a UNIFORM image (no visible content) — this is "
                "the signature of denied Screen Recording permission for this process.",
                file=sys.stderr,
            )
        else:
            # The capture HAS content but the header rects yielded no text. Most often both
            # decks simply have no track loaded; could also be a layout the fallback missed.
            print(
                "deckwatch: capture has content but no deck header text was read — most likely "
                "both decks have no track loaded (or a non-performance layout the "
                "self-calibrating fallback did not recognise).",
                file=sys.stderr,
            )
    return decks, hashes


def deck_payload(index, fields):
    out = {"deck": index + 1, "title": None, "artist": None, "bpm": None, "key": None}
    if fields:
        for k in ("title", "artist", "bpm", "key"):
            out[k] = fields.get(k)
    return out


# ── Entry points ────────────────────────────────────────────────────────────────


def run_once(debug=False, deck=None):
    """OCR both decks once and print one JSON object.

    Default (`--once`): the both-decks envelope `{"t":…,"decks":[…]}` (unchanged).
    With `--deck N`: emit ONLY deck N's fields as a FLAT object
    `{"deck":N,"title":…,"artist":…,"bpm":…,"key":…}` — the exact shape the transition
    datagram's `identity` wants, so `sender.py --identity-cmd 'deckwatch.py --once --deck {deck}'`
    can attach it verbatim.
    """
    decks, _ = read_decks(debug=debug)
    if decks is None:
        return 1
    if deck is not None:
        line = deck_payload(deck - 1, decks[deck - 1])
        print(json.dumps(line, ensure_ascii=False))
        return 0
    payload = {"t": int(time.time() * 1000), "decks": [deck_payload(i, d) for i, d in enumerate(decks)]}
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def run_watch(interval: float, debug=False):
    """Emit a JSON line per deck ONLY when that deck's cropped strip changes.

    Hashing the strip bytes and skipping OCR when unchanged keeps this event-driven and nearly
    free between transitions. A poll every `interval`s just checks the cheap hash.
    """
    last = [None, None]
    while True:
        wid = find_window()
        if wid is None:
            time.sleep(max(interval, 1.0))
            continue
        img, _ = capture_to_image(wid)
        if img is None:
            time.sleep(interval)
            continue
        for i, rect in enumerate(DECK_RECTS):
            strip = crop(img, rect)
            h = hashlib.sha1(cgimage_png_bytes(strip)).hexdigest()
            if h == last[i]:
                continue  # strip unchanged — skip OCR entirely
            last[i] = h
            fields = parse_deck(img, rect, debug=debug)
            line = deck_payload(i, fields)
            line["t"] = int(time.time() * 1000)
            print(json.dumps(line, ensure_ascii=False), flush=True)
        time.sleep(interval)


def main():
    ap = argparse.ArgumentParser(description="Read Rekordbox deck headers via macOS Vision OCR.")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--once", action="store_true", help="OCR both decks once, print one JSON object")
    g.add_argument("--watch", action="store_true", help="emit a JSON line per deck when it changes")
    ap.add_argument("--interval", type=float, default=0.4, help="--watch poll seconds (default 0.4)")
    ap.add_argument(
        "--deck",
        type=int,
        choices=(1, 2),
        default=None,
        help="with --once, emit ONLY this deck's fields as a flat {deck,title,artist,bpm,key} object",
    )
    ap.add_argument("--debug", action="store_true", help="raw OCR lines + timings on stderr")
    args = ap.parse_args()

    if args.once:
        return run_once(debug=args.debug, deck=args.deck)
    try:
        run_watch(args.interval, debug=args.debug)
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
