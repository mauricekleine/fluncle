# /// script
# requires-python = ">=3.10"
# dependencies = ["pyrekordbox>=0.4"]
# ///
"""Sync your Rekordbox library's DJ-graded key + BPM into Fluncle's archive.

The operator's Rekordbox library is the ground truth for musical key: Rekordbox
analyses the WHOLE song and a DJ regularly hand-corrects it, whereas Fluncle's
enrichment DSP only ever hears a 30s preview and leaves `tracks.key` NULL below
its confidence floor (and its BPM/key estimator has documented mode/relative-key
confusion). This script reconciles the two on a PERIODIC schedule: it reads every
Rekordbox key + BPM, matches each to a Fluncle finding by normalized title+artist,
and writes the graded values back through the `fluncle` CLI's authenticated admin
update, stamped `--key-source rekordbox` / `--bpm-source rekordbox` so the
server-side source hierarchy (operator > rekordbox > DSP; apps/web track-update.ts)
protects them against a later agent-tier DSP pass.

This SUBSUMES the retired one-shot `fluncle-key-backfill` skill: the ported matcher
+ `normalize_key` live here verbatim, and the sync now covers BPM as well as key
and runs unattended on a weekly launchd timer, not just on a hand-triggered pass.

The RATIFIED diff rules:
  - KEY: propose the Rekordbox key ("<Note> major|minor") when the stored key
    DIFFERS, OR when it MATCHES but `keySource != "rekordbox"` (a protective stamp
    so a future DSP write can't clobber it). SKIP a row whose `keySource ==
    "operator"` — a hand-graded value always wins.
  - BPM: propose the Rekordbox BPM ONLY when the stored BPM is NULL, or when
    |stored - rb| > 0.5 (a big delta means the DSP value is stale-kept or the
    capture is suspect; a tiny delta is just rounding and is left alone). SKIP a row
    whose `bpmSource == "operator"`.
  - A finding whose Rekordbox matches DISAGREE (two graded copies with different
    keys, or BPMs more than the tolerance apart) is AMBIGUOUS: it is skipped and
    listed for the operator, never guessed.

Match discipline (ported from key_backfill.py, unchanged):
  - Rekordbox ISRC is unreliable, so matching is on normalized title+artist
    (case/accent-folded, `&`<->`and`, `feat.` credits dropped).
  - A REMIX / VIP / edit is a DIFFERENT recording with a different key/BPM, so its
    mix-descriptor is kept as part of the identity: "Song (Calibre Remix)" never
    matches the original "Song". Only same-descriptor pairs match.
  - An unrecognisable Rekordbox key normalizes to None and yields no key proposal.

Safety model:
  - DRY-RUN is the DEFAULT: it prints the diff and writes nothing. `--apply` writes.
  - `--max-writes N` (default 20) is a FUSE: if the proposed write count exceeds it,
    the run writes NOTHING and exits non-zero. A blown join or a mass Rekordbox
    re-grade must fail loudly for an unattended run, not half-apply.
  - The server-side hierarchy guard is the real backstop: even a buggy `--apply`
    can never overwrite an operator-graded value (the agent-tier guard drops it).

Prerequisites (one-time, on the M2 mixing Mac), identical to rekordbox-tracklist.py:
  1. Quit Rekordbox fully - it holds an exclusive lock on master.db.
  2. pyrekordbox auto-extracts the SQLCipher key from your Rekordbox install when it
     opens the database - no separate key step. (`python -m pyrekordbox download-key`
     was removed upstream at AlphaTheta's request; do not re-add it.)
     If auto-extraction ever fails, cache the key once:
       from pyrekordbox.config import write_db6_key_cache; write_db6_key_cache("<key>")
     or pass it directly: Rekordbox6Database(key="<key>")

The `fluncle` CLI must be on PATH and, for `--apply`, authenticated
(FLUNCLE_API_TOKEN) - the reads/writes go through the admin API, not the DB.

Usage:
  uv run rekordbox_sync.py                     # dry-run: propose, write nothing
  uv run rekordbox_sync.py --json              # dry-run, machine-readable summary
  uv run rekordbox_sync.py --apply             # perform the writes (after eyeballing)
  uv run rekordbox_sync.py --apply --quiet     # unattended: one-line summary + exit code
  uv run rekordbox_sync.py --apply --max-writes 40
  uv run rekordbox_sync.py --self-test         # run the pure-rule checks and exit
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
import unicodedata
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Key normalization - Rekordbox short notation -> the DSP's stored form.
#
# The DSP spells notes with SHARPS (analyze-track.ts `NOTES`), so every
# normalized key MUST use this exact spelling. Keep this array identical to it.
# (Ported verbatim from the retired fluncle-key-backfill/scripts/key_backfill.py.)
# ---------------------------------------------------------------------------

NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Natural-note -> semitone index into NOTES.
_SEMITONE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# Camelot / OpenKey-A/B code -> the DSP's final "<NOTE> <quality>" string. Rekordbox
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
    """Rekordbox `ScaleName` -> the DSP's stored "<NOTE> major/minor", or None.

    Handles classical short notation ("Am", "F", "Bbm", "C#m", "Gb"), enharmonic
    flats folded to the DSP's sharps ("Bbm" -> "A# minor"), unicode sharp/flat, and
    Camelot codes ("8A"). Anything it can't parse confidently returns None so the
    caller SKIPS it rather than writing a guess.
    """
    if raw is None:
        return None

    text = str(raw).strip()

    if not text:
        return None

    # Camelot / OpenKey-A/B (e.g. "8A", "12B") - resolve directly to the final form.
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
# Matching - normalized title + artist, with the mix-descriptor kept as identity.
# (Ported verbatim from key_backfill.py; also mirrored in the TS track-match.ts and
# the mixtapes _matching.py.)
# ---------------------------------------------------------------------------

# Words that mark a parenthetical / dash-suffix as a distinct VERSION of a track
# (a different recording, hence a different key). Their presence promotes the
# suffix to the match identity so a remix never folds onto the original.
_VERSION_WORDS = {
    "remix", "rmx", "vip", "edit", "bootleg", "rework", "refix", "flip",
    "dub", "version", "mix", "instrumental", "extended", "remaster",
}

# Suffixes that name a version but are NOT distinguishing - they are the original.
_NEUTRAL_DESCRIPTORS = {"original mix", "original", "extended mix"}

_ARTIST_SPLIT = re.compile(r"\s*(?:,|&|/|\band\b|\bx\b|\bvs\b|\bversus\b|\bwith\b)\s*")
_FEAT_INLINE = re.compile(r"\b(?:feat|ft|featuring)\b\.?.*$", re.IGNORECASE)
_PUNCT = re.compile(r"[^a-z0-9 ]+")
_WS = re.compile(r"\s+")


def _strip_accents(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def _fold(text: str) -> str:
    """Lowercase, strip accents, fold `&`->`and`, drop punctuation, collapse spaces."""
    folded = _strip_accents(text).lower().replace("&", " and ")
    folded = _PUNCT.sub(" ", folded)
    return _WS.sub(" ", folded).strip()


def _normalize_artists(artists: object) -> frozenset[str]:
    """A set of individual, folded artist names - order- and separator-agnostic.

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
    """(base_title, descriptor) - the base with feat./mix suffixes removed, plus the
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

        # A feat. credit in the title is not a version - drop it from the base.
        if re.match(r"^(?:feat|ft|featuring)\b", folded_inner):
            working = working[: match.start()] + working[match.end():]
            continue

        tokens = set(folded_inner.split())

        if tokens & _VERSION_WORDS:
            if folded_inner not in _NEUTRAL_DESCRIPTORS:
                descriptor = folded_inner
            working = working[: match.start()] + working[match.end():]
        else:
            # A non-version parenthetical (a subtitle) - drop it from the base but
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
# The diff rules (PURE - the unit-tested core).
# ---------------------------------------------------------------------------

# A stored BPM within this of the Rekordbox BPM is just rounding: left alone. A
# bigger delta means the DSP value is stale-kept or the capture is suspect - propose.
BPM_TOLERANCE = 0.5

# The provenance an agent (and this sync) must never overwrite. `operator` is a
# hand-graded value; the sync skips it. `rekordbox` is already ours (no re-stamp).
_OPERATOR_SOURCE = "operator"
_REKORDBOX_SOURCE = "rekordbox"


@dataclass
class RekordboxRow:
    """One Rekordbox content row: its identity fields + graded key/BPM."""

    artist: str
    title: str
    scale_name: str | None
    bpm: float | None
    normalized_key: str | None = None

    def __post_init__(self) -> None:
        if self.normalized_key is None:
            self.normalized_key = normalize_key(self.scale_name)


@dataclass
class Proposal:
    """A finding to update, carrying whichever of key/bpm changed (never neither)."""

    track_id: str
    artist: str
    title: str
    stored_key: str | None
    stored_bpm: float | None
    # The value to write + why, set only for the field(s) that changed.
    key: str | None = None
    key_reason: str | None = None  # "differ" | "stamp"
    bpm: float | None = None
    bpm_reason: str | None = None  # "fill" | "delta"

    def as_dict(self) -> dict:
        return {
            "trackId": self.track_id,
            "artist": self.artist,
            "title": self.title,
            "storedKey": self.stored_key,
            "storedBpm": self.stored_bpm,
            "key": self.key,
            "keyReason": self.key_reason,
            "bpm": self.bpm,
            "bpmReason": self.bpm_reason,
        }


@dataclass
class Ambiguous:
    """A finding whose Rekordbox matches disagree - skipped, listed for the operator."""

    track_id: str
    artist: str
    title: str
    field: str  # "key" | "bpm"
    detail: str

    def as_dict(self) -> dict:
        return {
            "trackId": self.track_id,
            "artist": self.artist,
            "title": self.title,
            "field": self.field,
            "detail": self.detail,
        }


@dataclass
class DiffStats:
    matched: int = 0
    unmatched: int = 0
    operator_skipped: int = 0
    unchanged: int = 0


@dataclass
class DiffResult:
    proposals: list[Proposal] = field(default_factory=list)
    ambiguous: list[Ambiguous] = field(default_factory=list)
    stats: DiffStats = field(default_factory=DiffStats)


def build_index(rekordbox_rows: list[RekordboxRow]) -> dict[tuple, list[RekordboxRow]]:
    """Group Rekordbox rows by their match identity for O(1) finding lookup."""
    index: dict[tuple, list[RekordboxRow]] = {}

    for row in rekordbox_rows:
        index.setdefault(match_key(row.artist, row.title), []).append(row)

    return index


def _finding_artist_label(artists: object) -> str:
    if isinstance(artists, (list, tuple)):
        return ", ".join(str(a) for a in artists)
    return str(artists or "")


def _distinct_keys(rows: list[RekordboxRow]) -> list[str]:
    return sorted({r.normalized_key for r in rows if r.normalized_key})


def _bpms(rows: list[RekordboxRow]) -> list[float]:
    return [r.bpm for r in rows if r.bpm is not None]


def compute_diff(
    fluncle_tracks: list[dict],
    rekordbox_rows: list[RekordboxRow],
) -> DiffResult:
    """Pair each Fluncle finding with its Rekordbox grade and apply the ratified rules.

    PURE + deterministic (the unit-tested core). Emits a Proposal for every finding
    that needs a key and/or BPM write, an Ambiguous entry for every finding whose
    Rekordbox copies disagree, and running counts. See the module docstring.
    """
    index = build_index(rekordbox_rows)
    result = DiffResult()

    for track in fluncle_tracks:
        title = str(track.get("title", ""))
        artists = track.get("artists", [])
        artist_label = _finding_artist_label(artists)
        track_id = str(track.get("trackId", ""))
        candidates = index.get(match_key(artists, title), [])

        if not candidates:
            result.stats.unmatched += 1
            continue

        result.stats.matched += 1

        stored_key = track.get("key")
        stored_bpm = track.get("bpm")
        key_source = track.get("keySource")
        bpm_source = track.get("bpmSource")

        proposal = Proposal(
            track_id=track_id,
            artist=artist_label,
            title=title,
            stored_key=stored_key,
            stored_bpm=stored_bpm,
        )
        touched_operator = False

        # ----- KEY -----
        if key_source == _OPERATOR_SOURCE:
            touched_operator = True  # a hand-graded key always wins - never touch it.
        else:
            distinct = _distinct_keys(candidates)

            if len(distinct) > 1:
                result.ambiguous.append(
                    Ambiguous(track_id, artist_label, title, "key", " | ".join(distinct))
                )
            elif len(distinct) == 1:
                rb_key = distinct[0]

                if stored_key != rb_key:
                    proposal.key = rb_key
                    proposal.key_reason = "differ"
                elif key_source != _REKORDBOX_SOURCE:
                    # Matches, but not yet stamped `rekordbox` - a protective stamp so a
                    # later DSP pass can't downgrade it (the value written == the stored).
                    proposal.key = rb_key
                    proposal.key_reason = "stamp"

        # ----- BPM -----
        if bpm_source == _OPERATOR_SOURCE:
            touched_operator = True
        else:
            bpms = _bpms(candidates)

            if bpms and (max(bpms) - min(bpms)) > BPM_TOLERANCE:
                detail = " | ".join(f"{b:g}" for b in sorted(set(bpms)))
                result.ambiguous.append(
                    Ambiguous(track_id, artist_label, title, "bpm", detail)
                )
            elif bpms:
                rb_bpm = bpms[0]

                if stored_bpm is None:
                    proposal.bpm = rb_bpm
                    proposal.bpm_reason = "fill"
                elif abs(float(stored_bpm) - rb_bpm) > BPM_TOLERANCE:
                    proposal.bpm = rb_bpm
                    proposal.bpm_reason = "delta"

        if proposal.key is not None or proposal.bpm is not None:
            result.proposals.append(proposal)
        else:
            if touched_operator:
                result.stats.operator_skipped += 1
            else:
                result.stats.unchanged += 1

    return result


def over_fuse(proposals: list[Proposal], max_writes: int) -> bool:
    """The write-count FUSE: a blown join / mass re-grade must fail loudly, not
    half-apply. One update call per proposed finding is the blast-radius unit."""
    return len(proposals) > max_writes


# ---------------------------------------------------------------------------
# Rekordbox read (impure; pyrekordbox lazily imported so the tests stay dep-free).
# ---------------------------------------------------------------------------


def die(message: str, hint: str | None = None) -> None:
    print(f"error: {message}", file=sys.stderr)

    if hint:
        print(f"  -> {hint}", file=sys.stderr)

    raise SystemExit(1)


def open_db(db_path: str | None):
    try:
        from pyrekordbox import Rekordbox6Database
    except ImportError:
        die("pyrekordbox is not installed", "run via `uv run` so the inline dependency is provided")

    try:
        return Rekordbox6Database(path=db_path) if db_path else Rekordbox6Database()
    except Exception as exc:  # noqa: BLE001 - surface pyrekordbox's own message verbatim
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


def _normalize_bpm(raw: object) -> float | None:
    """Rekordbox `DjmdContent.BPM` -> a human float. It stores BPM x100 (17400 =
    174.00 BPM); normalize back so it lines up with Fluncle's `tracks.bpm`. 0 -> None."""
    if not raw:
        return None

    value = float(raw)
    return round(value / 100, 2) if value >= 1000 else round(value, 2)


