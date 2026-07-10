# /// script
# requires-python = ">=3.10"
# dependencies = ["pytest>=8"]
# ///
"""Unit tests for the pure diff rules + matcher in rekordbox_sync.py.

Run:  uv run --with pytest pytest packages/skills/fluncle-rekordbox-sync/scripts/test_sync_rules.py

The module is imported by path so pytest never needs pyrekordbox (rekordbox_sync.py
imports it lazily, inside open_db, so the top-level import here is dependency-free).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "rekordbox_sync", Path(__file__).with_name("rekordbox_sync.py")
)
assert _spec and _spec.loader
rs = importlib.util.module_from_spec(_spec)
# Register before exec so dataclass field-type resolution can find the module.
sys.modules["rekordbox_sync"] = rs
_spec.loader.exec_module(rs)


def _rb(artist, title, scale=None, bpm=None):
    return rs.RekordboxRow(artist=artist, title=title, scale_name=scale, bpm=bpm)


def _track(**over):
    base = {
        "trackId": "t1",
        "title": "Song",
        "artists": ["Artist"],
        "key": None,
        "keySource": None,
        "bpm": None,
        "bpmSource": None,
    }
    base.update(over)
    return base


def _one(track, rows):
    return rs.compute_diff([track], rows)


# ── normalize_key — a representative slice (full coverage lived in key-backfill) ──

@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Am", "A minor"),
        ("F", "F major"),
        ("Bbm", "A# minor"),  # enharmonic flat -> DSP sharp
        ("8A", "A minor"),  # Camelot
        ("A minor", "A minor"),
        (None, None),
        ("xyz", None),  # unparseable -> None (never guessed)
    ],
)
def test_normalize_key(raw, expected):
    assert rs.normalize_key(raw) == expected


def test_bpm_normalization_scaled_and_human():
    # Rekordbox stores BPM x100 (17400 = 174.00); a human float passes through.
    assert rs._normalize_bpm(17400) == 174.0
    assert rs._normalize_bpm(174) == 174.0
    assert rs._normalize_bpm(0) is None
    assert rs._normalize_bpm(None) is None


# ── match_key — the remix false-match guard survives the port ──

def test_remix_is_not_matched_to_original():
    r = _one(
        _track(title="Mr Majestic", artists=["Calibre"]),
        [_rb("Calibre", "Mr Majestic (Sub Focus Remix)", "Gm", 174.0)],
    )
    assert not r.proposals
    assert r.stats.unmatched == 1


# ── KEY rules ──

def test_operator_key_is_never_touched():
    r = _one(
        _track(key="A minor", key_source="operator", keySource="operator"),
        [_rb("Artist", "Song", "Gm")],
    )
    assert all(p.key is None for p in r.proposals)


def test_operator_key_still_allows_bpm_write():
    # A hand-graded KEY must not veto an honest BPM fill on the same finding.
    r = _one(
        _track(key="A minor", keySource="operator", bpm=None, bpmSource=None),
        [_rb("Artist", "Song", "Gm", 172.0)],
    )
    assert len(r.proposals) == 1
    assert r.proposals[0].key is None
    assert r.proposals[0].bpm == 172.0


def test_key_differs_proposes():
    r = _one(
        _track(key="A minor", keySource="dsp"),
        [_rb("Artist", "Song", "Gm")],
    )
    assert len(r.proposals) == 1
    assert r.proposals[0].key == "G minor"
    assert r.proposals[0].key_reason == "differ"


def test_matching_key_unstamped_gets_protective_stamp():
    r = _one(
        _track(key="A minor", keySource="dsp"),
        [_rb("Artist", "Song", "Am")],
    )
    assert len(r.proposals) == 1
    assert r.proposals[0].key == "A minor"
    assert r.proposals[0].key_reason == "stamp"


def test_matching_key_already_rekordbox_is_noop():
    r = _one(
        _track(key="A minor", keySource="rekordbox"),
        [_rb("Artist", "Song", "Am")],
    )
    assert not r.proposals
    assert r.stats.unchanged == 1


def test_ambiguous_key_is_skipped_and_listed():
    r = _one(
        _track(),
        [_rb("Artist", "Song", "Am"), _rb("Artist", "Song", "Gm")],
    )
    assert not any(p.key for p in r.proposals)
    assert any(a.field == "key" for a in r.ambiguous)


# ── BPM rules ──

def test_bpm_fills_when_null():
    r = _one(
        _track(bpm=None),
        [_rb("Artist", "Song", bpm=174.0)],
    )
    assert len(r.proposals) == 1
    assert r.proposals[0].bpm == 174.0
    assert r.proposals[0].bpm_reason == "fill"


def test_bpm_within_tolerance_is_noop():
    r = _one(
        _track(key="A minor", keySource="rekordbox", bpm=174.3, bpmSource="dsp"),
        [_rb("Artist", "Song", "Am", 174.0)],
    )
    assert not any(p.bpm is not None for p in r.proposals)


def test_bpm_big_delta_proposes():
    # A half-time DSP reading (87 vs 174) is a big delta -> propose the Rekordbox BPM.
    r = _one(
        _track(key="A minor", keySource="rekordbox", bpm=87.0, bpmSource="dsp"),
        [_rb("Artist", "Song", "Am", 174.0)],
    )
    assert any(p.bpm == 174.0 and p.bpm_reason == "delta" for p in r.proposals)


def test_operator_bpm_is_never_touched():
    r = _one(
        _track(bpm=100.0, bpmSource="operator"),
        [_rb("Artist", "Song", bpm=174.0)],
    )
    assert all(p.bpm is None for p in r.proposals)


def test_ambiguous_bpm_is_skipped_and_listed():
    r = _one(
        _track(bpm=None),
        [_rb("Artist", "Song", bpm=174.0), _rb("Artist", "Song", bpm=140.0)],
    )
    assert not any(p.bpm is not None for p in r.proposals)
    assert any(a.field == "bpm" for a in r.ambiguous)


def test_key_and_bpm_combine_into_one_proposal():
    r = _one(
        _track(key="A minor", keySource="dsp", bpm=None),
        [_rb("Artist", "Song", "Gm", 172.0)],
    )
    assert len(r.proposals) == 1
    p = r.proposals[0]
    assert p.key == "G minor" and p.bpm == 172.0


def test_no_rekordbox_match_is_unmatched():
    r = _one(
        _track(title="Unknown", artists=["Nobody"]),
        [_rb("Artist", "Song", "Am", 174.0)],
    )
    assert not r.proposals
    assert r.stats.unmatched == 1


# ── the max-writes FUSE ──

def test_max_writes_fuse():
    props = [rs.Proposal("t", "", "", None, None, key="A minor", key_reason="differ")]
    assert not rs.over_fuse(props, 20)
    assert not rs.over_fuse(props * 20, 20)  # exactly at the cap is allowed
    assert rs.over_fuse(props * 21, 20)  # one over blocks


def test_self_test_passes():
    # The script's own --self-test mirror must stay green (it doubles as box CI).
    assert rs._self_test() == 0
