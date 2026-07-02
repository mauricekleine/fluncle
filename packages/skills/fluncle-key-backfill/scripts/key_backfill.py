# /// script
# requires-python = ">=3.10"
# dependencies = ["pyrekordbox>=0.4"]
# ///
"""Backfill Fluncle's missing musical keys from your Rekordbox library.

Fluncle's audio DSP writes `tracks.key` as scale text ("<NOTE> major"/"<NOTE>
minor") but stores NULL whenever key-confidence is below its floor — so a chunk
of the archive has no key at all. Rekordbox, meanwhile, has analysed the full
song and holds a confident key in `DjmdContent.Key.ScaleName` (short notation like
"Am" / "F" / "Bbm"). This script reconciles the two: it reads every Rekordbox key,
matches it to a Fluncle finding by normalized title+artist, and — after you eyeball
the proposals — writes the normalized key back through the `fluncle` CLI's admin
update (the same authenticated path the enrichment agent uses).

It is APPROVAL-GATED like the BPM backfill: `--dry-run` is the DEFAULT and prints
every proposal (plus ambiguous / unmatched / unknown-key rows) for a human to
approve. `--apply` performs the writes. It NEVER blind-writes.

Match discipline:
  - Rekordbox ISRC is unreliable, so matching is on normalized title+artist
    (case/accent-folded, `&`↔`and`, `feat.` credits dropped).
  - A REMIX / VIP / edit is a DIFFERENT recording with a different key, so its
    mix-descriptor is kept as part of the identity: "Song (Calibre Remix)" never
    matches the original "Song". Only same-descriptor pairs match.
  - An unrecognisable Rekordbox key normalizes to None and is SKIPPED (never
    guessed). Enharmonics fold to the DSP's SHARP spelling ("Bbm" → "A# minor").

Prerequisites (one-time, on this Mac), identical to rekordbox-tracklist.py:
  1. Quit Rekordbox fully — it holds an exclusive lock on master.db.
  2. Cache the SQLCipher key once:  uv run --with pyrekordbox python -m pyrekordbox download-key

The `fluncle` CLI must be on PATH and, for `--apply`, authenticated
(FLUNCLE_API_TOKEN) — the reads/writes go through the admin API, not the DB.

Usage:
  uv run key_backfill.py                       # dry-run: propose, write nothing
  uv run key_backfill.py --json                # dry-run, structured output
  uv run key_backfill.py --apply               # perform the writes (after eyeballing)
  uv run key_backfill.py --limit 500           # cap the Fluncle missing-key page
  uv run key_backfill.py --fluncle-bin ./fluncle
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import unicodedata
from dataclasses import dataclass

# ---------------------------------------------------------------------------
# Key normalization — Rekordbox short notation → the DSP's stored form.
#
# The DSP spells notes with SHARPS (analyze-track.ts `NOTES`), so every
# normalized key MUST use this exact spelling. Keep this array identical to it.
# ---------------------------------------------------------------------------

NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Natural-note → semitone index into NOTES.
_SEMITONE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# Camelot / OpenKey-A/B code → the DSP's final "<NOTE> <quality>" string. Rekordbox
# stores classical ScaleName by default, but a library configured to Camelot display
# can surface codes like "8A"; handling them is free reach and fully deterministic.
_CAMELOT = {
    "1A": "G# minor", "1B": "B major",
    "2A": "D# minor", "2B": "F# major",
    "3A": "A# minor", "3B": "C# major",
    "4A": "F minor", "4B": "G# major",
    "5A": "C minor", "5B": "D# major",
    "6A": "G minor", "6B": "A# major",
    "7A": "D minor", "7B": "F major",
    "8A": "A minor", "8B": "C major",
    "9A": "E minor", "9B": "G major",
    "10A": "B minor", "10B": "D major",
    "11A": "F# minor", "11B": "A major",
    "12A": "C# minor", "12B": "E major",
}

_MINOR_WORDS = {"m", "min", "minor"}
_MAJOR_WORDS = {"", "maj", "major"}


def normalize_key(raw: object) -> str | None:
    """Rekordbox `ScaleName` → the DSP's stored "<NOTE> major/minor", or None.

    Handles classical short notation ("Am", "F", "Bbm", "C#m", "Gb"), enharmonic
    flats folded to the DSP's sharps ("Bbm" → "A# minor"), unicode ♯/♭, and
    Camelot codes ("8A"). Anything it can't parse confidently returns None so the
    caller SKIPS it rather than writing a guess.
    """
    if raw is None:
        return None

    text = str(raw).strip()

    if not text:
        return None

    # Camelot / OpenKey-A/B (e.g. "8A", "12B") — resolve directly to the final form.
    camelot = _CAMELOT.get(text.upper())

    if camelot is not None:
        return camelot

    normalized = text.replace("♯", "#").replace("♭", "b")
    match = re.match(r"^([A-Ga-g])([#b]?)\s*(.*)$", normalized)

    if not match:
        return None

    letter, accidental, rest = match.groups()
    semitone = _SEMITONE[letter.upper()]

    if accidental == "#":
        semitone += 1
    elif accidental == "b":
        semitone -= 1

    note = NOTES[semitone % 12]
    quality_token = rest.strip()

    # Minor is a lowercase "m" suffix in Rekordbox ("Am"); major carries no suffix.
    # Compare case-sensitively for the bare "m" so a stray uppercase can't flip it,
    # but accept the spelled-out words case-insensitively.
    if quality_token == "m" or quality_token.lower() in _MINOR_WORDS:
        quality = "minor"
    elif quality_token == "" or quality_token.lower() in _MAJOR_WORDS:
        quality = "major"
    else:
        return None

    return f"{note} {quality}"


# ---------------------------------------------------------------------------
# Matching — normalized title + artist, with the mix-descriptor kept as identity.
# ---------------------------------------------------------------------------

# Words that mark a parenthetical / dash-suffix as a distinct VERSION of a track
# (a different recording, hence a different key). Their presence promotes the
# suffix to the match identity so a remix never folds onto the original.
_VERSION_WORDS = {
    "remix", "rmx", "vip", "edit", "bootleg", "rework", "refix", "flip",
    "dub", "version", "mix", "instrumental", "extended", "remaster",
}

# Suffixes that name a version but are NOT distinguishing — they are the original.
_NEUTRAL_DESCRIPTORS = {"original mix", "original", "extended mix"}

_ARTIST_SPLIT = re.compile(r"\s*(?:,|&|/|\band\b|\bx\b|\bvs\b|\bversus\b|\bwith\b)\s*")
_FEAT_INLINE = re.compile(r"\b(?:feat|ft|featuring)\b\.?.*$", re.IGNORECASE)
_PUNCT = re.compile(r"[^a-z0-9 ]+")
_WS = re.compile(r"\s+")


def _strip_accents(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def _fold(text: str) -> str:
    """Lowercase, strip accents, fold `&`→`and`, drop punctuation, collapse spaces."""
    folded = _strip_accents(text).lower().replace("&", " and ")
    folded = _PUNCT.sub(" ", folded)
    return _WS.sub(" ", folded).strip()


def _normalize_artists(artists: object) -> frozenset[str]:
    """A set of individual, folded artist names — order- and separator-agnostic.

    Accepts Fluncle's list or Rekordbox's single string ("A, B" / "A & B"). Drops
    `feat.` credits so a Rekordbox "A feat. B" matches a Fluncle ["A"].
    """
    if isinstance(artists, (list, tuple)):
        raw = ", ".join(str(a) for a in artists)
    else:
        raw = str(artists or "")

    raw = _FEAT_INLINE.sub("", raw)
    parts = _ARTIST_SPLIT.split(raw)
    names = {_fold(part) for part in parts}
    return frozenset(name for name in names if name)


def _split_title(title: str) -> tuple[str, str]:
    """(base_title, descriptor) — the base with feat./mix suffixes removed, plus the
    distinguishing version descriptor ("" for the original)."""
    working = str(title or "")
    descriptor = ""

    # Trailing parenthetical / bracket groups, right to left.
    for match in reversed(list(re.finditer(r"[\(\[]([^\)\]]*)[\)\]]", working))):
        inner = match.group(1)
        folded_inner = _fold(inner)

        if not folded_inner:
            working = working[: match.start()] + working[match.end():]
            continue

        # A feat. credit in the title is not a version — drop it from the base.
        if re.match(r"^(?:feat|ft|featuring)\b", folded_inner):
            working = working[: match.start()] + working[match.end():]
            continue

        tokens = set(folded_inner.split())

        if tokens & _VERSION_WORDS:
            if folded_inner not in _NEUTRAL_DESCRIPTORS:
                descriptor = folded_inner
            working = working[: match.start()] + working[match.end():]
        else:
            # A non-version parenthetical (a subtitle) — drop it from the base but
            # keep it non-distinguishing so a stored/absent subtitle still matches.
            working = working[: match.start()] + working[match.end():]

    # A dash-suffixed version: "Song - Calibre Remix".
    dash = re.search(r"\s[-–—]\s(.+)$", working)

    if dash:
        folded_suffix = _fold(dash.group(1))
        suffix_tokens = set(folded_suffix.split())

        if suffix_tokens & _VERSION_WORDS:
            if folded_suffix not in _NEUTRAL_DESCRIPTORS and not descriptor:
                descriptor = folded_suffix
            working = working[: dash.start()]

    # Drop an inline feat. from the base too.
    working = _FEAT_INLINE.sub("", working)
    return _fold(working), descriptor


def match_key(artists: object, title: str) -> tuple[frozenset[str], str, str]:
    """The identity two rows must share to be the same recording:
    (artist set, base title, version descriptor). Pure + deterministic."""
    base, descriptor = _split_title(title)
    return (_normalize_artists(artists), base, descriptor)


# ---------------------------------------------------------------------------
# Rekordbox read + reconciliation.
# ---------------------------------------------------------------------------


@dataclass
class RekordboxKey:
    artist: str
    title: str
    scale_name: str
    normalized: str | None


def die(message: str, hint: str | None = None) -> None:
    print(f"error: {message}", file=sys.stderr)

    if hint:
        print(f"  → {hint}", file=sys.stderr)

    raise SystemExit(1)


def open_db(db_path: str | None):
    try:
        from pyrekordbox import Rekordbox6Database
    except ImportError:
        die("pyrekordbox is not installed", "run via `uv run` so the inline dependency is provided")

    try:
        return Rekordbox6Database(path=db_path) if db_path else Rekordbox6Database()
    except Exception as exc:  # noqa: BLE001 — surface pyrekordbox's own message verbatim
        msg = str(exc).lower()

        if "key" in msg:
            die(
                "no decryption key for the Rekordbox database",
                "run once: uv run --with pyrekordbox python -m pyrekordbox download-key",
            )

        if "locked" in msg or "running" in msg:
            die("the Rekordbox database is locked", "quit Rekordbox fully, then retry")

        die(f"could not open the Rekordbox database: {exc}")


def read_rekordbox_keys(db) -> list[RekordboxKey]:
    """Every Rekordbox content row that carries a Key.ScaleName, normalized."""
    rows: list[RekordboxKey] = []

    for content in db.get_content():
        if getattr(content, "rb_local_deleted", 0) == 1:
            continue

        key_obj = getattr(content, "Key", None)
        scale_name = getattr(key_obj, "ScaleName", None) if key_obj else None

        if not scale_name:
            continue

        title = getattr(content, "Title", None) or ""
        artist = getattr(getattr(content, "Artist", None), "Name", None) or getattr(
            content, "ArtistName", None
        ) or ""
        rows.append(
            RekordboxKey(
                artist=str(artist),
                title=str(title),
                scale_name=str(scale_name),
                normalized=normalize_key(scale_name),
            )
        )

    return rows


def fetch_fluncle_missing_key(fluncle_bin: str, limit: int) -> list[dict]:
    """Fluncle's findings with NO stored key, via `admin tracks list --no-key --json`."""
    cmd = [fluncle_bin, "admin", "tracks", "list", "--no-key", "--json", "--limit", str(limit)]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    except FileNotFoundError:
        die(f"`{fluncle_bin}` not found on PATH", "install the fluncle CLI or pass --fluncle-bin")
    except subprocess.CalledProcessError as exc:
        die(f"`fluncle admin tracks list` failed: {exc.stderr.strip() or exc}")

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        die("could not parse `fluncle admin tracks list --json` output")

    tracks = payload.get("tracks", []) if isinstance(payload, dict) else []
    return [t for t in tracks if isinstance(t, dict) and t.get("type") != "mixtape"]


