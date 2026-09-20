"""Offline tests for partition-undecided.py — the triage pull's two exclusions.

No credentials, no network, no database: the pull's SQL half is what needs production, and this
is the half that does not. Run with:
  uv run --with pytest pytest packages/skills/fluncle-label-triage/scripts/tests/
"""

from __future__ import annotations

import importlib.util
import os
import sys

_SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..")
_PARTITION = os.path.join(_SCRIPTS_DIR, "partition-undecided.py")


def _import(path: str, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


partition_undecided = _import(_PARTITION, "partition_undecided")

FRESH = partition_undecided.FRESH
SETTLED = partition_undecided.SETTLED
UNIDENTIFIED = partition_undecided.UNIDENTIFIED


def label(label_id, slug, mb_label_id="3ae210f7-0000-4000-8000-00000000000a"):
    return {
        "id": label_id,
        "mb_label_id": mb_label_id,
        "name": slug.title(),
        "slug": slug,
        "track_rows": "12",
    }


def rule(label_id, artist_name="Jus Now", verdict="allow"):
    return {
        "artist_mbid": "c7a4f6d6-0000-4000-8000-00000000000b",
        "artist_name": artist_name,
        "label_id": label_id,
        "verdict": verdict,
    }


def slugs(rows):
    return sorted(row["slug"] for row in rows)


def test_a_researchable_label_is_the_round_s_worklist():
    buckets = partition_undecided.partition([label("lbl_1", "hoofbeats")], [])

    assert slugs(buckets[FRESH]) == ["hoofbeats"]
    assert buckets[SETTLED] == []
    assert buckets[UNIDENTIFIED] == []


def test_a_rule_carrying_label_is_a_settled_partial_and_is_skipped():
    buckets = partition_undecided.partition([label("lbl_1", "yuku")], [rule("lbl_1")])

    assert slugs(buckets[SETTLED]) == ["yuku"]
    assert buckets[FRESH] == []


def test_a_label_without_an_mbid_is_skipped_as_unidentifiable():
    buckets = partition_undecided.partition([label("lbl_1", "vision", mb_label_id=None)], [])

    assert slugs(buckets[UNIDENTIFIED]) == ["vision"]
    assert buckets[FRESH] == []


def test_the_missing_mbid_outranks_the_rule_check():
    # Both exclusions apply; the row is reported as unidentifiable, because that is the one the
    # operator has to act on — a rule-carrying partial needs nothing from him.
    buckets = partition_undecided.partition(
        [label("lbl_1", "vision", mb_label_id=None)], [rule("lbl_1")]
    )

    assert slugs(buckets[UNIDENTIFIED]) == ["vision"]
    assert buckets[SETTLED] == []


def test_an_empty_string_mbid_counts_as_no_identity():
    buckets = partition_undecided.partition([label("lbl_1", "vision", mb_label_id="")], [])

    assert slugs(buckets[UNIDENTIFIED]) == ["vision"]


def test_a_global_rule_belongs_to_no_label_and_settles_nothing():
    buckets = partition_undecided.partition([label("lbl_1", "hoofbeats")], [rule(None)])

    assert slugs(buckets[FRESH]) == ["hoofbeats"]
    assert buckets[SETTLED] == []


def test_every_emitted_row_carries_its_per_label_rules():
    buckets = partition_undecided.partition(
        [label("lbl_1", "hoofbeats"), label("lbl_2", "yuku")], [rule("lbl_2", "Jus Now", "allow")]
    )

    assert buckets[FRESH][0]["rules"] == []
    assert buckets[SETTLED][0]["rules"] == [
        {
            "artistMbid": "c7a4f6d6-0000-4000-8000-00000000000b",
            "artistName": "Jus Now",
            "verdict": "allow",
        }
    ]


def test_the_report_names_every_skipped_slug_on_both_exclusions():
    buckets = partition_undecided.partition(
        [
            label("lbl_1", "hoofbeats"),
            label("lbl_2", "yuku"),
            label("lbl_3", "vision", mb_label_id=None),
            label("lbl_4", "radar-records", mb_label_id=None),
        ],
        [rule("lbl_2")],
    )
    lines = partition_undecided.report(buckets)

    assert lines[0] == (
        "undecided: 4 | settled dnb_partial (skipped): 1 | "
        "no mb_label_id (skipped): 2 | to triage: 1"
    )
    assert lines[1] == "  skipped: yuku"
    assert lines[2] == "  no mb_label_id: radar-records, vision"
    assert "resolve each label's MusicBrainz identity" in lines[3]


def test_the_report_stays_quiet_when_nothing_is_skipped():
    buckets = partition_undecided.partition([label("lbl_1", "hoofbeats")], [])

    assert partition_undecided.report(buckets) == [
        "undecided: 1 | settled dnb_partial (skipped): 0 | "
        "no mb_label_id (skipped): 0 | to triage: 1"
    ]