def read_rekordbox_rows(db) -> list[RekordboxRow]:
    """Every non-deleted Rekordbox content row carrying a key or a BPM, normalized."""
    rows: list[RekordboxRow] = []

    for content in db.get_content():
        if getattr(content, "rb_local_deleted", 0) == 1:
            continue

        key_obj = getattr(content, "Key", None)
        scale_name = getattr(key_obj, "ScaleName", None) if key_obj else None
        bpm = _normalize_bpm(getattr(content, "BPM", None))

        if not scale_name and bpm is None:
            continue

        title = getattr(content, "Title", None) or ""
        artist = getattr(getattr(content, "Artist", None), "Name", None) or getattr(
            content, "ArtistName", None
        ) or ""
        rows.append(
            RekordboxRow(
                artist=str(artist),
                title=str(title),
                scale_name=str(scale_name) if scale_name else None,
                bpm=bpm,
            )
        )

    return rows


def fetch_fluncle_archive(fluncle_bin: str) -> list[dict]:
    """The ENTIRE findings archive via `admin tracks list --all --json`.

    `--all` pages the whole catalogue via the cursor chain, past the per-request
    100-row cap - so an archive larger than 100 is never silently cut (the sync must
    see EVERY finding to propose protective stamps + BPM diffs, not just the missing-
    key tail). The admin path does NOT strip `keySource`/`bpmSource`, so the diff
    rules can read the provenance.

    The CLI's JSON stdout is written to a temp FILE, not captured through a pipe: an
    older `fluncle` binary truncates large stdout at the ~64KB OS pipe buffer when it
    exits (a Bun stdout-flush-on-exit bug fixed in 0.91.0). A regular file has no such
    cap, so the full archive always lands regardless of CLI version.
    """
    cmd = [fluncle_bin, "admin", "tracks", "list", "--all", "--json"]

    with tempfile.TemporaryFile("w+b") as out:
        try:
            subprocess.run(cmd, stdout=out, stderr=subprocess.PIPE, text=True, check=True)
        except FileNotFoundError:
            die(f"`{fluncle_bin}` not found on PATH", "install the fluncle CLI or pass --fluncle-bin")
        except subprocess.CalledProcessError as exc:
            die(f"`fluncle admin tracks list` failed: {(exc.stderr or '').strip() or exc}")
        out.seek(0)
        raw = out.read().decode("utf-8")

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        die("could not parse `fluncle admin tracks list --json` output")

    tracks = payload.get("tracks", []) if isinstance(payload, dict) else []
    return [t for t in tracks if isinstance(t, dict) and t.get("type") != "mixtape"]