@dataclass
class Proposal:
    track_id: str
    artist: str
    title: str
    scale_name: str
    normalized: str


@dataclass
class Flagged:
    track_id: str
    artist: str
    title: str
    reason: str
    detail: str


def reconcile(
    fluncle_tracks: list[dict],
    rekordbox_keys: list[RekordboxKey],
) -> tuple[list[Proposal], list[Flagged], list[dict]]:
    """Pair each missing-key Fluncle finding with a Rekordbox key.

    Returns (proposals, flagged, unmatched). A finding is a PROPOSAL when exactly
    one Rekordbox identity match resolves to a single normalized key; AMBIGUOUS
    (flagged) when matches disagree on the key; and unmatched when no Rekordbox
    row shares its identity (left null — honest).
    """
    index: dict[tuple, list[RekordboxKey]] = {}

    for rk in rekordbox_keys:
        index.setdefault(match_key(rk.artist, rk.title), []).append(rk)

    proposals: list[Proposal] = []
    flagged: list[Flagged] = []
    unmatched: list[dict] = []

    for track in fluncle_tracks:
        title = track.get("title", "")
        artists = track.get("artists", [])
        artist_label = ", ".join(str(a) for a in artists) if isinstance(artists, list) else str(artists)
        track_id = str(track.get("trackId", ""))
        candidates = index.get(match_key(artists, title), [])

        if not candidates:
            unmatched.append(track)
            continue

        normalized_keys = {c.normalized for c in candidates if c.normalized}

        if not normalized_keys:
            flagged.append(
                Flagged(
                    track_id=track_id,
                    artist=artist_label,
                    title=str(title),
                    reason="unknown-key",
                    detail=", ".join(sorted({c.scale_name for c in candidates})),
                )
            )
            continue

        if len(normalized_keys) > 1:
            flagged.append(
                Flagged(
                    track_id=track_id,
                    artist=artist_label,
                    title=str(title),
                    reason="ambiguous",
                    detail=" | ".join(sorted(normalized_keys)),
                )
            )
            continue

        normalized = next(iter(normalized_keys))
        scale_name = next(c.scale_name for c in candidates if c.normalized == normalized)
        proposals.append(
            Proposal(
                track_id=track_id,
                artist=artist_label,
                title=str(title),
                scale_name=scale_name,
                normalized=normalized,
            )
        )

    return proposals, flagged, unmatched


