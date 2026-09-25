"""Offline tests for build-verify-input.py — which verdicts get a second opinion.

No credentials, no network, no database. Run with:
  uv run --with pytest pytest packages/skills/fluncle-label-triage/scripts/tests/
"""

from __future__ import annotations

import importlib.util
import os
import sys

_SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..")
_BUILD = os.path.join(_SCRIPTS_DIR, "build-verify-input.py")


def _import(path: str, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


build_verify_input = _import(_BUILD, "build_verify_input")


def _label(slug: str, bucket: str, confidence: str) -> dict:
    return {"confidence": confidence, "evidence": f"{slug} evidence", "name": slug, "slug": slug}


def _round(rows: list[tuple[str, str, str]]) -> dict:
    out: dict[str, list] = {"dnb": [], "dnb_partial": [], "not_dnb": [], "unclear": []}
    for slug, bucket, confidence in rows:
        out[bucket].append(_label(slug, bucket, confidence))
    return out


def _pile(slugs: list[str]) -> list[dict]:
    return [{"mb_label_id": f"mbid-{slug}", "name": slug, "slug": slug} for slug in slugs]


def test_every_medium_and_low_confidence_verdict_is_selected():
    triage = _round(
        [("a", "dnb", "medium"), ("b", "not_dnb", "low"), ("c", "dnb", "high")]
    )
    selected = build_verify_input.build(triage, _pile(["a", "b", "c"]), disable_sample=0)
    assert {row["slug"] for row in selected} == {"a", "b"}
    assert all("low-confidence" in row["_reason"] for row in selected)


def test_high_confidence_enables_are_never_sampled():
    """An enable is reversible and already lands in a tier the operator reads; a disable is not."""
    triage = _round([(f"e{i}", "dnb", "high") for i in range(200)])
    selected = build_verify_input.build(
        triage, _pile([f"e{i}" for i in range(200)]), disable_sample=1.0
    )
    assert selected == []


def test_high_confidence_disables_are_sampled_at_about_the_given_rate():
    slugs = [f"d{i}" for i in range(1000)]
    triage = _round([(slug, "not_dnb", "high") for slug in slugs])
    selected = build_verify_input.build(triage, _pile(slugs), disable_sample=0.10)
    # Binomial around 100; a wide band still proves it is neither none nor all.
    assert 60 <= len(selected) <= 150
    assert all(row["_reason"] == "sampled-disable" for row in selected)


def test_the_sample_is_deterministic_across_runs():
    slugs = [f"d{i}" for i in range(300)]
    triage = _round([(slug, "not_dnb", "high") for slug in slugs])
    first = build_verify_input.build(triage, _pile(slugs))
    second = build_verify_input.build(triage, _pile(slugs))
    assert [row["slug"] for row in first] == [row["slug"] for row in second]


def test_a_different_salt_redraws_the_sample():
    slugs = [f"d{i}" for i in range(300)]
    triage = _round([(slug, "not_dnb", "high") for slug in slugs])
    first = {row["slug"] for row in build_verify_input.build(triage, _pile(slugs), salt="a")}
    second = {row["slug"] for row in build_verify_input.build(triage, _pile(slugs), salt="b")}
    assert first != second


def test_a_zero_sample_rate_selects_no_high_confidence_disable():
    slugs = [f"d{i}" for i in range(300)]
    triage = _round([(slug, "not_dnb", "high") for slug in slugs])
    assert build_verify_input.build(triage, _pile(slugs), disable_sample=0) == []


def test_a_verdict_that_flipped_against_a_prior_round_is_contested():
    triage = _round([("x", "dnb", "high")])
    prior = _round([("x", "unclear", "medium")])
    selected = build_verify_input.build(triage, _pile(["x"]), prior=prior, disable_sample=0)
    assert [row["slug"] for row in selected] == ["x"]
    assert selected[0]["_reason"] == "contested-reversal"


def test_a_flip_against_a_prior_REFUTATION_is_marked_separately():
    triage = _round([("x", "dnb", "high")])
    prior = {"dnb": [], "dnb_partial": [], "not_dnb": [], "unclear": []}
    prior["unclear"].append({**_label("x", "unclear", "medium"), "verifyAgrees": False})
    selected = build_verify_input.build(triage, _pile(["x"]), prior=prior, disable_sample=0)
    assert selected[0]["_reason"] == "contested-reversal-refuted"


def test_an_unchanged_verdict_is_not_contested():
    triage = _round([("x", "not_dnb", "high")])
    prior = _round([("x", "not_dnb", "high")])
    assert build_verify_input.build(triage, _pile(["x"]), prior=prior, disable_sample=0) == []


def test_reasons_compose_when_a_label_qualifies_twice():
    triage = _round([("x", "not_dnb", "medium")])
    prior = _round([("x", "dnb", "high")])
    selected = build_verify_input.build(triage, _pile(["x"]), prior=prior, disable_sample=0)
    assert selected[0]["_reason"] == "low-confidence,contested-reversal"


def test_partials_and_unclears_are_never_verified():
    """Neither writes a seed state the verifier could refute: unclear writes nothing, and a
    partial's allows are additive on a label that stays out of the seed set."""
    triage = _round([("p", "dnb_partial", "low"), ("u", "unclear", "low")])
    assert build_verify_input.build(triage, _pile(["p", "u"]), disable_sample=1.0) == []


def test_the_mbid_rides_along_so_the_verifier_researches_the_right_entity():
    triage = _round([("a", "dnb", "medium")])
    selected = build_verify_input.build(triage, _pile(["a"]), disable_sample=0)
    assert selected[0]["mb_label_id"] == "mbid-a"


def test_a_label_missing_from_the_pile_still_selects_with_a_null_mbid():
    """The caller warns on these rather than dropping them silently."""
    triage = _round([("ghost", "dnb", "medium")])
    selected = build_verify_input.build(triage, _pile([]), disable_sample=0)
    assert selected[0]["mb_label_id"] is None
