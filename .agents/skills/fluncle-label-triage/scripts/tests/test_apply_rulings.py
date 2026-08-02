"""Offline tests for apply-rulings.py's plan building and its --dry-run call plan.

No credentials, no network: --dry-run reads a fixture standing in for the server's undecided
list and prints the HTTP calls it WOULD make. Run with:
  uv run --with pytest pytest packages/skills/fluncle-label-triage/scripts/tests/
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys

_SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..")
_APPLY = os.path.join(_SCRIPTS_DIR, "apply-rulings.py")
_RENDER = os.path.join(_SCRIPTS_DIR, "render-ratification.py")

MBID_A = "3ae210f7-0000-4000-8000-00000000000a"
MBID_B = "c7a4f6d6-0000-4000-8000-00000000000b"
MBID_C = "11111111-0000-4000-8000-00000000000c"


def _import(path: str, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


apply_rulings = _import(_APPLY, "apply_rulings")
render_ratification = _import(_RENDER, "render_ratification")


def rule(mbid=MBID_A, name="Jus Now", verdict="block", count=6, **extra):
    return {
        "artistMbid": mbid,
        "artistName": name,
        "evidence": "First-credited on six soca-leaning 12\"s.",
        "firstCreditCount": count,
        "verdict": verdict,
        **extra,
    }


def triage_fixture():
    return {
        "dnb": [
            {
                "slug": "gutterfunk",
                "name": "Gutterfunk",
                "confidence": "high",
                "evidence": "Roni Size, DJ Die, Krust across the catalogue.",
                "rules": [rule(), rule(mbid=MBID_C, name="Maddslinky", count=0)],
            },
            {
                "slug": "plain-dnb",
                "name": "Plain DnB",
                "confidence": "high",
                "evidence": "Wholly in lane.",
            },
        ],
        "dnb_partial": [
            {
                "slug": "yuku",
                "name": "YUKU",
                "confidence": "medium",
                "evidence": "Mostly experimental club; a real halftime minority.",
                "rules": [rule(mbid=MBID_B, name="Ourman", verdict="allow", count=9)],
            }
        ],
        "not_dnb": [
            {"slug": "big-major", "name": "Big Major", "confidence": "high", "evidence": "Major."}
        ],
        "unclear": [
            {"slug": "held", "name": "Held", "confidence": "low", "evidence": "Conflated MBID."}
        ],
    }


def live_fixture():
    return {
        "labels": [
            {"id": "lbl_gutterfunk", "slug": "gutterfunk", "seedState": "undecided"},
            {"id": "lbl_plain", "slug": "plain-dnb", "seedState": "undecided"},
            {"id": "lbl_yuku", "slug": "yuku", "seedState": "undecided"},
            {"id": "lbl_major", "slug": "big-major", "seedState": "undecided"},
            {"id": "lbl_held", "slug": "held", "seedState": "undecided"},
        ]
    }


# ── plan building ───────────────────────────────────────────────────────────────────────────


def test_plan_covers_the_three_writing_buckets_and_never_unclear():
    plan, _ = apply_rulings.build_plan(triage_fixture())
    by_slug = {entry["slug"]: entry for entry in plan}

    assert set(by_slug) == {"gutterfunk", "plain-dnb", "yuku", "big-major"}
    assert by_slug["gutterfunk"]["seedState"] == "enabled"
    assert by_slug["big-major"]["seedState"] == "disabled"
    # dnb_partial keeps the label exactly as it is; only its rules are written.
    assert by_slug["yuku"]["seedState"] is None
    assert by_slug["yuku"]["rules"] == [
        {"artistMbid": MBID_B, "artistName": "Ourman", "verdict": "allow"}
    ]


def test_inert_rule_is_dropped_but_the_label_still_enables():
    plan, notes = apply_rulings.build_plan(triage_fixture())
    gutterfunk = next(entry for entry in plan if entry["slug"] == "gutterfunk")

    assert [r["artistMbid"] for r in gutterfunk["rules"]] == [MBID_A]
    assert any("inert" in note and "Maddslinky" in note for note in notes)


def test_a_verdict_may_only_carry_its_own_rule_verdict():
    staged = triage_fixture()
    staged["dnb"][0]["rules"] = [rule(verdict="allow")]
    plan, notes = apply_rulings.build_plan(staged)

    assert "gutterfunk" not in {entry["slug"] for entry in plan}
    assert any(note.startswith("REFUSED gutterfunk") for note in notes)


def test_dnb_partial_without_an_applicable_rule_is_left_alone():
    staged = triage_fixture()
    staged["dnb_partial"][0]["rules"] = [rule(mbid=MBID_B, verdict="allow", count=0)]
    plan, notes = apply_rulings.build_plan(staged)

    assert "yuku" not in {entry["slug"] for entry in plan}
    assert any("dnb_partial with no applicable allow rule" in note for note in notes)


def test_bare_names_and_duplicates_are_refused_before_the_wire():
    staged = triage_fixture()
    staged["dnb"][0]["rules"] = [rule(), rule(), rule(mbid="Jus Now")]
    plan, notes = apply_rulings.build_plan(staged)
    gutterfunk = next(entry for entry in plan if entry["slug"] == "gutterfunk")

    assert len(gutterfunk["rules"]) == 1
    assert any("duplicate" in note for note in notes)
    assert any("not an MBID" in note for note in notes)


def test_a_global_suggestion_is_reported_and_never_applied():
    staged = triage_fixture()
    staged["dnb"][0]["globalSuggestion"] = "Consider blocking Jus Now everywhere."
    plan, notes = apply_rulings.build_plan(staged)

    assert all("global" not in json.dumps(entry).lower() for entry in plan)
    assert any("globals" in note for note in notes)


def test_a_rules_free_round_plans_exactly_as_it_always_did():
    """Backward compatibility: the pre-rules staged shape produces the same two-bucket plan."""
    staged = {
        "dnb": [{"slug": "a", "name": "A"}],
        "not_dnb": [{"slug": "b", "name": "B"}],
        "unclear": [{"slug": "c", "name": "C"}],
    }
    plan, notes = apply_rulings.build_plan(staged)

    assert [(e["slug"], e["seedState"], e["rules"]) for e in plan] == [
        ("a", "enabled", []),
        ("b", "disabled", []),
    ]
    assert notes == []


# ── the dry-run call plan ───────────────────────────────────────────────────────────────────


def run_dry(tmp_path, mode="apply", triage=None, live=None, extra=()):
    (tmp_path / "label-triage.json").write_text(json.dumps(triage or triage_fixture()))
    (tmp_path / "live-labels.json").write_text(json.dumps(live or live_fixture()))
    proc = subprocess.run(
        [sys.executable, _APPLY, mode, "--dry-run", *extra],
        capture_output=True,
        cwd=tmp_path,
        env={**os.environ, "FLUNCLE_API_BASE_URL": "", "FLUNCLE_API_TOKEN": ""},
        text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return proc.stdout


def test_dry_run_apply_prints_every_planned_call(tmp_path):
    out = run_dry(tmp_path)

    assert "WOULD PATCH /api/v1/admin/labels/lbl_gutterfunk" in out
    assert "WOULD PUT /api/v1/admin/labels/lbl_gutterfunk/artists" in out
    assert "WOULD PATCH /api/v1/admin/labels/lbl_major" in out
    assert "WOULD PUT /api/v1/admin/labels/lbl_yuku/artists" in out
    # dnb_partial never touches the seed state, and unclear is never written at all.
    assert "WOULD PATCH /api/v1/admin/labels/lbl_yuku" not in out
    assert "lbl_held" not in out
    assert "DONE ok=4 fail=0" in out


def test_dry_run_pilot_picks_a_rule_carrying_label(tmp_path):
    out = run_dry(tmp_path, mode="pilot")

    assert "PILOT -> Gutterfunk" in out
    assert "WOULD PUT /api/v1/admin/labels/lbl_gutterfunk/artists" in out
    assert "lbl_major" not in out


def test_a_slug_that_moved_since_the_triage_is_skipped(tmp_path):
    live = {"labels": [row for row in live_fixture()["labels"] if row["slug"] != "gutterfunk"]}
    out = run_dry(tmp_path, live=live)

    assert "SKIPPING 1 no longer undecided" in out
    assert "lbl_gutterfunk" not in out


def test_dry_run_rescope_lists_the_worklist_without_calling_musicbrainz(tmp_path):
    (tmp_path / "calib-rules.json").write_text(
        json.dumps(
            [
                {
                    "artist_mbid": MBID_A,
                    "artist_name": "Jus Now",
                    "label_id": None,
                    "label_name": None,
                    "verdict": "block",
                }
            ]
        )
    )
    out = run_dry(tmp_path, mode="rescope")

    assert "rescope worklist: 1 rule(s)" in out
    assert f"WOULD GET musicbrainz artist/{MBID_A}" in out
    assert "1 clean" in out


# ── the ratification page ───────────────────────────────────────────────────────────────────


def test_the_page_leads_with_the_rule_proposals_and_flags_the_inert_one():
    page = render_ratification.render(triage_fixture())

    assert page.index("Artist rules") < page.index("Enable")
    assert "Jus Now" in page and MBID_A in page
    assert "inert — will be dropped" in page
    # A label with no rules still renders, in its plain bucket.
    assert "Plain DnB" in page


def test_the_page_escapes_what_an_agent_wrote():
    staged = triage_fixture()
    staged["unclear"][0]["evidence"] = "<script>alert(1)</script>"

    assert "<script>alert(1)</script>" not in render_ratification.render(staged)
