"""Offline tests for merge-verify.py — what a second opinion does to the staged round.

No credentials, no network, no database. Run with:
  uv run --with pytest pytest packages/skills/fluncle-label-triage/scripts/tests/
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys

import pytest

_SCRIPTS_DIR = os.path.join(os.path.dirname(__file__), "..")


def _import(path: str, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


merge_verify = _import(os.path.join(_SCRIPTS_DIR, "merge-verify.py"), "merge_verify")
build_verify_input = _import(
    os.path.join(_SCRIPTS_DIR, "build-verify-input.py"), "build_verify_input"
)

BLOCK = {"artistMbid": "b1", "artistName": "Off Lane", "firstCreditCount": 3, "verdict": "block"}


def _round(rows: list[tuple[str, str, str]]) -> dict:
    out: dict = {"counts": {"censused": 1}, "dnb": [], "dnb_partial": [], "not_dnb": [], "unclear": []}
    for slug, bucket, confidence in rows:
        out[bucket].append(
            {
                "confidence": confidence,
                "evidence": f"{slug} first evidence",
                "name": slug.title(),
                "slug": slug,
                "verdict": bucket,
            }
        )
    return out


def _checked(slug: str, bucket: str, reason: str = "low-confidence") -> dict:
    return {"_reason": reason, "name": slug.title(), "slug": slug, "verdict": bucket}


def _answer(slug: str, verdict: str, confidence: str, agrees: bool) -> dict:
    return {
        "agrees": agrees,
        "confidence": confidence,
        "evidence": f"{slug} second evidence",
        "name": slug.title(),
        "slug": slug,
        "verdict": verdict,
    }


def _find(merged: dict, slug: str) -> tuple[str, dict]:
    for bucket in merge_verify.BUCKETS:
        for row in merged[bucket]:
            if row["slug"] == slug:
                return bucket, row
    raise AssertionError(f"{slug} missing from the merged round")


@pytest.mark.parametrize(
    ("bucket", "answer", "outcome", "lands_in", "confidence"),
    [
        ("dnb", ("dnb", "high", True), "confirmed", "dnb", "high"),
        ("dnb", ("dnb", "medium", True), "unsure", "dnb", "medium"),
        ("not_dnb", ("not_dnb", "high", False), "unsure", "not_dnb", "medium"),
        ("not_dnb", ("dnb", "medium", False), "refuted", "dnb", "medium"),
        ("dnb", ("unclear", "high", True), "refuted", "unclear", "high"),
    ],
)
def test_each_answer_routes_the_row_to_one_outcome(bucket, answer, outcome, lands_in, confidence):
    triage = _round([("x", bucket, "medium")])
    merged, _ = merge_verify.merge(triage, [_checked("x", bucket)], [_answer("x", *answer)])

    found_in, row = _find(merged, "x")
    assert (row["verifyOutcome"], found_in, row["confidence"]) == (outcome, lands_in, confidence)
    if outcome == "confirmed":
        assert row["evidence"] == "x first evidence"
    else:
        assert "x first evidence" in row["evidence"]
        assert "x second evidence" in row["evidence"]


def test_a_refuted_enable_drops_the_block_rules_it_was_proposed_with():
    triage = _round([("carved", "dnb", "medium")])
    triage["dnb"][0]["rules"] = [BLOCK]
    merged, _ = merge_verify.merge(
        triage,
        [_checked("carved", "dnb")],
        [_answer("carved", "unclear", "medium", False)],
    )

    bucket, row = _find(merged, "carved")
    assert bucket == "unclear"
    assert "rules" not in row
    assert row["refutedFrom"] == "dnb"
    assert merged["counts"]["rules"] == 0


@pytest.mark.parametrize(
    ("answers", "outcome", "warning"),
    [
        ([], "missing", "no answer for 1: x"),
        (
            [_answer("x", "not_dnb", "high", True), _answer("x", "dnb", "medium", False)],
            "conflicting",
            "conflicting answers, left as they were, for 1: x",
        ),
    ],
)
def test_a_row_without_one_clear_answer_is_left_as_it_was_and_named(answers, outcome, warning):
    triage = _round([("x", "not_dnb", "medium")])
    merged, report = merge_verify.merge(triage, [_checked("x", "not_dnb")], answers)

    bucket, row = _find(merged, "x")
    assert (bucket, row["confidence"], row["evidence"]) == ("not_dnb", "medium", "x first evidence")
    assert row["verifyOutcome"] == outcome
    assert "verifyAgrees" not in row
    assert any(warning in line for line in merge_verify.report_lines(report))


def test_a_drifted_verifier_slug_still_finds_its_label():
    triage = _round([("3xp-50und-b4t", "dnb", "medium")])
    drifted = _answer("3xp50und-b4t", "dnb", "high", True)
    merged, report = merge_verify.merge(triage, [_checked("3xp-50und-b4t", "dnb")], [drifted])

    _, row = _find(merged, "3xp-50und-b4t")
    assert row["verifyOutcome"] == "confirmed"
    assert report["unmatched"] == [] and report["unanswered"] == []


def test_two_labels_sharing_a_fallback_key_never_swap_answers():
    """`re-load` and `reload` both reduce to `reload`; a disable on the wrong one is terminal."""
    triage = _round([("re-load", "dnb", "medium"), ("reload", "dnb", "medium")])
    triage["dnb"][0]["name"] = "Re:Load"
    triage["dnb"][1]["name"] = "Reload"
    checked = [_checked("re-load", "dnb"), _checked("reload", "dnb")]
    checked[0]["name"], checked[1]["name"] = "Re:Load", "Reload"

    def answer(slug, name):
        return {**_answer(slug, "not_dnb", "high", False), "name": name}

    merged, report = merge_verify.merge(
        triage,
        checked,
        [answer("re-load-", "Re:Load"), answer("reload", "Re:Load"), answer("re-load-", "")],
    )

    moved_to, _ = _find(merged, "re-load")
    stayed_in, untouched = _find(merged, "reload")
    assert (moved_to, stayed_in, untouched["verifyOutcome"]) == ("not_dnb", "dnb", "missing")
    assert report["unmatched"] == ["reload", "re-load-"]


def test_an_unchecked_sibling_still_blocks_a_fallback_match():
    """Only `re-load` was checked; the answer's name belongs to the unchecked `reload`."""
    triage = _round([("re-load", "dnb", "medium"), ("reload", "dnb", "high")])
    triage["dnb"][0]["name"] = "Re:Load"
    triage["dnb"][1]["name"] = "Reload"
    checked = [{**_checked("re-load", "dnb"), "name": "Re:Load"}]
    drifted = {**_answer("re-load-", "not_dnb", "high", False), "name": "Reload"}

    merged, report = merge_verify.merge(triage, checked, [drifted])

    checked_in, checked_row = _find(merged, "re-load")
    sibling_in, sibling_row = _find(merged, "reload")
    assert (checked_in, checked_row["verifyOutcome"]) == ("dnb", "missing")
    assert (sibling_in, "verifyOutcome" in sibling_row) == ("dnb", False)
    assert report["unmatched"] == ["re-load-"]


