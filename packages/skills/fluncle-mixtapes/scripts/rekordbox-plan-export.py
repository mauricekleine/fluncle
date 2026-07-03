# /// script
# requires-python = ">=3.10"
# dependencies = ["pyrekordbox>=0.4"]
# ///
"""Export a Fluncle plan's cue tracklist into every tool the operator needs.

Reads a plan recording's cues from the Fluncle admin API
(`fluncle admin recordings get <planId> --json`), then:

  1. **Rekordbox playlist (direct DB write — the star).**
     Opens `MasterDatabase`, finds each finding in the local collection by
     normalized title+artist (the same matcher as rekordbox-derive-cues), creates
     a playlist named with the plan's slug, adds matched tracks in order, and
     commits.  A separate "Fluncle Plans" folder is created/reused as the parent.

  2. **Rekordbox XML (safe no-write fallback).**
     Emits a `<slug>.xml` file the operator can import into Rekordbox via
     File → Import Playlist, without touching the encrypted master.db at all.
     Uses matched tracks from the local collection; unmatched are skipped.

  3. **Beatport search links** — one URL per track; opens in the browser or
     paste into a note to buy.

  4. **m3u8** — ordered reference list (metadata only, no file paths).

  5. **Checklist** — plain numbered list, paste anywhere.

Safety guards:
  - The script PRINTS a clear instruction to quit Rekordbox before running,
    and ASKS for confirmation before writing to master.db (step 1).
  - master.db is backed up to `master.db.bak-<timestamp>` before any write.
  - Pass `--no-db-write` to skip the DB write and emit only the text formats.
  - The XML export (step 2) never writes to master.db.

Prerequisites (one-time, on this Mac):
  1. Quit Rekordbox fully — it holds an exclusive lock on master.db.
  2. Cache the SQLCipher key once:
       uv run --with pyrekordbox python -m pyrekordbox download-key

Usage:
  uv run rekordbox-plan-export.py <planId>
  uv run rekordbox-plan-export.py <planId> --no-db-write   # text formats only
  uv run rekordbox-plan-export.py <planId> --yes           # skip the confirmation prompt
  uv run rekordbox-plan-export.py <planId> --xml <out.xml> # custom XML output path
  uv run rekordbox-plan-export.py <planId> --json          # JSON summary
  uv run rekordbox-plan-export.py <planId> --fluncle-bin ./fluncle
  uv run rekordbox-plan-export.py <planId> --db /path/to/master.db
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))

from _cue_formats import beatport_search_links, checklist, m3u8  # noqa: E402
from _matching import match_key  # noqa: E402

# The Rekordbox playlist folder under which all Fluncle plan playlists live.
_FLUNCLE_FOLDER_NAME = "Fluncle Plans"


# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------


def die(message: str, hint: str | None = None) -> None:
    print(f"error: {message}", file=sys.stderr)
    if hint:
        print(f"  → {hint}", file=sys.stderr)
    raise SystemExit(1)


def confirm(prompt: str) -> bool:
    """Ask the operator for a yes/no confirmation.  Returns True for yes."""
    try:
        answer = input(f"{prompt} [y/N] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return False
    return answer in ("y", "yes")


# ---------------------------------------------------------------------------
# Fluncle API.
# ---------------------------------------------------------------------------


def fetch_plan(fluncle_bin: str, plan_id: str) -> dict:
    """Fetch a recording's full DTO via `fluncle admin recordings get <id> --json`."""
    cmd = [fluncle_bin, "admin", "recordings", "get", plan_id, "--json"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    except FileNotFoundError:
        die(
            f"`{fluncle_bin}` not found on PATH",
            "install the fluncle CLI or pass --fluncle-bin",
        )
    except subprocess.CalledProcessError as exc:
        die(f"`fluncle admin recordings get` failed: {exc.stderr.strip() or exc}")

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        die("could not parse `fluncle admin recordings get --json` output")

    recording = payload.get("recording") if isinstance(payload, dict) else None
    if not recording or not isinstance(recording, dict):
        die(f"no recording found for id {plan_id!r}")

    return recording


# ---------------------------------------------------------------------------
# Rekordbox DB helpers.
# ---------------------------------------------------------------------------


def open_db(db_path: str | None):
    try:
        from pyrekordbox import MasterDatabase
    except ImportError:
        die(
            "pyrekordbox is not installed",
            "run via `uv run` so the inline dependency is provided",
        )

    try:
        return MasterDatabase(path=db_path) if db_path else MasterDatabase()
    except Exception as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if "key" in msg:
            die(
                "no decryption key for the Rekordbox database",
                "run once: uv run --with pyrekordbox python -m pyrekordbox download-key",
            )
        if "locked" in msg or "running" in msg:
            die("the Rekordbox database is locked", "quit Rekordbox fully, then retry")
        die(f"could not open the Rekordbox database: {exc}")


def backup_db(db) -> str:
    """Back up master.db next to itself with a timestamp suffix."""
    db_path = getattr(db, "db_dir", None) or getattr(db, "_db_dir", None)
    if db_path:
        master = os.path.join(str(db_path), "master.db")
    else:
        # Fallback: look for master.db in the default location.
        master = os.path.expanduser(
            "~/Library/Pioneer/rekordbox/master.db"
        )

    if not os.path.exists(master):
        return "(could not locate master.db to back up)"

    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = f"{master}.bak-{ts}"
    shutil.copy2(master, backup_path)
    return backup_path


def build_collection_index(db) -> dict[tuple, list]:
    """Map match_key → [DjmdContent, ...] for every non-deleted track in the collection."""
    index: dict[tuple, list] = {}
    for content in db.get_content():
        if getattr(content, "rb_local_deleted", 0) == 1:
            continue
        title = str(getattr(content, "Title", None) or "")
        artist = (
            getattr(getattr(content, "Artist", None), "Name", None)
            or getattr(content, "ArtistName", None)
            or ""
        )
        key = match_key(str(artist), title)
        index.setdefault(key, []).append(content)
    return index


def match_cues_to_collection(
    cues: list[dict], index: dict[tuple, list]
) -> list[tuple[dict, object | None, str]]:
    """Return list of (cue_dict, DjmdContent_or_None, match_reason).

    match_reason is "matched" | "ambiguous" | "unmatched".
    """
    results: list[tuple[dict, object | None, str]] = []
    for cue in cues:
        artists: list[str] = cue.get("artists", [])
        title: str = cue.get("title", "")
        key = match_key(artists, title)
        candidates = index.get(key, [])
        if len(candidates) == 1:
            results.append((cue, candidates[0], "matched"))
        elif len(candidates) > 1:
            results.append((cue, candidates[0], "ambiguous"))
        else:
            results.append((cue, None, "unmatched"))
    return results


# ---------------------------------------------------------------------------
# Rekordbox XML export (safe no-write fallback).
# ---------------------------------------------------------------------------


def export_xml(
    slug: str,
    matched_results: list[tuple[dict, object | None, str]],
    out_path: str,
) -> int:
    """Write a Rekordbox XML file the operator can import via File → Import Playlist.

    Only tracks that matched the collection are included (unmatched are skipped
    since we have no reliable file path for them).  Returns the number of tracks
    written.
    """
    try:
        from pyrekordbox.rbxml import RekordboxXml
    except ImportError:
        die("pyrekordbox is not installed")

    # Create a fresh XML database.
    xml = RekordboxXml()
    folder = xml.add_playlist_folder(_FLUNCLE_FOLDER_NAME)
    playlist = folder.add_playlist(slug)

    n_added = 0
    for _cue, content, reason in matched_results:
        if content is None:
            continue

        # Construct the local file path from the content row.
        folder_path = str(getattr(content, "FolderPath", "") or "")
        file_name = str(getattr(content, "FileName", "") or "")
        local_path = folder_path + file_name

        artist = (
            getattr(getattr(content, "Artist", None), "Name", None)
            or getattr(content, "ArtistName", None)
            or ""
        )
        title = str(getattr(content, "Title", None) or "")
        bpm_raw = getattr(content, "BPM", None)
        bpm_str: str | None = None
        if bpm_raw is not None:
            try:
                bpm_str = f"{int(bpm_raw) / 100:.2f}"
            except (TypeError, ValueError):
                pass

        xml_track = xml.add_track(local_path, Name=title, Artist=str(artist))
        if bpm_str:
            xml_track["BPM"] = bpm_str
        playlist.add_track(xml_track.TrackID)
        n_added += 1

    xml.save(out_path)
    return n_added


# ---------------------------------------------------------------------------
# Direct Rekordbox DB write.
# ---------------------------------------------------------------------------


def write_playlist(
    db,
    slug: str,
    matched_results: list[tuple[dict, object | None, str]],
) -> dict:
    """Create a playlist in `master.db` and add matched tracks.

    Returns a summary dict: {playlist_id, n_added, n_skipped, skipped_labels}.
    """
    # Find or create the Fluncle Plans folder.
    folder = None
    for pl in db.get_playlist():
        if (
            getattr(pl, "Name", None) == _FLUNCLE_FOLDER_NAME
            and getattr(pl, "Attribute", None) == 1  # 1 = folder
        ):
            folder = pl
            break

    if folder is None:
        folder = db.create_playlist_folder(_FLUNCLE_FOLDER_NAME)

    # Create the plan playlist (overwrite if it already exists to stay idempotent).
    existing = None
    for pl in db.get_playlist():
        if (
            getattr(pl, "Name", None) == slug
            and getattr(pl, "ParentID", None) == getattr(folder, "ID", None)
        ):
            existing = pl
            break

    if existing is not None:
        # Delete and re-create so the playlist is a clean slate.
        db.delete_playlist(existing)

    playlist = db.create_playlist(slug, parent=folder)

    n_added = 0
    n_skipped = 0
    skipped_labels: list[str] = []

    for cue, content, reason in matched_results:
        label = f"{', '.join(cue.get('artists', []))} — {cue.get('title', '')}"
        if content is None or reason == "unmatched":
            n_skipped += 1
            skipped_labels.append(f"{label} (unmatched)")
            continue
        if reason == "ambiguous":
            # Use the first candidate but warn.
            skipped_labels.append(f"{label} (ambiguous — used first candidate)")

        db.add_to_playlist(playlist, content)
        n_added += 1

    db.commit()

    return {
        "playlist_id": str(getattr(playlist, "ID", "?")),
        "n_added": n_added,
        "n_skipped": n_skipped,
        "skipped_labels": skipped_labels,
    }


# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Export a Fluncle plan's cue tracklist to Rekordbox + Beatport + m3u8."
    )
    parser.add_argument("plan_id", help="The plan recording's id (from `fluncle admin recordings list --kind plan`)")
    parser.add_argument("--db", help="Path to the Rekordbox master.db (default: auto-detect)")
    parser.add_argument(
        "--fluncle-bin",
        default="fluncle",
        help="The fluncle CLI to use (default: fluncle)",
    )
    parser.add_argument(
        "--no-db-write",
        dest="no_db_write",
        action="store_true",
        help="Skip the direct Rekordbox DB write; emit text formats only",
    )
    parser.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="Skip the confirmation prompt before writing to master.db",
    )
    parser.add_argument(
        "--xml",
        metavar="PATH",
        help="Path for the Rekordbox XML export (default: <slug>.xml)",
    )
    parser.add_argument("--json", dest="json_out", action="store_true", help="JSON summary output")
    args = parser.parse_args()

    # 1. Fetch the plan.
    recording = fetch_plan(args.fluncle_bin, args.plan_id)
    slug: str = str(recording.get("title", args.plan_id))
    tracklist: list[dict] = recording.get("tracklist", [])
    has_video: bool = bool(recording.get("hasVideo", False))

    if not args.json_out:
        print(f"Plan: {slug}  ({len(tracklist)} cue{'s' if len(tracklist) != 1 else ''})")
        if has_video:
            print("  (this recording has a video — is it a TAKE, not a PLAN?)")
        print()

    if not tracklist:
        if not args.json_out:
            print("No cues on this plan yet.  Add findings first.")
        else:
            print(json.dumps({"ok": False, "reason": "no_cues", "slug": slug}, indent=2))
        return

    # Normalize cue shapes — the DTO has `artists: string[]` and `title: str`.
    # We need `artists` as a list for the formatters.
    cues: list[dict] = []
    for item in tracklist:
        artists = item.get("artists", [])
        if isinstance(artists, str):
            artists = [a.strip() for a in artists.split(",")]
        cues.append(
            {
                "artists": [str(a) for a in artists],
                "title": str(item.get("title", "")),
                "id": item.get("id"),
                "startMs": item.get("startMs"),
            }
        )

    # 2. Text formats — always emitted.
    beatport_urls = beatport_search_links(cues)
    m3u8_str = m3u8(cues, title=slug)
    checklist_str = checklist(cues)

    # 3. Rekordbox export — open the DB (needed for both the direct write and XML).
    do_db_write = not args.no_db_write

    xml_path = args.xml or f"{slug}.xml"

    if not args.json_out:
        print("─── Beatport search links ───────────────────────────────")
        for url in beatport_urls:
            print(f"  {url}")
        print()
        print("─── m3u8 reference list ─────────────────────────────────")
        print(m3u8_str)
        print()
        print("─── Checklist ───────────────────────────────────────────")
        print(checklist_str)
        print()

    # Rekordbox section.
    db_result: dict = {}
    xml_result: dict = {}

    if do_db_write:
        print("─── Rekordbox ───────────────────────────────────────────")
        print()
        print("  IMPORTANT: Rekordbox must be FULLY QUIT before continuing.")
        print("  The script writes to the encrypted master.db; a running")
        print("  Rekordbox will lock the file and may corrupt data.")
        print()

        if not args.yes and not confirm(f"  Continue and create playlist '{slug}' in master.db?"):
            print("  Aborted.  Re-run with --no-db-write to emit text formats only.")
            return

        print()

    try:
        db = open_db(args.db)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        if do_db_write:
            raise
        if not args.json_out:
            print(f"  (could not open master.db — skipping Rekordbox export: {exc})")
        db = None

    if db is not None:
        index = build_collection_index(db)
        matched = match_cues_to_collection(cues, index)

        if do_db_write:
            # Back up the DB before writing.
            backup_path = backup_db(db)
            if not args.json_out:
                print(f"  Backed up master.db → {backup_path}")

            result = write_playlist(db, slug, matched)
            db_result = result

            if not args.json_out:
                n = result["n_added"]
                s = result["n_skipped"]
                print(f"  Created playlist '{slug}' in '{_FLUNCLE_FOLDER_NAME}' — {n} tracks added, {s} skipped.")
                for label in result["skipped_labels"]:
                    print(f"    ⚠ {label}")
                print()
                print("  Re-open Rekordbox to see the playlist.")
                print()

        # Always emit the XML (safe no-write fallback).
        n_xml = export_xml(slug, matched, xml_path)
        xml_result = {"path": xml_path, "n_tracks": n_xml}

        if not args.json_out:
            print(f"  XML exported → {xml_path}  ({n_xml} tracks)")
            print(
                "  Import into Rekordbox: File → Import Playlist → rekordbox xml → "
                f"{xml_path}"
            )
            print()

    if args.json_out:
        print(
            json.dumps(
                {
                    "ok": True,
                    "planId": args.plan_id,
                    "slug": slug,
                    "cueCount": len(cues),
                    "beatportLinks": beatport_urls,
                    "m3u8": m3u8_str,
                    "checklist": checklist_str,
                    "rekordboxDb": db_result,
                    "rekordboxXml": xml_result,
                },
                ensure_ascii=False,
                indent=2,
            )
        )


if __name__ == "__main__":
    main()
