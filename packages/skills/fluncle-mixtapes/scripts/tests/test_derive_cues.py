"""Unit tests for rekordbox-derive-cues.py pure logic.

No live Rekordbox DB or CLI calls — all external I/O is mocked/stubbed.
Run with:
  uv run --with pytest pytest packages/skills/fluncle-mixtapes/scripts/tests/
"""

from __future__ import annotations

import importlib.util
import sys
import os

# Ensure scripts/ is on the path so shared modules are importable.
_SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, _SCRIPTS_DIR)

import pytest
from _matching import _fold, _normalize_artists, _split_title, match_key


def _import_derive():
    """Import rekordbox-derive-cues.py via importlib (hyphen in filename)."""
    path = os.path.join(_SCRIPTS_DIR, "rekordbox-derive-cues.py")
    spec = importlib.util.spec_from_file_location("rekordbox_derive_cues", path)
    mod = importlib.util.module_from_spec(spec)
    # Register in sys.modules BEFORE exec so @dataclass can resolve cls.__module__.
    sys.modules["rekordbox_derive_cues"] = mod
    spec.loader.exec_module(mod)
    return mod


_derive = _import_derive()

build_catalogue_index = _derive.build_catalogue_index
derive_cues = _derive.derive_cues
prune_consecutive_and_flag_repeats = _derive.prune_consecutive_and_flag_repeats
Cue = _derive.Cue


# ---------------------------------------------------------------------------
# _matching helpers (shared module re-tested here for completeness).
# ---------------------------------------------------------------------------


class TestFold:
    def test_lowercases(self):
        assert _fold("Hello World") == "hello world"

    def test_strips_accents(self):
        assert _fold("Café") == "cafe"

    def test_ampersand_to_and(self):
        assert _fold("A & B") == "a and b"

    def test_drops_punctuation(self):
        assert _fold("Hello, World!") == "hello world"

    def test_collapses_whitespace(self):
        assert _fold("  A   B  ") == "a b"


class TestNormalizeArtists:
    def test_list_input(self):
        result = _normalize_artists(["Calibre", "Fred V"])
        assert result == frozenset(["calibre", "fred v"])

    def test_single_string(self):
        result = _normalize_artists("Calibre & Fred V")
        assert result == frozenset(["calibre", "fred v"])

    def test_feat_dropped(self):
        result = _normalize_artists("Calibre feat. Dbridge")
        assert result == frozenset(["calibre"])

    def test_order_agnostic(self):
        a = _normalize_artists(["Fred V", "Grafix"])
        b = _normalize_artists("Calibre & Fred V")
        # Different artists — just checking both return frozensets
        assert isinstance(a, frozenset)
        assert isinstance(b, frozenset)

    def test_separator_agnostic(self):
        a = _normalize_artists(["Fred V", "Grafix"])
        b = _normalize_artists("Fred V & Grafix")
        assert a == b


class TestSplitTitle:
    def test_plain_title(self):
        base, desc = _split_title("Spill")
        assert base == "spill"
        assert desc == ""

    def test_remix_descriptor(self):
        base, desc = _split_title("Spill (Calibre Remix)")
        assert base == "spill"
        assert "remix" in desc

    def test_vip_is_distinct(self):
        _, desc = _split_title("Spill (VIP)")
        assert "vip" in desc

    def test_feat_in_title_dropped(self):
        base, desc = _split_title("Spill (feat. Dbridge)")
        assert base == "spill"
        assert desc == ""

    def test_original_mix_neutral(self):
        base, desc = _split_title("Spill (Original Mix)")
        assert base == "spill"
        assert desc == ""

    def test_dash_remix(self):
        base, desc = _split_title("Spill - Calibre Remix")
        assert "remix" in desc


