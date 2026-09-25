"""Offline tests for render-conflation-brief.py — the MusicBrainz split brief.

No credentials, no network, no database. Run with:
  uv run --with pytest pytest packages/skills/fluncle-label-triage/scripts/tests/
"""

from __future__ import annotations

import importlib.util
import os
import sys

_SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..")
_RENDER = os.path.join(_SCRIPTS_DIR, "render-conflation-brief.py")


def _import(path: str, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


render_conflation_brief = _import(_RENDER, "render_conflation_brief")


def _row(slug: str, *, worth: bool, moves: str = "one release", trap: str | None = None) -> dict:
    conflation = {
        "dnbStrandWorthRecovering": worth,
        "keep": f"{slug} in-lane strand",
        "moveOut": moves,
    }
    if trap:
        conflation["trap"] = trap
    return {"conflation": conflation, "name": slug.title(), "slug": slug, "verdict": "unclear"}


def _round(unclear: list[dict], **other: list) -> dict:
    base: dict[str, list] = {"dnb": [], "dnb_partial": [], "not_dnb": [], "unclear": unclear}
    base.update(other)
    return base


def _pile(slugs: list[str]) -> list[dict]:
    return [{"mb_label_id": f"mbid-{slug}", "slug": slug} for slug in slugs]


def test_no_conflations_renders_nothing():
    assert render_conflation_brief.render(_round([]), []) == ""


def test_an_unclear_without_a_conflation_object_is_not_a_conflation():
    plain = {"name": "Mixed", "slug": "mixed", "verdict": "unclear"}
    assert render_conflation_brief.render(_round([plain]), _pile(["mixed"])) == ""


def test_group_a_is_rendered_before_group_b():
    rows = [_row("hygiene", worth=False), _row("trapped", worth=True)]
    out = render_conflation_brief.render(_round(rows), _pile(["hygiene", "trapped"]))
    assert out.index("Group A") < out.index("Group B")
    assert out.index("Trapped") < out.index("Hygiene")


def test_the_brief_tells_the_editor_to_stop_before_group_b():
    rows = [_row("a", worth=True), _row("b", worth=False)]
    out = render_conflation_brief.render(_round(rows), _pile(["a", "b"]))
    assert "Do Group A first and completely" in out
    assert "earn Fluncle nothing" in out


def test_notes_are_framed_as_a_hypothesis_not_fact():
    out = render_conflation_brief.render(_round([_row("a", worth=True)]), _pile(["a"]))
    assert "HYPOTHESIS" in out
    assert "a wrong move is worse than a missed one" in out


def test_the_standing_rails_survive_into_the_brief():
    out = render_conflation_brief.render(_round([_row("a", worth=True)]), _pile(["a"]))
    assert "Never merge two label entities" in out
    assert "auto-edits" in out
    assert "One request per second" in out


def test_entities_are_ordered_by_fewest_moves_within_a_group():
    rows = [
        _row("many", worth=True, moves="one; two; three"),
        _row("few", worth=True, moves="only one"),
    ]
    out = render_conflation_brief.render(_round(rows), _pile(["many", "few"]))
    assert out.index("Few") < out.index("Many")


def test_the_mbid_is_rendered_so_the_editor_hits_the_exact_entity():
    out = render_conflation_brief.render(_round([_row("a", worth=True)]), _pile(["a"]))
    assert "`mbid-a`" in out


def test_a_missing_mbid_is_called_out_rather_than_rendered_blank():
    out = render_conflation_brief.render(_round([_row("a", worth=True)]), [])
    assert "NO MBID" in out


def test_a_trap_is_rendered_when_present_and_omitted_when_not():
    with_trap = render_conflation_brief.render(
        _round([_row("a", worth=True, trap="the url-rel describes the half being moved out")]),
        _pile(["a"]),
    )
    assert "**Careful:**" in with_trap
    assert "moved out" in with_trap
    without = render_conflation_brief.render(_round([_row("b", worth=True)]), _pile(["b"]))
    assert "**Careful:**" not in without


def test_numbering_runs_continuously_across_both_groups():
    rows = [_row("a", worth=True), _row("b", worth=False), _row("c", worth=False)]
    out = render_conflation_brief.render(_round(rows), _pile(["a", "b", "c"]))
    assert "### 1. A —" in out
    assert "### 2. B —" in out
    assert "### 3. C —" in out


def test_the_total_in_the_title_counts_both_groups():
    rows = [_row("a", worth=True), _row("b", worth=False)]
    out = render_conflation_brief.render(_round(rows), _pile(["a", "b"]))
    assert out.startswith("# Brief: split 2 conflated MusicBrainz label entities")
