# /// script
# requires-python = ">=3.10"
# dependencies = ["pyrekordbox>=0.4"]
# ///
"""Pull the ordered tracklist for a Fluncle mixtape out of Rekordbox history.

Rekordbox logs every set into its `djmdSongHistory` table in the order tracks
were loaded onto a deck. That ORDER (and the track identities) is what a mixtape
tracklist needs. The per-row `created_at` is the deck-LOAD time, not the moment a
track became audible in the mix — a DJ cues the next tune well before bringing it
in, and that lead varies track to track — so it is NOT a usable cue offset. We
surface it only as a dim reference and otherwise ignore it. Cue offsets, if ever
wanted, have to come from somewhere else (the operator marking them against the
final video). This script gives you the reliable part: an ordered, de-duplicated
`Artist — Title` list to feed the add-to-mixtape flow.

Two real-world wrinkles it surfaces rather than guesses about:
  - Pre-loads. A track loaded during soundcheck (or cued and never aired) shows up
    as a history row just like a played track. There is no reliable timestamp tell
    (see above), so the script flags repeats and leaves pruning to you.
  - Re-loads. Loading the same track twice creates two rows; both are flagged as
    DUP so you can drop the spurious one.

Prerequisites (one-time, on this Mac):
  1. Quit Rekordbox fully — it holds an exclusive lock on master.db.
  2. pyrekordbox auto-extracts the SQLCipher key from your Rekordbox install when it
     opens the database — no separate key step needed. (`python -m pyrekordbox
     download-key` was removed upstream at AlphaTheta's request; do not re-add it.)
     If auto-extraction ever fails, cache the key once:
       from pyrekordbox.config import write_db6_key_cache; write_db6_key_cache("<key>")
     or pass it directly: Rekordbox6Database(key="<key>")

Usage:
  uv run rekordbox-tracklist.py                 # latest session, human-readable
  uv run rekordbox-tracklist.py --list          # list sessions, newest first
  uv run rekordbox-tracklist.py --session 06-18 # pick a session by name substring
  uv run rekordbox-tracklist.py --plain         # just "Artist — Title" lines
  uv run rekordbox-tracklist.py --json          # structured output
"""

from __future__ import annotations

import argparse
import json
import sys


def die(message: str, hint: str | None = None) -> "None":
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
                "auto-extraction of the Rekordbox SQLCipher key failed",
                "make sure Rekordbox is installed; if it still fails, cache the key manually:"
                " from pyrekordbox.config import write_db6_key_cache; write_db6_key_cache('<key>')"
                " (python -m pyrekordbox download-key was removed upstream)",
            )
        if "locked" in msg or "running" in msg:
            die("the Rekordbox database is locked", "quit Rekordbox fully, then retry")
        die(f"could not open the Rekordbox database: {exc}")


def live_sessions(db) -> list:
    """History playlists that are real sessions (not folders, not deleted), newest first."""
    sessions = [
        h
        for h in db.get_history()
        if getattr(h, "Attribute", 0) != 1 and getattr(h, "rb_local_deleted", 0) == 0
    ]
    sessions.sort(key=lambda h: str(getattr(h, "DateCreated", "") or ""), reverse=True)
    return sessions


def track_label(song) -> str:
    content = song.Content
    title = getattr(content, "Title", None) or "?"
    artist = getattr(getattr(content, "Artist", None), "Name", None) or getattr(
        content, "ArtistName", None
    ) or "?"
    return f"{artist} — {title}"


def extract(song):
    created = getattr(song, "created_at", None)
    return {
        "track_no": song.TrackNo,
        "label": track_label(song),
        "load_time": str(created) if created else None,
    }


def session_tracklist(db, session) -> list[dict]:
    songs = [
        s
        for s in db.get_history_songs(HistoryID=session.ID)
        if getattr(s, "rb_local_deleted", 0) == 0
    ]
    songs.sort(key=lambda s: s.TrackNo)
    rows = [extract(s) for s in songs]

    # Flag repeats (pre-loads / re-loads of the same track) so the operator prunes.
    seen: dict[str, int] = {}
    for row in rows:
        seen[row["label"]] = seen.get(row["label"], 0) + 1
    for row in rows:
        row["duplicate"] = seen[row["label"]] > 1

    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract a mixtape's ordered tracklist from Rekordbox history.")
    parser.add_argument("--session", help="pick a session by a substring of its name (default: latest)")
    parser.add_argument("--list", action="store_true", dest="list_sessions", help="list sessions and exit")
    parser.add_argument("--db", help="path to the Rekordbox master.db (default: auto-detect)")
    out = parser.add_mutually_exclusive_group()
    out.add_argument("--json", action="store_true", help="emit structured JSON")
    out.add_argument("--plain", action="store_true", help="emit only 'Artist — Title' lines")
    args = parser.parse_args()

    db = open_db(args.db)
    sessions = live_sessions(db)
    if not sessions:
        die("no history sessions found in the Rekordbox database")

    if args.list_sessions:
        for s in sessions:
            count = db.get_history_songs(HistoryID=s.ID).count()
            print(f"{str(getattr(s, 'DateCreated', '')):<26} {count:>3} tracks  {s.Name}")
        return

    if args.session:
        needle = args.session.lower()
        match = next((s for s in sessions if needle in (s.Name or "").lower()), None)
        if not match:
            die(f"no session matching {args.session!r}", "see `--list` for available sessions")
        session = match
    else:
        session = sessions[0]

    rows = session_tracklist(db, session)

    if args.json:
        print(json.dumps({"session": session.Name, "tracks": rows}, ensure_ascii=False, indent=2))
        return

    if args.plain:
        for row in rows:
            print(row["label"])
        return

    # Human-readable: play order, a DUP flag for repeats, load time dimmed as reference only.
    print(f"Session: {session.Name}  ({len(rows)} rows in load order)\n")
    width = max((len(r["label"]) for r in rows), default=0)
    for i, row in enumerate(rows, 1):
        flag = "  DUP" if row["duplicate"] else ""
        load = f"  (loaded {row['load_time'][11:19]})" if row["load_time"] else ""
        print(f"{i:>2}. {row['label']:<{width}}{flag}{load}")
    if any(r["duplicate"] for r in rows):
        print("\nDUP = this track appears more than once (a pre-load or re-load). Prune the spurious row by hand.")
    print("\nLoad times are deck-load times, NOT mix-in cues — reference only. See the script header.")


if __name__ == "__main__":
    main()