def apply_proposal(fluncle_bin: str, proposal: Proposal) -> tuple[bool, str]:
    """Write one finding's changed key/BPM via the CLI's authenticated admin update.

    A SINGLE `update` call carries whichever fields changed, each stamped with its
    `rekordbox` source so the server hierarchy guard protects it. (ok, detail)."""
    cmd = [fluncle_bin, "admin", "tracks", "update", proposal.track_id]

    if proposal.key is not None:
        cmd += ["--key", proposal.key, "--key-source", _REKORDBOX_SOURCE]

    if proposal.bpm is not None:
        cmd += ["--bpm", f"{proposal.bpm:g}", "--bpm-source", _REKORDBOX_SOURCE]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    except subprocess.CalledProcessError as exc:
        return False, (exc.stderr.strip() or str(exc))

    return True, result.stdout.strip()


# ---------------------------------------------------------------------------
# Output.
# ---------------------------------------------------------------------------


def _key_cell(p: Proposal) -> str:
    if p.key is None:
        return "-"

    old = p.stored_key or "(null)"
    if p.key_reason == "stamp":
        return f'"{p.key}" (stamp)'
    return f'"{old}" -> "{p.key}"'


def _bpm_cell(p: Proposal) -> str:
    if p.bpm is None:
        return "-"

    old = f"{p.stored_bpm:g}" if p.stored_bpm is not None else "(null)"
    return f"{old} -> {p.bpm:g}"