class TestMatchKey:
    def test_same_track_matches(self):
        a = match_key(["Calibre"], "Spill")
        b = match_key("Calibre", "Spill")
        assert a == b

    def test_remix_does_not_match_original(self):
        original = match_key(["Calibre"], "Spill")
        remix = match_key(["Calibre"], "Spill (VIP)")
        assert original != remix

    def test_case_insensitive(self):
        a = match_key(["CALIBRE"], "SPILL")
        b = match_key(["calibre"], "spill")
        assert a == b

    def test_separator_agnostic(self):
        a = match_key(["Fred V", "Grafix"], "Osiris")
        b = match_key("Fred V & Grafix", "Osiris")
        assert a == b


# ---------------------------------------------------------------------------
# derive_cues — bucket assignment.
# ---------------------------------------------------------------------------


def _make_row(artist: str, title: str, track_no: int = 1) -> dict:
    return {
        "artist": artist,
        "title": title,
        "track_no": track_no,
        "key": None,
        "bpm": None,
        "load_time": None,
    }


def _make_finding(track_id: str, artists: list[str], title: str) -> dict:
    return {"trackId": track_id, "artists": artists, "title": title, "type": "finding"}


class TestDeriveCues:
    def setup_method(self):
        self.finding = _make_finding("abc", ["Calibre"], "Spill")
        self.index = build_catalogue_index([self.finding])

    def test_exact_match_sets_finding_id(self):
        rows = [_make_row("Calibre", "Spill")]
        cues = derive_cues(rows, self.index)
        assert len(cues) == 1
        assert cues[0].finding_id == "abc"
        assert cues[0].match_bucket == "matched"

    def test_case_insensitive_match(self):
        rows = [_make_row("CALIBRE", "SPILL")]
        cues = derive_cues(rows, self.index)
        assert cues[0].finding_id == "abc"

    def test_unmatched_gives_null_finding_id(self):
        rows = [_make_row("Unknown Artist", "Unknown Track")]
        cues = derive_cues(rows, self.index)
        assert cues[0].finding_id is None
        assert cues[0].match_bucket == "unmatched"

    def test_artists_text_from_finding_when_matched(self):
        rows = [_make_row("Calibre", "Spill")]
        cues = derive_cues(rows, self.index)
        # artistsText comes from the Fluncle canonical form.
        assert cues[0].artists_text == "Calibre"

    def test_artists_text_from_rekordbox_when_unmatched(self):
        rows = [_make_row("DJ Unknown", "Track X")]
        cues = derive_cues(rows, self.index)
        assert cues[0].artists_text == "DJ Unknown"

    def test_ambiguous_when_multiple_candidates(self):
        f1 = _make_finding("id1", ["Calibre"], "Spill")
        f2 = _make_finding("id2", ["Calibre"], "Spill")
        index = build_catalogue_index([f1, f2])
        rows = [_make_row("Calibre", "Spill")]
        cues = derive_cues(rows, index)
        assert cues[0].finding_id is None
        assert cues[0].match_bucket == "ambiguous"
        assert "id1" in (cues[0].flag_detail or "")

    def test_remix_does_not_match_original(self):
        rows = [_make_row("Calibre", "Spill (VIP)")]
        cues = derive_cues(rows, self.index)
        assert cues[0].finding_id is None
        assert cues[0].match_bucket == "unmatched"

    def test_multiple_rows_ordered_by_track_no(self):
        f1 = _make_finding("id1", ["Calibre"], "Spill")
        f2 = _make_finding("id2", ["Dbridge"], "Lost")
        index = build_catalogue_index([f1, f2])
        rows = [
            _make_row("Calibre", "Spill", track_no=1),
            _make_row("Dbridge", "Lost", track_no=2),
        ]
        cues = derive_cues(rows, index)
        assert cues[0].finding_id == "id1"
        assert cues[1].finding_id == "id2"


# ---------------------------------------------------------------------------
# prune_consecutive_and_flag_repeats.
# ---------------------------------------------------------------------------


def _make_cue(artists_text: str, title_text: str, track_no: int = 1) -> Cue:
    return Cue(
        track_no=track_no,
        artist=artists_text,
        title=title_text,
        finding_id=None,
        artists_text=artists_text,
        title_text=title_text,
        position=0,
        match_bucket="matched",
    )


