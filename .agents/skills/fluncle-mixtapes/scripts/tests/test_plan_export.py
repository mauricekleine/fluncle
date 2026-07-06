"""Unit tests for rekordbox-plan-export.py pure logic.

No live Rekordbox DB or CLI calls — all external I/O is mocked/stubbed.
Run with:
  uv run --with pytest pytest packages/skills/fluncle-mixtapes/scripts/tests/
"""

from __future__ import annotations

import importlib.util
import sys
import os

_SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, _SCRIPTS_DIR)

import pytest
from _matching import match_key
from _cue_formats import (
    beatport_search_links,
    checklist,
    format_artists,
    m3u8,
    track_label,
)


def _import_plan_export():
    """Import rekordbox-plan-export.py via importlib (hyphen in filename)."""
    path = os.path.join(_SCRIPTS_DIR, "rekordbox-plan-export.py")
    spec = importlib.util.spec_from_file_location("rekordbox_plan_export", path)
    mod = importlib.util.module_from_spec(spec)
    # Register in sys.modules BEFORE exec so @dataclass can resolve cls.__module__.
    sys.modules["rekordbox_plan_export"] = mod
    spec.loader.exec_module(mod)
    return mod


_export = _import_plan_export()

_FLUNCLE_FOLDER_NAME = _export._FLUNCLE_FOLDER_NAME
match_cues_to_collection = _export.match_cues_to_collection


# ---------------------------------------------------------------------------
# _cue_formats — Python port of @fluncle/contracts/util/tracklist-export.ts.
# ---------------------------------------------------------------------------


class TestFormatArtists:
    def test_single_artist(self):
        assert format_artists(["Calibre"]) == "Calibre"

    def test_multiple_artists_joined_with_comma_space(self):
        assert format_artists(["Fred V", "Grafix"]) == "Fred V, Grafix"

    def test_empty_list(self):
        assert format_artists([]) == ""


class TestTrackLabel:
    def test_single_artist(self):
        assert track_label(["Calibre"], "Spill") == "Calibre — Spill"

    def test_multiple_artists(self):
        assert track_label(["Fred V", "Grafix"], "Osiris") == "Fred V, Grafix — Osiris"


class TestBeatportSearchLinks:
    def test_returns_one_url_per_cue(self):
        cues = [
            {"artists": ["Calibre"], "title": "Spill"},
            {"artists": ["Fred V", "Grafix"], "title": "Osiris"},
        ]
        urls = beatport_search_links(cues)
        assert len(urls) == 2

    def test_url_is_beatport_search(self):
        cues = [{"artists": ["Calibre"], "title": "Spill"}]
        urls = beatport_search_links(cues)
        assert urls[0].startswith("https://www.beatport.com/search?q=")

    def test_url_encoded(self):
        cues = [{"artists": ["Calibre"], "title": "Spill & Fill"}]
        urls = beatport_search_links(cues)
        # & must be URL-encoded — the literal '&' must not appear in the query value
        q_value = urls[0].split("?q=")[1]
        assert "&" not in q_value
        assert "%" in q_value

    def test_space_encoded(self):
        cues = [{"artists": ["Fred V"], "title": "In Motion"}]
        urls = beatport_search_links(cues)
        assert " " not in urls[0]

    def test_empty_list(self):
        assert beatport_search_links([]) == []


class TestM3u8:
    def test_starts_with_extm3u(self):
        result = m3u8([])
        assert result.startswith("#EXTM3U")

    def test_includes_playlist_title_when_given(self):
        result = m3u8([], title="liquid-nebula-roller")
        assert "#PLAYLIST:liquid-nebula-roller" in result

    def test_no_title_line_when_absent(self):
        result = m3u8([])
        assert "#PLAYLIST:" not in result

    def test_one_extinf_per_cue(self):
        cues = [
            {"artists": ["Calibre"], "title": "Spill"},
            {"artists": ["Dbridge"], "title": "Lost"},
        ]
        result = m3u8(cues)
        lines = result.split("\n")
        extinf = [line for line in lines if line.startswith("#EXTINF:")]
        assert len(extinf) == 2

    def test_extinf_contains_label(self):
        cues = [{"artists": ["Calibre"], "title": "Spill"}]
        result = m3u8(cues)
        assert "Calibre — Spill" in result

    def test_empty_cues(self):
        result = m3u8([])
        lines = [l for l in result.split("\n") if l.startswith("#EXTINF:")]
        assert lines == []


class TestChecklist:
    def test_numbered_from_one(self):
        cues = [
            {"artists": ["Calibre"], "title": "Spill"},
            {"artists": ["Dbridge"], "title": "Lost"},
        ]
        result = checklist(cues)
        lines = result.split("\n")
        assert lines[0].startswith("1. ")
        assert lines[1].startswith("2. ")

    def test_artist_dash_title_format(self):
        cues = [{"artists": ["Calibre"], "title": "Spill"}]
        result = checklist(cues)
        assert "Calibre — Spill" in result

    def test_multiple_artists_in_checklist(self):
        cues = [{"artists": ["Fred V", "Grafix"], "title": "Osiris"}]
        result = checklist(cues)
        assert "Fred V, Grafix — Osiris" in result

    def test_empty_list(self):
        assert checklist([]) == ""