def summary_dict(result: DiffResult, mode: str, applied: list[dict], rb_count: int) -> dict:
    return {
        "mode": mode,
        "rekordboxRows": rb_count,
        "matched": result.stats.matched,
        "unmatched": result.stats.unmatched,
        "operatorSkipped": result.stats.operator_skipped,
        "unchanged": result.stats.unchanged,
        "proposals": [p.as_dict() for p in result.proposals],
        "ambiguous": [a.as_dict() for a in result.ambiguous],
        "applied": applied,
    }


def print_human(result: DiffResult, apply: bool, applied: list[dict], rb_count: int) -> None:
    print(
        f"Rekordbox rows read: {rb_count}  |  matched findings: {result.stats.matched}  "
        f"|  no Rekordbox match: {result.stats.unmatched}\n"
    )

    if result.proposals:
        print(f"Proposed ({len(result.proposals)}):")
        width = max((len(f"{p.artist} - {p.title}") for p in result.proposals), default=0)
        for p in result.proposals:
            label = f"{p.artist} - {p.title}"
            print(f"  {label:<{width}}   key: {_key_cell(p):<24} bpm: {_bpm_cell(p)}")
        print()

    if result.ambiguous:
        print(f"Ambiguous ({len(result.ambiguous)}) - NOT written, resolve by hand:")
        for a in result.ambiguous:
            print(f"  [{a.field}] {a.artist} - {a.title}  ({a.detail})")
        print()

    print(
        f"Operator-graded (skipped): {result.stats.operator_skipped}  "
        f"|  already in sync: {result.stats.unchanged}"
    )

    if apply:
        ok_count = sum(1 for a in applied if a["ok"])
        print(f"\nApplied {ok_count}/{len(applied)} writes.")
        for a in applied:
            if not a["ok"]:
                print(f"  write FAILED for {a['trackId']}: {a['detail']}")
    else:
        print("\nDRY RUN - nothing written. Re-run with --apply to write the proposals above.")