class TestPruneConsecutiveAndFlagRepeats:
    def test_no_duplicates_unchanged(self):
        cues = [
            _make_cue("A", "Track 1"),
            _make_cue("B", "Track 2"),
            _make_cue("C", "Track 3"),
        ]
        result = prune_consecutive_and_flag_repeats(cues)
        assert len(result) == 3

    def test_consecutive_duplicate_pruned(self):
        cues = [_make_cue("A", "Spill"), _make_cue("A", "Spill"), _make_cue("B", "Other")]
        result = prune_consecutive_and_flag_repeats(cues)
        assert len(result) == 2
        assert result[0].artists_text == "A"
        assert result[1].artists_text == "B"

    def test_three_consecutive_pruned_to_one(self):
        cues = [_make_cue("A", "Spill")] * 3 + [_make_cue("B", "Other")]
        result = prune_consecutive_and_flag_repeats(cues)
        assert len(result) == 2

    def test_non_consecutive_repeat_kept_and_flagged(self):
        cues = [
            _make_cue("A", "Spill"),
            _make_cue("B", "Other"),
            _make_cue("A", "Spill"),  # non-consecutive repeat
        ]
        result = prune_consecutive_and_flag_repeats(cues)
        assert len(result) == 3  # all three kept
        assert result[0].flagged_reason == "repeat"
        assert result[2].flagged_reason == "repeat"
        assert result[1].flagged_reason is None  # B is not repeated

    def test_positions_assigned_sequentially(self):
        cues = [_make_cue("A", "X"), _make_cue("B", "Y"), _make_cue("C", "Z")]
        result = prune_consecutive_and_flag_repeats(cues)
        assert [c.position for c in result] == [1, 2, 3]

    def test_positions_reindexed_after_prune(self):
        # A, A (pruned), B, C → positions 1, 2, 3
        cues = [
            _make_cue("A", "Spill"),
            _make_cue("A", "Spill"),
            _make_cue("B", "X"),
            _make_cue("C", "Y"),
        ]
        result = prune_consecutive_and_flag_repeats(cues)
        assert [c.position for c in result] == [1, 2, 3]

    def test_case_insensitive_dedup(self):
        cues = [_make_cue("calibre", "spill"), _make_cue("CALIBRE", "SPILL")]
        result = prune_consecutive_and_flag_repeats(cues)
        assert len(result) == 1  # same identity → consecutive prune


# ---------------------------------------------------------------------------
# Cue output shape.
# ---------------------------------------------------------------------------


class TestCueDictShape:
    def test_matched_cue_includes_finding_id(self):
        cue = Cue(
            track_no=1,
            artist="Calibre",
            title="Spill",
            finding_id="abc123",
            artists_text="Calibre",
            title_text="Spill",
            position=1,
            match_bucket="matched",
        )
        d = cue.to_cue_dict()
        assert d["findingId"] == "abc123"
        assert d["artistsText"] == "Calibre"
        assert d["titleText"] == "Spill"
        assert d["position"] == 1
        assert "startMs" not in d  # not set until Studio

    def test_unmatched_cue_omits_finding_id_key(self):
        cue = Cue(
            track_no=1,
            artist="DJ X",
            title="Unknown",
            finding_id=None,
            artists_text="DJ X",
            title_text="Unknown",
            position=1,
            match_bucket="unmatched",
        )
        d = cue.to_cue_dict()
        assert "findingId" not in d
        assert d["artistsText"] == "DJ X"
        assert d["titleText"] == "Unknown"

    def test_position_is_one_based(self):
        rows = [
            _make_row("A", "T1", track_no=1),
            _make_row("B", "T2", track_no=2),
        ]
        index = build_catalogue_index([])
        raw = derive_cues(rows, index)
        final = prune_consecutive_and_flag_repeats(raw)
        assert final[0].position == 1
        assert final[1].position == 2