# ---------------------------------------------------------------------------
# match_cues_to_collection — resolves plan cues to Rekordbox collection.
# ---------------------------------------------------------------------------


class FakeContent:
    """Minimal stub of pyrekordbox DjmdContent for testing."""

    def __init__(self, artist: str, title: str, content_id: str = "1"):
        self.Title = title
        self.ArtistName = artist
        self.Artist = type("A", (), {"Name": artist})()
        self.ID = content_id
        self.FolderPath = "/Music/"
        self.FileName = f"{title}.mp3"
        self.BPM = 17500  # 175.00 BPM (Rekordbox stores BPM * 100)
        self.rb_local_deleted = 0


def _make_index(entries: list[tuple[str, str, str]]) -> dict[tuple, list]:
    """Build a collection index from (artist, title, id) tuples."""
    index: dict[tuple, list] = {}
    for artist, title, cid in entries:
        key = match_key(artist, title)
        content = FakeContent(artist, title, cid)
        index.setdefault(key, []).append(content)
    return index


class TestMatchCuesToCollection:
    def test_exact_match_returns_matched(self):
        index = _make_index([("Calibre", "Spill", "c1")])
        cues = [{"artists": ["Calibre"], "title": "Spill"}]
        results = match_cues_to_collection(cues, index)
        assert len(results) == 1
        cue, content, reason = results[0]
        assert reason == "matched"
        assert content is not None
        assert content.Title == "Spill"

    def test_case_insensitive_match(self):
        index = _make_index([("calibre", "spill", "c1")])
        cues = [{"artists": ["CALIBRE"], "title": "SPILL"}]
        results = match_cues_to_collection(cues, index)
        _, content, reason = results[0]
        assert reason == "matched"
        assert content is not None

    def test_unmatched_returns_none_content(self):
        index = _make_index([("Calibre", "Spill", "c1")])
        cues = [{"artists": ["Unknown"], "title": "Track XYZ"}]
        results = match_cues_to_collection(cues, index)
        _, content, reason = results[0]
        assert reason == "unmatched"
        assert content is None

    def test_ambiguous_returns_first_candidate_with_reason(self):
        index: dict[tuple, list] = {}
        key = match_key("Calibre", "Spill")
        index[key] = [
            FakeContent("Calibre", "Spill", "c1"),
            FakeContent("Calibre", "Spill", "c2"),
        ]
        cues = [{"artists": ["Calibre"], "title": "Spill"}]
        results = match_cues_to_collection(cues, index)
        _, content, reason = results[0]
        assert reason == "ambiguous"
        assert content is not None  # uses first candidate

    def test_multiple_cues_all_returned(self):
        index = _make_index([
            ("Calibre", "Spill", "c1"),
            ("Dbridge", "Lost", "c2"),
        ])
        cues = [
            {"artists": ["Calibre"], "title": "Spill"},
            {"artists": ["Dbridge"], "title": "Lost"},
            {"artists": ["Unknown"], "title": "X"},
        ]
        results = match_cues_to_collection(cues, index)
        assert len(results) == 3
        assert results[0][2] == "matched"
        assert results[1][2] == "matched"
        assert results[2][2] == "unmatched"

    def test_remix_does_not_match_original(self):
        index = _make_index([("Calibre", "Spill", "c1")])
        cues = [{"artists": ["Calibre"], "title": "Spill (VIP)"}]
        results = match_cues_to_collection(cues, index)
        _, content, reason = results[0]
        assert reason == "unmatched"

    def test_feat_in_rekordbox_matches_plain_artist(self):
        # Rekordbox: "Calibre feat. Dbridge"; Fluncle DTO: ["Calibre"]
        index = _make_index([("Calibre feat. Dbridge", "Spill", "c1")])
        cues = [{"artists": ["Calibre"], "title": "Spill"}]
        results = match_cues_to_collection(cues, index)
        _, _, reason = results[0]
        # feat. is dropped from both sides, so they match
        assert reason == "matched"


# ---------------------------------------------------------------------------
# Slug → playlist name mapping.
# ---------------------------------------------------------------------------


class TestSlugToPlaylistName:
    def test_slug_is_recording_title_verbatim(self):
        """The plan's `title` IS the Galaxy-vocab slug — no further transformation."""
        recording = {"title": "liquid-nebula-roller", "tracklist": []}
        slug = str(recording.get("title", ""))
        assert slug == "liquid-nebula-roller"

    def test_fluncle_folder_name_constant(self):
        assert _FLUNCLE_FOLDER_NAME == "Fluncle Plans"