@pytest.mark.parametrize("marker", ["verifyOutcome", "verifyAgrees", "refutedFrom"])
def test_a_round_that_already_went_through_a_verify_merge_is_refused(marker):
    triage = _round([("x", "dnb", "medium")])
    triage["dnb"][0][marker] = False

    with pytest.raises(merge_verify.MergeError):
        merge_verify.merge(triage, [_checked("x", "dnb")], [_answer("x", "dnb", "medium", True)])


def test_only_a_sampled_disable_refuted_to_dnb_counts_as_a_wrong_disable():
    """The count that decides whether the disable sample can retire."""
    triage = _round(
        [("lost", "not_dnb", "high"), ("conflated", "not_dnb", "high"), ("weak", "not_dnb", "medium")]
    )
    checked = [
        _checked("lost", "not_dnb", "sampled-disable"),
        _checked("conflated", "not_dnb", "sampled-disable"),
        _checked("weak", "not_dnb", "low-confidence"),
    ]
    answers = [
        _answer("lost", "dnb", "high", False),
        _answer("conflated", "unclear", "high", False),
        _answer("weak", "dnb", "high", False),
    ]
    _, report = merge_verify.merge(triage, checked, answers)

    assert report["wrongDisables"] == ["lost"]
    assert report["stats"]["sampled-disable"] == {"refuted": 2}