def apply_proposal(fluncle_bin: str, proposal: Proposal) -> tuple[bool, str]:
    """Write one key via the CLI's authenticated admin update. (trackId, ok, detail)."""
    cmd = [fluncle_bin, "admin", "tracks", "update", proposal.track_id, "--key", proposal.normalized]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    except subprocess.CalledProcessError as exc:
        return False, (exc.stderr.strip() or str(exc))

    return True, result.stdout.strip()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill Fluncle's missing musical keys from Rekordbox (approval-gated)."
    )
    parser.add_argument("--db", help="path to the Rekordbox master.db (default: auto-detect)")
    parser.add_argument(
        "--fluncle-bin", default="fluncle", help="the fluncle CLI to shell out to (default: fluncle)"
    )
    parser.add_argument(
        "--limit", type=int, default=1000, help="cap the Fluncle missing-key page (default: 1000)"
    )
    parser.add_argument("--json", action="store_true", help="emit structured JSON")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run", action="store_true", help="propose only, write nothing (the DEFAULT)"
    )
    mode.add_argument("--apply", action="store_true", help="perform the writes after eyeballing")
    args = parser.parse_args()

    apply = args.apply  # dry-run is the default; --apply is the only way to write.

    fluncle_tracks = fetch_fluncle_missing_key(args.fluncle_bin, args.limit)
    db = open_db(args.db)
    rekordbox_keys = read_rekordbox_keys(db)
    proposals, flagged, unmatched = reconcile(fluncle_tracks, rekordbox_keys)

    applied: list[dict] = []

    if apply:
        for proposal in proposals:
            ok, detail = apply_proposal(args.fluncle_bin, proposal)
            applied.append({"trackId": proposal.track_id, "ok": ok, "detail": detail})

    if args.json:
        print(
            json.dumps(
                {
                    "mode": "apply" if apply else "dry-run",
                    "missingKeyCount": len(fluncle_tracks),
                    "rekordboxKeyCount": len(rekordbox_keys),
                    "proposals": [p.__dict__ for p in proposals],
                    "flagged": [f.__dict__ for f in flagged],
                    "unmatchedCount": len(unmatched),
                    "applied": applied,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    print(
        f"Fluncle findings missing a key: {len(fluncle_tracks)}  "
        f"| Rekordbox keys read: {len(rekordbox_keys)}\n"
    )

    if proposals:
        print(f"Proposed ({len(proposals)}):")
        for p in proposals:
            print(f'  {p.artist} — {p.title} : "{p.scale_name}" → "{p.normalized}"')
        print()

    if flagged:
        print(f"Flagged ({len(flagged)}) — NOT written, resolve by hand:")
        for f in flagged:
            print(f"  [{f.reason}] {f.artist} — {f.title}  ({f.detail})")
        print()

    print(f"No Rekordbox match (left null): {len(unmatched)}")

    if apply:
        ok_count = sum(1 for a in applied if a["ok"])
        print(f"\nApplied {ok_count}/{len(applied)} writes.")
        for a in applied:
            if not a["ok"]:
                print(f"  write FAILED for {a['trackId']}: {a['detail']}")
    else:
        print("\nDRY RUN — nothing written. Re-run with --apply to write the proposals above.")


if __name__ == "__main__":
    main()
