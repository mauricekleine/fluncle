# /// script
# requires-python = ">=3.10"
# dependencies = ["pyrekordbox>=0.4"]
# ///
"""Derive a recording's cue tracklist from a Rekordbox session history.

Reads the live `master.db` session (ordered by `TrackNo`, plus Key + BPM),
matches each row to a Fluncle finding by normalized title+artist (the same
matcher the key-backfill uses), and emits the ordered cue array
`{findingId?, artistsText, titleText, position}` for `replace-cues`.

Three match buckets — **matched** (exactly 1 finding → `findingId` set),
**ambiguous** (>1 candidates, flagged, `findingId=null`), **unmatched** (no
candidate, flagged, `findingId=null`).  `startMs` is left absent for every cue
— the operator marks the precise mix-in on the Studio cue rail later.

Auto-prune: **consecutive** same-identity rows (a re-load) are collapsed to the
first occurrence.  Non-consecutive repeats (a track played twice in the set)
are kept but flagged.

Dry-run is the DEFAULT — prints every cue (matched, flagged, skipped) without
writing anything.  Pass `--apply <recordingId>` to write via
`fluncle admin recordings replace-cues`.

Prerequisites (one-time, on this Mac):
  1. Quit Rekordbox fully — it holds an exclusive lock on master.db.
  2. pyrekordbox auto-extracts the SQLCipher key from your Rekordbox install when it
     opens the database — no separate key step needed. (`python -m pyrekordbox
     download-key` was removed upstream at AlphaTheta's request.)
     If auto-extraction ever fails, cache the key once:
       from pyrekordbox.config import write_db6_key_cache; write_db6_key_cache("<key>")
     or pass it directly: Rekordbox6Database(key="<key>")

Usage:
  uv run rekordbox-derive-cues.py                               # dry-run: latest session
  uv run rekordbox-derive-cues.py --session "2026-07"          # pick a session
  uv run rekordbox-derive-cues.py --list                        # list sessions
  uv run rekordbox-derive-cues.py --json                        # structured JSON output
  uv run rekordbox-derive-cues.py --apply <recordingId>         # write the cues
  uv run rekordbox-derive-cues.py --apply <recordingId> --json  # write + JSON summary
  uv run rekordbox-derive-cues.py --limit 5000                  # raise the catalogue cap
  uv run rekordbox-derive-cues.py --fluncle-bin ./fluncle
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Import pure matching helpers from the shared module.  The scripts/ directory
# is on sys.path when run via `uv run` from within it.
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.dirname(__file__))

from _matching import _fold, _normalize_artists, match_key  # noqa: E402


# ---------------------------------------------------------------------------
# DB helpers — same pattern as rekordbox-tracklist.py and key_backfill.py.
# ---------------------------------------------------------------------------


def die(message: str, hint: str | None = None) -> None:
    print(f"error: {message}", file=sys.stderr)
    if hint:
        print(f"  → {hint}", file=sys.stderr)
    raise SystemExit(1)


def open_db(db_path: str | None):
    try:
        from pyrekordbox import Rekordbox6Database
    except ImportError:
        die(
            "pyrekordbox is not installed",
            "run via `uv run` so the inline dependency is provided",
        )

    try:
        return Rekordbox6Database(path=db_path) if db_path else Rekordbox6Database()
    except Exception as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if "key" in msg:
            die(
                "auto-extraction of the Rekordbox SQLCipher key failed",
                "make sure Rekordbox is installed; if it still fails, cache the key manually:"
                " from pyrekordbox.config import write_db6_key_cache; write_db6_key_cache('<key>')"
                " (python -m pyrekordbox download-key was removed upstream)",
            )
        if "locked" in msg or "running" in msg:
            die("the Rekordbox database is locked", "quit Rekordbox fully, then retry")
        die(f"could not open the Rekordbox database: {exc}")


# ---------------------------------------------------------------------------
# Rekordbox session reading — extends rekordbox-tracklist.py with Key + BPM.
# ---------------------------------------------------------------------------


def live_sessions(db) -> list:
    """History playlists that are real sessions (not folders, not deleted), newest first."""
    sessions = [
        h
        for h in db.get_history()
        if getattr(h, "Attribute", 0) != 1 and getattr(h, "rb_local_deleted", 0) == 0
    ]
    sessions.sort(key=lambda h: str(getattr(h, "DateCreated", "") or ""), reverse=True)
    return sessions


def _content_for_song(song) -> object:
    return song.Content


def _artist_str(content) -> str:
    return (
        getattr(getattr(content, "Artist", None), "Name", None)
        or getattr(content, "ArtistName", None)
        or ""
    )


def _bpm_float(content) -> float | None:
    raw = getattr(content, "BPM", None)
    if raw is None:
        return None
    try:
        # Rekordbox stores BPM*100 as an integer
        return int(raw) / 100
    except (TypeError, ValueError):
        return None


def _key_str(content) -> str | None:
    key_obj = getattr(content, "Key", None)
    return getattr(key_obj, "ScaleName", None) if key_obj else None


def session_rows(db, session) -> list[dict]:
    """Ordered session rows with artist, title, key, bpm, and load time."""
    songs = [
        s
        for s in db.get_history_songs(HistoryID=session.ID)
        if getattr(s, "rb_local_deleted", 0) == 0
    ]
    songs.sort(key=lambda s: s.TrackNo)

    rows: list[dict] = []
    for song in songs:
        content = _content_for_song(song)
        created = getattr(song, "created_at", None)
        rows.append(
            {
                "track_no": song.TrackNo,
                "artist": str(_artist_str(content)),
                "title": str(getattr(content, "Title", None) or ""),
                "key": _key_str(content),
                "bpm": _bpm_float(content),
                "load_time": str(created) if created else None,
            }
        )
    return rows


# ---------------------------------------------------------------------------
# Fluncle catalogue fetch.
# ---------------------------------------------------------------------------


def fetch_fluncle_catalogue(fluncle_bin: str, limit: int) -> list[dict]:
    """All findings (excluding mixtapes) via `admin tracks list --json --limit N`."""
    cmd = [fluncle_bin, "admin", "tracks", "list", "--json", "--limit", str(limit)]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    except FileNotFoundError:
        die(
            f"`{fluncle_bin}` not found on PATH",
            "install the fluncle CLI or pass --fluncle-bin",
        )
    except subprocess.CalledProcessError as exc:
        die(f"`fluncle admin tracks list` failed: {exc.stderr.strip() or exc}")

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        die("could not parse `fluncle admin tracks list --json` output")

    tracks = payload.get("tracks", []) if isinstance(payload, dict) else []
    return [t for t in tracks if isinstance(t, dict) and t.get("type") != "mixtape"]


# ---------------------------------------------------------------------------
# Dedup + matching.
# ---------------------------------------------------------------------------


@dataclass
class Cue:
    """One derived recording cue.  `startMs` is absent — set in Studio later."""

    track_no: int
    artist: str
    title: str
    finding_id: str | None
    artists_text: str  # snapshot string for the cue row
    title_text: str
    position: int  # 1-based; reassigned after consecutive dedup
    match_bucket: str  # "matched" | "ambiguous" | "unmatched"
    flagged_reason: str | None = None  # "repeat" for non-consecutive repeats
    flag_detail: str | None = None  # Ambiguous candidate ids

    def to_cue_dict(self) -> dict:
        d: dict = {
            "artistsText": self.artists_text,
            "titleText": self.title_text,
            "position": self.position,
        }
        if self.finding_id is not None:
            d["findingId"] = self.finding_id
        return d


def build_catalogue_index(fluncle_tracks: list[dict]) -> dict[tuple, list[dict]]:
    """Map match_key → [finding, ...] for all Fluncle findings."""
    index: dict[tuple, list[dict]] = {}
    for track in fluncle_tracks:
        key = match_key(track.get("artists", []), track.get("title", ""))
        index.setdefault(key, []).append(track)
    return index


def derive_cues(rows: list[dict], catalogue_index: dict[tuple, list[dict]]) -> list[Cue]:
    """Map session rows → Cue objects (before consecutive dedup).

    Buckets:
    - matched: exactly 1 finding with the same identity → findingId set
    - ambiguous: >1 findings (same base identity, e.g. two versions that all
      folded to the same key) → flagged, findingId=null
    - unmatched: 0 findings → flagged, findingId=null
    """
    cues: list[Cue] = []
    for row in rows:
        identity = match_key(row["artist"], row["title"])
        candidates = catalogue_index.get(identity, [])

        artist_str = row["artist"]
        title_str = row["title"]

        if not candidates:
            cues.append(
                Cue(
                    track_no=row["track_no"],
                    artist=artist_str,
                    title=title_str,
                    finding_id=None,
                    artists_text=artist_str,
                    title_text=title_str,
                    position=0,  # set after dedup
                    match_bucket="unmatched",
                )
            )
        elif len(candidates) == 1:
            finding = candidates[0]
            artists_text = ", ".join(str(a) for a in finding.get("artists", [artist_str]))
            cues.append(
                Cue(
                    track_no=row["track_no"],
                    artist=artist_str,
                    title=title_str,
                    finding_id=str(finding.get("trackId", "")),
                    artists_text=artists_text,
                    title_text=str(finding.get("title", title_str)),
                    position=0,
                    match_bucket="matched",
                )
            )
        else:
            # Ambiguous: multiple candidates with the same identity (edge case).
            ids = ", ".join(str(f.get("trackId", "?")) for f in candidates)
            cues.append(
                Cue(
                    track_no=row["track_no"],
                    artist=artist_str,
                    title=title_str,
                    finding_id=None,
                    artists_text=artist_str,
                    title_text=title_str,
                    position=0,
                    match_bucket="ambiguous",
                    flag_detail=ids,
                )
            )
    return cues


def prune_consecutive_and_flag_repeats(cues: list[Cue]) -> list[Cue]:
    """Collapse consecutive same-identity rows (re-loads) and flag non-consecutive repeats.

    "Identity" is the match_key tuple of (artistsText, titleText) using the same
    folded comparison as the catalogue matcher.
    """
    # Step 1: drop consecutive same-identity runs (keep the first occurrence).
    pruned: list[Cue] = []
    for cue in cues:
        cue_identity = match_key(cue.artists_text, cue.title_text)
        if pruned and match_key(pruned[-1].artists_text, pruned[-1].title_text) == cue_identity:
            # Consecutive re-load → skip
            continue
        pruned.append(cue)

    # Step 2: flag non-consecutive repeats.
    seen: dict[tuple, int] = {}  # identity → count of appearances
    for cue in pruned:
        k = match_key(cue.artists_text, cue.title_text)
        seen[k] = seen.get(k, 0) + 1
    repeat_identities = {k for k, count in seen.items() if count > 1}

    for cue in pruned:
        if match_key(cue.artists_text, cue.title_text) in repeat_identities:
            cue.flagged_reason = "repeat"

    # Step 3: assign final 1-based positions.
    for i, cue in enumerate(pruned):
        cue.position = i + 1

    return pruned


# ---------------------------------------------------------------------------
# Write via CLI.
# ---------------------------------------------------------------------------


def write_cues(fluncle_bin: str, recording_id: str, cues: list[Cue]) -> dict:
    """Write the cue array to the recording via `fluncle admin recordings replace-cues`."""
    cue_array = [c.to_cue_dict() for c in cues]

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, encoding="utf-8"
    ) as f:
        json.dump(cue_array, f, ensure_ascii=False)
        tmp_path = f.name

    try:
        cmd = [
            fluncle_bin,
            "admin",
            "recordings",
            "replace-cues",
            recording_id,
            "--cues-file",
            tmp_path,
            "--json",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return json.loads(result.stdout)
    except subprocess.CalledProcessError as exc:
        die(
            f"`fluncle admin recordings replace-cues` failed: {exc.stderr.strip() or exc}"
        )
    finally:
        os.unlink(tmp_path)

    return {}


# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Derive a recording's cue tracklist from a Rekordbox session."
    )
    parser.add_argument(
        "--session",
        help="Pick a session by a substring of its name (default: latest session)",
    )
    parser.add_argument(
        "--list",
        dest="list_sessions",
        action="store_true",
        help="List available sessions and exit",
    )
    parser.add_argument("--db", help="Path to the Rekordbox master.db (default: auto-detect)")
    parser.add_argument(
        "--fluncle-bin",
        default="fluncle",
        help="The fluncle CLI to shell out to (default: fluncle)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=5000,
        help="Cap on findings fetched from the Fluncle catalogue (default: 5000)",
    )
    parser.add_argument(
        "--json",
        dest="json_out",
        action="store_true",
        help="Emit structured JSON",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run",
        action="store_true",
        help="Propose cues only, write nothing (the DEFAULT)",
    )
    mode.add_argument(
        "--apply",
        metavar="RECORDING_ID",
        help="Write the derived cues to this recording via replace-cues",
    )
    args = parser.parse_args()

    db = open_db(args.db)
    sessions = live_sessions(db)

    if not sessions:
        die("no history sessions found in the Rekordbox database")

    if args.list_sessions:
        for s in sessions:
            count = db.get_history_songs(HistoryID=s.ID).count()
            date_str = str(getattr(s, "DateCreated", "")).ljust(26)
            print(f"{date_str} {count:>3} tracks  {s.Name}")
        return

    # Pick session.
    if args.session:
        needle = args.session.lower()
        session = next(
            (s for s in sessions if needle in (s.Name or "").lower()), None
        )
        if not session:
            die(f"no session matching {args.session!r}", "see `--list` for available sessions")
    else:
        session = sessions[0]

    rows = session_rows(db, session)

    if not rows:
        die(f"no tracks in session {session.Name!r}")

    # Fetch Fluncle catalogue and match.
    catalogue = fetch_fluncle_catalogue(args.fluncle_bin, args.limit)
    index = build_catalogue_index(catalogue)
    raw_cues = derive_cues(rows, index)
    cues = prune_consecutive_and_flag_repeats(raw_cues)

    # Counts.
    n_input = len(rows)
    n_pruned = n_input - len(cues)
    n_matched = sum(1 for c in cues if c.match_bucket == "matched")
    n_ambiguous = sum(1 for c in cues if c.match_bucket == "ambiguous")
    n_unmatched = sum(1 for c in cues if c.match_bucket == "unmatched")
    n_repeats = sum(1 for c in cues if c.flagged_reason == "repeat")

    applied: dict = {}
    if args.apply:
        applied = write_cues(args.fluncle_bin, args.apply, cues)

    if args.json_out:
        print(
            json.dumps(
                {
                    "mode": "apply" if args.apply else "dry-run",
                    "session": session.Name,
                    "inputRows": n_input,
                    "prunedConsecutive": n_pruned,
                    "cues": [
                        {
                            **c.to_cue_dict(),
                            "matchBucket": c.match_bucket,
                            "flaggedReason": c.flagged_reason,
                            "flagDetail": c.flag_detail,
                        }
                        for c in cues
                    ],
                    "counts": {
                        "matched": n_matched,
                        "ambiguous": n_ambiguous,
                        "unmatched": n_unmatched,
                        "repeats": n_repeats,
                    },
                    "applied": applied,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    # Human-readable report.
    print(f"Session: {session.Name}")
    print(
        f"  Input rows: {n_input}  |  consecutive-pruned: {n_pruned}  |  "
        f"output cues: {len(cues)}\n"
    )

    w = max((len(c.artists_text) + len(c.title_text) + 3) for c in cues) if cues else 40

    for cue in cues:
        label = f"{cue.artists_text} — {cue.title_text}"
        flag = ""
        if cue.flagged_reason:
            flag += f"  [{cue.flagged_reason.upper()}]"
        if cue.match_bucket == "ambiguous":
            flag += f"  [AMBIGUOUS: {cue.flag_detail}]"
        elif cue.match_bucket == "unmatched":
            flag += "  [UNMATCHED — findingId=null]"
        bucket_mark = "✓" if cue.match_bucket == "matched" else "?"
        print(f"  {cue.position:>2}. {bucket_mark} {label:<{w}}{flag}")

    print(
        f"\n  Matched: {n_matched}  Ambiguous: {n_ambiguous}  "
        f"Unmatched: {n_unmatched}  Repeats flagged: {n_repeats}"
    )

    if args.apply:
        print(f"\n  Wrote {len(cues)} cues → recording {args.apply}")
        print(f"  startMs is absent — mark each mix-in on the Studio cue rail.")
    else:
        print(
            "\n  DRY RUN — nothing written.  "
            "Re-run with --apply <recordingId> to write the cues above."
        )


if __name__ == "__main__":
    main()