def test_a_label_checked_for_two_reasons_counts_once_in_the_outcome_totals():
    triage = _round([("x", "dnb", "medium")])
    checked = [_checked("x", "dnb", "low-confidence,contested-reversal")]
    _, report = merge_verify.merge(triage, checked, [_answer("x", "dnb", "high", True)])

    assert report["outcomes"]["confirmed"] == 1
    assert report["stats"]["low-confidence"] == {"confirmed": 1}
    assert report["stats"]["contested-reversal"] == {"confirmed": 1}


def test_the_next_round_sees_a_refutation_as_contested():
    """`build-verify-input.py --prior` reads `verifyAgrees` off the merged round."""
    triage = _round([("flip", "dnb", "medium")])
    merged, _ = merge_verify.merge(
        triage, [_checked("flip", "dnb")], [_answer("flip", "not_dnb", "medium", False)]
    )

    next_round = _round([("flip", "dnb", "medium")])
    pile = [{"mb_label_id": "m", "name": "Flip", "slug": "flip"}]
    selected = build_verify_input.build(next_round, pile, merged, disable_sample=0)
    assert "contested-reversal-refuted" in selected[0]["_reason"]


@pytest.mark.parametrize("shape", ["result", "task-output", "journal"])
def test_answers_load_from_every_file_the_verify_workflow_leaves(tmp_path, shape):
    verdicts = [_answer("a", "dnb", "high", True), _answer("b", "not_dnb", "high", True)]
    result = {"counts": {"total": 2}, "verdicts": verdicts}
    if shape == "result":
        path = tmp_path / "verify-result.json"
        path.write_text(json.dumps(result))
    elif shape == "task-output":
        path = tmp_path / "task.output"
        path.write_text(json.dumps({"agentCount": 1, "logs": [], "result": result}))
    else:
        path = tmp_path / "journal.jsonl"
        lines = [
            {"type": "launched"},
            {"agentId": "a1", "key": "k1", "type": "started"},
            {"agentId": "a1", "key": "k1", "result": {"verdicts": verdicts[:1]}, "type": "result"},
            {"agentId": "a2", "key": "k2", "type": "failed"},
            {"agentId": "a3", "key": "k3", "result": {"verdicts": verdicts[1:]}, "type": "result"},
        ]
        path.write_text("\n".join(json.dumps(line) for line in lines) + "\n")

    assert merge_verify.load_answers(str(path)) == verdicts


def test_a_file_with_no_verdicts_is_an_error_not_an_empty_merge(tmp_path):
    path = tmp_path / "verify-result.json"
    path.write_text(json.dumps({"counts": {"total": 0}}))

    with pytest.raises(merge_verify.MergeError):
        merge_verify.load_answers(str(path))


def test_the_first_pass_triage_journal_is_refused_as_answers(tmp_path):
    first_pass = {"confidence": "high", "needsCensus": False, "slug": "a", "verdict": "dnb_partial"}
    path = tmp_path / "journal.jsonl"
    path.write_text(json.dumps({"result": {"verdicts": [first_pass]}, "type": "result"}) + "\n")

    with pytest.raises(merge_verify.MergeError, match="verify schema"):
        merge_verify.load_answers(str(path))
