# /// script
# requires-python = ">=3.10"
# dependencies = ["pytest>=8"]
# ///
"""Unit tests for the pure normalizer + matcher in key_backfill.py.

Run:  uv run --with pytest pytest packages/skills/fluncle-key-backfill/scripts/test_key_backfill.py

The module is imported by path so pytest never needs pyrekordbox (key_backfill.py
imports it lazily, inside open_db, so top-level import here is dependency-free).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "key_backfill", Path(__file__).with_name("key_backfill.py")
)
assert _spec and _spec.loader
kb = importlib.util.module_from_spec(_spec)
# Register before exec so dataclass field-type resolution can find the module.
sys.modules["key_backfill"] = kb
_spec.loader.exec_module(kb)


# ── normalize_key — every one of the 24 keys, sharp spelling, enharmonics ──

@pytest.mark.parametrize(
    "raw,expected",
    [
        # All 12 naturals + sharps, major (no suffix).
        ("C", "C major"),
        ("C#", "C# major"),
        ("D", "D major"),
        ("D#", "D# major"),
        ("E", "E major"),
        ("F", "F major"),
        ("F#", "F# major"),
        ("G", "G major"),
        ("G#", "G# major"),
        ("A", "A major"),
        ("A#", "A# major"),
        ("B", "B major"),
        # All 12 minors ("m" suffix).
        ("Cm", "C minor"),
        ("C#m", "C# minor"),
        ("Dm", "D minor"),
        ("D#m", "D# minor"),
        ("Em", "E minor"),
        ("Fm", "F minor"),
        ("F#m", "F# minor"),
        ("Gm", "G minor"),
        ("G#m", "G# minor"),
        ("Am", "A minor"),
        ("A#m", "A# minor"),
        ("Bm", "B minor"),
    ],
)
def test_normalize_all_24_keys(raw, expected):
    assert kb.normalize_key(raw) == expected


@pytest.mark.parametrize(
    "raw,expected",
    [
        # Enharmonic FLATS fold to the DSP's SHARP spelling.
        ("Bbm", "A# minor"),
        ("Bb", "A# major"),
        ("Db", "C# major"),
        ("Dbm", "C# minor"),
        ("Eb", "D# major"),
        ("Ebm", "D# minor"),
        ("Gb", "F# major"),
        ("Gbm", "F# minor"),
        ("Ab", "G# major"),
        ("Abm", "G# minor"),
        # Wrap-around + naturals-as-accidentals.
        ("Cb", "B major"),
        ("Fb", "E major"),
        ("E#", "F major"),
        ("B#", "C major"),
        # Unicode accidentals + whitespace + spelled-out qualities.
        ("A♭m", "G# minor"),
        ("A♯", "A# major"),
        ("  Am  ", "A minor"),
        ("A min", "A minor"),
        ("A minor", "A minor"),
        ("A maj", "A major"),
        ("A major", "A major"),
        # Lowercase root.
        ("am", "A minor"),
        ("f#m", "F# minor"),
    ],
)
def test_normalize_enharmonics_and_forms(raw, expected):
    assert kb.normalize_key(raw) == expected


@pytest.mark.parametrize(
    "code,expected",
    [
        ("8A", "A minor"), ("8B", "C major"),
        ("1A", "G# minor"), ("1B", "B major"),
        ("11A", "F# minor"), ("12B", "E major"),
        ("5A", "C minor"), ("6B", "A# major"),
    ],
)
def test_normalize_camelot(code, expected):
    assert kb.normalize_key(code) == expected


@pytest.mark.parametrize("raw", [None, "", "   ", "H", "xyz", "13A", "0B", "??", "Am7b5nonsense"])
def test_normalize_unknown_is_none(raw):
    # Unknown / unparseable → None so the caller SKIPS rather than guessing.
    assert kb.normalize_key(raw) is None


def test_camelot_covers_all_24():
    # Every Camelot code resolves, and the 24 targets are all distinct keys.
    values = set(kb._CAMELOT.values())
    assert len(kb._CAMELOT) == 24
    assert len(values) == 24


# ── match_key — folding + the remix false-match guard ──

def test_match_case_accent_and_ampersand_fold():
    a = kb.match_key(["Café Del Mar"], "Túnel")
    b = kb.match_key("cafe del mar", "tunel")
    assert a == b

    # `&` ↔ `and`, artist order/separator agnostic.
    assert kb.match_key("A & B", "Song") == kb.match_key(["B", "A"], "Song")
    assert kb.match_key("A and B", "Song") == kb.match_key("B & A", "Song")


def test_match_drops_feat_credits():
    assert kb.match_key(["Whiney"], "Teddy's Gate (feat. LaMeduza)") == kb.match_key(
        "Whiney feat. LaMeduza", "Teddy's Gate"
    )
    assert kb.match_key(["Whiney"], "Teddy's Gate") == kb.match_key(
        ["Whiney"], "Teddy's Gate feat. LaMeduza"
    )


def test_remix_false_match_guard():
    original = kb.match_key(["Calibre"], "Mr Majestic")
    remix = kb.match_key(["Calibre"], "Mr Majestic (Sub Focus Remix)")
    vip = kb.match_key(["Calibre"], "Mr Majestic (VIP)")
    dash_remix = kb.match_key(["Calibre"], "Mr Majestic - Sub Focus Remix")

    # A remix / VIP is a DIFFERENT recording — it must NOT collapse onto the original.
    assert original != remix
    assert original != vip
    assert remix != vip
    # Dash- and paren-notation of the SAME remix are the same identity.
    assert remix == dash_remix


def test_original_mix_is_neutral_descriptor():
    # "(Original Mix)" is not a distinguishing version — it equals the bare title.
    assert kb.match_key(["Artist"], "Song") == kb.match_key(["Artist"], "Song (Original Mix)")
    assert kb.match_key(["Artist"], "Song") == kb.match_key(["Artist"], "Song (Original)")


def test_non_version_subtitle_does_not_split():
    # A non-version parenthetical (a subtitle) folds to the base — a stored/absent
    # subtitle still matches; it is not a different recording key.
    assert kb.match_key(["Artist"], "Song") == kb.match_key(["Artist"], "Song (Interlude)")


# ── reconcile — proposal / ambiguous / unknown-key / unmatched ──

def _rk(artist, title, scale_name):
    return kb.RekordboxKey(
        artist=artist, title=title, scale_name=scale_name, normalized=kb.normalize_key(scale_name)
    )


def test_reconcile_single_match_proposes():
    tracks = [{"trackId": "t1", "title": "Teddy's Gate", "artists": ["Whiney"]}]
    rk = [_rk("Whiney", "Teddy's Gate", "Am")]
    proposals, flagged, unmatched = kb.reconcile(tracks, rk)

    assert len(proposals) == 1
    assert proposals[0].track_id == "t1"
    assert proposals[0].normalized == "A minor"
    assert proposals[0].scale_name == "Am"
    assert not flagged
    assert not unmatched


def test_reconcile_remix_is_not_matched_to_original():
    tracks = [{"trackId": "t1", "title": "Mr Majestic", "artists": ["Calibre"]}]
    # Rekordbox only has the REMIX — must not fill the original's key.
    rk = [_rk("Calibre", "Mr Majestic (Sub Focus Remix)", "Gm")]
    proposals, flagged, unmatched = kb.reconcile(tracks, rk)

    assert not proposals
    assert len(unmatched) == 1


def test_reconcile_ambiguous_when_keys_disagree():
    tracks = [{"trackId": "t1", "title": "Song", "artists": ["Artist"]}]
    rk = [_rk("Artist", "Song", "Am"), _rk("Artist", "Song", "Gm")]
    proposals, flagged, unmatched = kb.reconcile(tracks, rk)

    assert not proposals
    assert len(flagged) == 1
    assert flagged[0].reason == "ambiguous"


def test_reconcile_same_key_dupes_still_propose():
    tracks = [{"trackId": "t1", "title": "Song", "artists": ["Artist"]}]
    # Two Rekordbox rows, same normalized key (e.g. Am and its enharmonic aren't
    # both here — both resolve to A minor) → still a clean single proposal.
    rk = [_rk("Artist", "Song", "Am"), _rk("Artist", "Song", "am")]
    proposals, flagged, unmatched = kb.reconcile(tracks, rk)

    assert len(proposals) == 1
    assert proposals[0].normalized == "A minor"
    assert not flagged


def test_reconcile_unknown_key_flagged_not_written():
    tracks = [{"trackId": "t1", "title": "Song", "artists": ["Artist"]}]
    rk = [_rk("Artist", "Song", "H7#garbage")]
    proposals, flagged, unmatched = kb.reconcile(tracks, rk)

    assert not proposals
    assert len(flagged) == 1
    assert flagged[0].reason == "unknown-key"


def test_reconcile_no_match_left_null():
    tracks = [{"trackId": "t1", "title": "Unknown Track", "artists": ["Nobody"]}]
    rk = [_rk("Whiney", "Teddy's Gate", "Am")]
    proposals, flagged, unmatched = kb.reconcile(tracks, rk)

    assert not proposals
    assert not flagged
    assert len(unmatched) == 1