# ---------------------------------------------------------------------------
# Self-test (a pure-rule check runnable without pyrekordbox or the CLI).
# ---------------------------------------------------------------------------


def _self_test() -> int:
    """A dependency-free smoke over the diff rules; mirrors test_sync_rules.py.

    Returns a process exit code so `--self-test` doubles as CI when pytest isn't
    handy. The full parametrized suite lives in scripts/test_sync_rules.py."""
    failures: list[str] = []

    def check(name: str, cond: bool) -> None:
        if not cond:
            failures.append(name)

    def rb(artist, title, scale, bpm):
        return RekordboxRow(artist=artist, title=title, scale_name=scale, bpm=bpm)

    def one(track, rows):
        return compute_diff([track], rows)

    # operator key is never touched.
    r = one(
        {"trackId": "t", "title": "Song", "artists": ["A"], "key": "A minor",
         "keySource": "operator", "bpm": None, "bpmSource": None},
        [rb("A", "Song", "Gm", 174.0)],
    )
    check("operator key skipped", all(p.key is None for p in r.proposals))
    check("operator key still fills bpm", any(p.bpm == 174.0 for p in r.proposals))

    # protective stamp: matches but source not rekordbox.
    r = one(
        {"trackId": "t", "title": "Song", "artists": ["A"], "key": "A minor",
         "keySource": "dsp", "bpm": 174.0, "bpmSource": "dsp"},
        [rb("A", "Song", "Am", 174.0)],
    )
    check("protective stamp", len(r.proposals) == 1 and r.proposals[0].key_reason == "stamp")

    # already rekordbox + matching -> no proposal.
    r = one(
        {"trackId": "t", "title": "Song", "artists": ["A"], "key": "A minor",
         "keySource": "rekordbox", "bpm": 174.0, "bpmSource": "rekordbox"},
        [rb("A", "Song", "Am", 174.0)],
    )
    check("in-sync no-op", not r.proposals and r.stats.unchanged == 1)

    # bpm fills only on null or big delta.
    r = one(
        {"trackId": "t", "title": "Song", "artists": ["A"], "key": None,
         "keySource": None, "bpm": None, "bpmSource": None},
        [rb("A", "Song", None, 172.0)],
    )
    check("bpm fill on null", len(r.proposals) == 1 and r.proposals[0].bpm == 172.0)

    r = one(
        {"trackId": "t", "title": "Song", "artists": ["A"], "key": "A minor",
         "keySource": "rekordbox", "bpm": 174.2, "bpmSource": "dsp"},
        [rb("A", "Song", "Am", 174.0)],
    )
    check("bpm within tolerance no-op", not any(p.bpm is not None for p in r.proposals))

    r = one(
        {"trackId": "t", "title": "Song", "artists": ["A"], "key": "A minor",
         "keySource": "rekordbox", "bpm": 87.0, "bpmSource": "dsp"},
        [rb("A", "Song", "Am", 174.0)],
    )
    check("bpm delta proposes", any(p.bpm == 174.0 for p in r.proposals))

    # ambiguous rekordbox key -> skipped + listed.
    r = one(
        {"trackId": "t", "title": "Song", "artists": ["A"], "key": None,
         "keySource": None, "bpm": None, "bpmSource": None},
        [rb("A", "Song", "Am", None), rb("A", "Song", "Gm", None)],
    )
    check("ambiguous key skipped", not r.proposals and any(a.field == "key" for a in r.ambiguous))

    # max-writes fuse.
    props = [Proposal("t1", "", "", None, None, key="A minor", key_reason="differ")]
    check("under fuse", not over_fuse(props, 20))
    check("over fuse", over_fuse(props * 21, 20))

    if failures:
        print("SELF-TEST FAILED:", ", ".join(failures), file=sys.stderr)
        return 1

    print("self-test OK (9 checks)")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Sync Rekordbox DJ-graded key + BPM into Fluncle (dry-run by default)."
    )
    parser.add_argument("--db", help="path to the Rekordbox master.db (default: auto-detect)")
    parser.add_argument(
        "--fluncle-bin", default="fluncle", help="the fluncle CLI to shell out to (default: fluncle)"
    )
    parser.add_argument("--json", action="store_true", help="emit the machine-readable summary")
    parser.add_argument("--quiet", action="store_true", help="one-line summary (for unattended --apply)")
    parser.add_argument(
        "--max-writes", type=int, default=20,
        help="FUSE: if proposals exceed this, write nothing + exit non-zero (default 20)",
    )
    parser.add_argument("--self-test", action="store_true", help="run the pure-rule checks and exit")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run", action="store_true", help="propose only, write nothing (the DEFAULT)"
    )
    mode.add_argument("--apply", action="store_true", help="perform the writes after eyeballing")
    args = parser.parse_args()

    if args.self_test:
        raise SystemExit(_self_test())

    apply = args.apply  # dry-run is the default; --apply is the only way to write.

    fluncle_tracks = fetch_fluncle_archive(args.fluncle_bin)
    db = open_db(args.db)
    rekordbox_rows = read_rekordbox_rows(db)
    result = compute_diff(fluncle_tracks, rekordbox_rows)

    # The FUSE: a blown join / mass re-grade must fail loudly, never half-apply.
    if over_fuse(result.proposals, args.max_writes):
        message = (
            f"{len(result.proposals)} proposed writes exceed --max-writes {args.max_writes}: "
            "writing nothing. Eyeball the diff (a blown match or a mass Rekordbox re-grade?), "
            "then raise --max-writes if it is genuinely all correct."
        )

        if args.json:
            print(json.dumps(
                {**summary_dict(result, "blocked", [], len(rekordbox_rows)), "error": message},
                ensure_ascii=False, indent=2,
            ))
        else:
            print(f"error: {message}", file=sys.stderr)

        raise SystemExit(1)

    applied: list[dict] = []
    exit_code = 0

    if apply:
        for proposal in result.proposals:
            ok, detail = apply_proposal(args.fluncle_bin, proposal)
            applied.append({"trackId": proposal.track_id, "ok": ok, "detail": detail})
            if not ok:
                exit_code = 1

    if args.json:
        print(json.dumps(
            summary_dict(result, "apply" if apply else "dry-run", applied, len(rekordbox_rows)),
            ensure_ascii=False, indent=2,
        ))
        raise SystemExit(exit_code)

    if args.quiet:
        ok_count = sum(1 for a in applied if a["ok"])
        verb = f"wrote {ok_count}/{len(applied)}" if apply else f"{len(result.proposals)} proposed (dry-run)"
        print(
            f"rekordbox-sync: {verb}; "
            f"{len(result.ambiguous)} ambiguous; {result.stats.operator_skipped} operator-skipped"
        )
        raise SystemExit(exit_code)

    print_human(result, apply, applied, len(rekordbox_rows))
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
