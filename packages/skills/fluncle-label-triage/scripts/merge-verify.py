#!/usr/bin/env python3
"""Merge a verify pass's second opinions back into the staged round (fluncle-label-triage, step 2b).

The verify pass tries to REFUTE each verdict it reads. What an answer then does to the round is a
safety rule, so it lives here instead of being re-derived by hand every round. Every checked row
ends in exactly one outcome:

  confirmed   the verifier reached the same bucket at HIGH confidence: the row is promoted to high.
  unsure      the verifier stayed in the same bucket below high: the row keeps its bucket and
              confidence, and its evidence carries both readings, so it stays a judgment call.
  refuted     the verifier reached a different bucket: the row moves there at the verifier's
              confidence and drops any artist rules it carried (they were proposed for a verdict
              that no longer stands). Both readings stay in its evidence.
  conflicting two answers for the same label disagree: the row is left exactly as it was.
  missing     no answer came back (a dead agent, a label an agent dropped): the row is left
              exactly as it was.

The flat `verifyAgrees` field is what the next round's `build-verify-input.py --prior` reads to
flag a contested reversal, so it is True only for confirmed and unsure.

    merge-verify.py --answers verify-result.json [--answers <more>] \
        [--triage label-triage.json] [--input verify-input.json] [--out label-triage.json]

`--answers` takes the verify workflow's result object, its task-output wrapper, or the run's
`journal.jsonl`; repeat it when a round ran more than one verify workflow. `--input` is the file the
workflow read (repeat it likewise); it carries each row's selection reason. The output defaults to
the triage file itself, and a round that already carries verify outcomes is refused, so a second
run cannot stack a second opinion onto the first.

Offline, no credentials.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from typing import Any

BUCKETS = ("dnb", "dnb_partial", "not_dnb", "unclear")
CONFIRMED = "confirmed"
UNSURE = "unsure"
REFUTED = "refuted"
CONFLICTING = "conflicting"
MISSING = "missing"
OUTCOMES = (CONFIRMED, UNSURE, REFUTED, CONFLICTING, MISSING)
VERIFY_VERDICTS = ("dnb", "not_dnb", "unclear")
MERGED_MARKERS = ("verifyOutcome", "verifyAgrees", "verifyVerdict", "refutedFrom")


class MergeError(Exception):
    """The inputs cannot be merged as given; the message says why."""


def normalize(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def read_verdicts(path: str) -> list[dict[str, Any]] | None:
    with open(path) as handle:
        raw = handle.read()

    if path.endswith(".jsonl"):
        verdicts: list[dict[str, Any]] = []
        for line in raw.splitlines():
            if not line.strip():
                continue
            entry = json.loads(line)
            if entry.get("type") == "result" and isinstance(entry.get("result"), dict):
                verdicts.extend(entry["result"].get("verdicts") or [])
        return verdicts

    data = json.loads(raw)
    if isinstance(data, dict) and isinstance(data.get("result"), dict):
        data = data["result"]
    if isinstance(data, dict) and isinstance(data.get("verdicts"), list):
        return data["verdicts"]
    if isinstance(data, list):
        return data
    return None


def load_answers(path: str) -> list[dict[str, Any]]:
    """Every verifier verdict in one answers file, whichever of the three shapes it is.

    Every verdict must carry the verify schema: a boolean `agrees` and a dnb / not_dnb / unclear
    verdict. The first-pass triage workflow leaves a journal of the same line shape without
    `agrees`, and merging it would dress first-pass verdicts up as second opinions.
    """
    verdicts = read_verdicts(path)
    if not verdicts:
        raise MergeError(
            f"{path}: no verify verdicts found "
            "(expected a result object, a task-output wrapper, or a journal.jsonl)"
        )

    foreign = [
        str(v.get("slug"))
        for v in verdicts
        if not isinstance(v.get("agrees"), bool) or v.get("verdict") not in VERIFY_VERDICTS
    ]
    if foreign:
        raise MergeError(
            f"{path}: {len(foreign)} verdict(s) lack the verify schema (a boolean `agrees` and a "
            f"dnb/not_dnb/unclear verdict), e.g. {', '.join(foreign[:3])}; "
            "is this the first-pass triage journal rather than the verify run's?"
        )
    return verdicts


def unique_index(pairs: list[tuple[str, str]]) -> dict[str, str]:
    """Map key -> slug, dropping every key that more than one label shares."""
    index: dict[str, str] = {}
    shared: set[str] = set()
    for key, slug in pairs:
        if not key:
            continue
        if key in index and index[key] != slug:
            shared.add(key)
        index.setdefault(key, slug)
    return {key: slug for key, slug in index.items() if key not in shared}


def resolve_slugs(
    answers: list[dict[str, Any]],
    checked: dict[str, dict[str, Any]],
    labels: dict[str, dict[str, Any]],
) -> tuple[dict[str, list[dict[str, Any]]], list[str]]:
    """Group answers by the checked slug they belong to.

    Verifier agents occasionally drift a slug (`3xp50und-b4t` for `3xp-50und-b4t`), so an answer
    that misses exactly falls back to its punctuation-free slug and to its label name. Two real
    labels can share those fallback keys (`re-load` and `reload`), so a key that more than one
    label shares never resolves, and `labels` is every label in the round, not only the checked
    ones: an unchecked sibling still makes a key ambiguous. An answer is left unmatched rather than
    guessed whenever its slug and its name point at different labels (including an exact slug whose
    name belongs to a sibling) or it resolves to a label the verify pass never checked.
    """
    exact_name = unique_index(
        [((row.get("name") or "").strip().casefold(), slug) for slug, row in labels.items()]
    )
    loose_name = unique_index([(normalize(row.get("name")), slug) for slug, row in labels.items()])
    loose_slug = unique_index([(normalize(slug), slug) for slug in labels])
    grouped: dict[str, list[dict[str, Any]]] = {}
    unmatched: list[str] = []

    for answer in answers:
        raw_slug = answer.get("slug")
        by_name = exact_name.get((answer.get("name") or "").strip().casefold()) or loose_name.get(
            normalize(answer.get("name"))
        )
        by_slug = raw_slug if raw_slug in labels else loose_slug.get(normalize(raw_slug))

        if by_slug and by_name and by_slug != by_name:
            slug = None
        else:
            slug = by_slug or by_name

        if slug not in checked:
            unmatched.append(str(raw_slug))
            continue
        grouped.setdefault(slug, []).append(answer)

    return grouped, unmatched


def outcome_for(bucket: str, answers: list[dict[str, Any]]) -> tuple[str, dict[str, Any] | None]:
    distinct = {(a.get("verdict"), a.get("confidence"), bool(a.get("agrees"))): a for a in answers}
    if not distinct:
        return MISSING, None
    if len(distinct) > 1:
        return CONFLICTING, None

    answer = next(iter(distinct.values()))
    if answer.get("verdict") != bucket:
        return REFUTED, answer
    if answer.get("agrees") and answer.get("confidence") == "high":
        return CONFIRMED, answer
    return UNSURE, answer


def both_readings(row: dict[str, Any], bucket: str, answer: dict[str, Any], outcome: str) -> str:
    stance = "refutes" if outcome == REFUTED else "agrees"
    return (
        f"First pass ({bucket}, {row.get('confidence')}): {row.get('evidence', '')} | "
        f"Second opinion ({answer.get('verdict')}, {answer.get('confidence')}, {stance}): "
        f"{answer.get('evidence', '')}"
    )


def merge(
    triage: dict[str, Any], checked_rows: list[dict[str, Any]], answers: list[dict[str, Any]]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return the merged round and a report of what the merge did."""
    for bucket in BUCKETS:
        for row in triage.get(bucket) or []:
            marker = next((key for key in MERGED_MARKERS if key in row), None)
            if marker:
                raise MergeError(
                    f"{row.get('slug')} already carries `{marker}` from an earlier verify merge; "
                    "merge the unmerged round instead"
                )

    checked = {row["slug"]: row for row in checked_rows}
    round_rows = {row.get("slug"): row for bucket in BUCKETS for row in triage.get(bucket) or []}
    grouped, unmatched = resolve_slugs(answers, checked, {**checked, **round_rows})
    in_round = set(round_rows)

    merged: dict[str, Any] = {key: value for key, value in triage.items() if key not in BUCKETS}
    for bucket in BUCKETS:
        merged[bucket] = []

    tally: Counter[tuple[str, str]] = Counter()
    per_row: Counter[str] = Counter()
    conflicting: list[str] = []
    flips: list[tuple[str, str, str, str]] = []

    for bucket in BUCKETS:
        for source in triage.get(bucket) or []:
            row = dict(source)
            slug = row.get("slug")
            destination = bucket

            if slug in checked:
                outcome, answer = outcome_for(bucket, grouped.get(slug, []))
                row["verifyReason"] = checked[slug].get("_reason", "")
                row["verifyOutcome"] = outcome

                if answer is not None:
                    row["verifyAgrees"] = outcome != REFUTED
                    row["verifyVerdict"] = answer.get("verdict")
                    row["verifyConfidence"] = answer.get("confidence")
                    row["verifyEvidence"] = answer.get("evidence", "")

                if outcome == CONFIRMED:
                    row["confidence"] = "high"
                elif outcome in (UNSURE, REFUTED) and answer is not None:
                    row["evidence"] = both_readings(source, bucket, answer, outcome)

                if outcome == REFUTED and answer is not None:
                    destination = answer["verdict"]
                    row["verdict"] = destination
                    row["confidence"] = answer.get("confidence")
                    row["refutedFrom"] = bucket
                    row.pop("rules", None)
                    flips.append((slug, bucket, destination, str(answer.get("confidence"))))

                per_row[outcome] += 1
                if outcome == CONFLICTING:
                    conflicting.append(slug)
                for reason in (row["verifyReason"] or "unspecified").split(","):
                    tally[(reason, outcome)] += 1

            if destination not in merged:
                raise MergeError(f"{slug}: the verifier answered an unknown bucket {destination!r}")
            merged[destination].append(row)

    counts = dict(triage.get("counts") or {})
    counts.update({bucket: len(merged[bucket]) for bucket in BUCKETS})
    counts["total"] = sum(len(merged[bucket]) for bucket in BUCKETS)
    counts["rules"] = sum(
        len(row.get("rules") or []) for bucket in BUCKETS for row in merged[bucket]
    )
    merged["counts"] = counts

    stats: dict[str, dict[str, int]] = {}
    for (reason, outcome), count in sorted(tally.items()):
        stats.setdefault(reason, {})[outcome] = count
    merged["verifyStats"] = stats

    report = {
        "checked": len(checked),
        "conflicting": sorted(conflicting),
        "flips": flips,
        "notInRound": sorted(set(checked) - in_round),
        "outcomes": {outcome: per_row[outcome] for outcome in OUTCOMES},
        "stats": stats,
        "unanswered": sorted(
            slug for slug in checked if slug in in_round and not grouped.get(slug)
        ),
        "unmatched": unmatched,
        "wrongDisables": sorted(
            slug
            for slug, origin, destination, _ in flips
            if origin == "not_dnb"
            and destination == "dnb"
            and "sampled-disable" in checked[slug].get("_reason", "")
        ),
    }
    return merged, report


def report_lines(report: dict[str, Any]) -> list[str]:
    outcomes = report["outcomes"]
    lines = [
        f"verify merge: {report['checked']} checked — "
        + ", ".join(f"{outcome} {outcomes[outcome]}" for outcome in OUTCOMES)
    ]
    for reason, counts in report["stats"].items():
        lines.append(f"  {reason}: " + ", ".join(f"{o} {n}" for o, n in counts.items()))

    sampled = report["stats"].get("sampled-disable")
    if sampled:
        lines.append(
            f"  sampled disables: {sum(sampled.values())} checked, "
            f"{len(report['wrongDisables'])} wrong (refuted to dnb)"
            + (f": {', '.join(report['wrongDisables'])}" if report["wrongDisables"] else "")
        )

    for slug, origin, destination, confidence in report["flips"]:
        if destination != "unclear":
            lines.append(f"  FLIP {slug}: {origin} -> {destination} ({confidence})")
    if report["conflicting"]:
        lines.append(
            f"  WARNING conflicting answers, left as they were, for {len(report['conflicting'])}: "
            + ", ".join(report["conflicting"])
        )
    if report["unanswered"]:
        lines.append(
            f"  WARNING no answer for {len(report['unanswered'])}: "
            + ", ".join(report["unanswered"])
        )
    if report["unmatched"]:
        lines.append(
            "  WARNING answers matching no checked label: " + ", ".join(report["unmatched"])
        )
    if report["notInRound"]:
        lines.append(
            "  WARNING checked labels absent from the round: " + ", ".join(report["notInRound"])
        )
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--triage", default="label-triage.json", help="the staged round")
    parser.add_argument(
        "--input",
        action="append",
        help="the verify input(s) the workflow read (default verify-input.json)",
    )
    parser.add_argument(
        "--answers",
        action="append",
        required=True,
        help="a verify result object, its task-output wrapper, or the run's journal.jsonl",
    )
    parser.add_argument("--out", help="where to write the merged round (default: --triage, in place)")
    args = parser.parse_args()

    with open(args.triage) as handle:
        triage = json.load(handle)
    checked_rows: list[dict[str, Any]] = []
    for path in args.input or ["verify-input.json"]:
        with open(path) as handle:
            checked_rows.extend(json.load(handle))

    try:
        answers = [answer for path in args.answers for answer in load_answers(path)]
        merged, report = merge(triage, checked_rows, answers)
    except MergeError as error:
        print(f"merge-verify: {error}", file=sys.stderr)
        return 1

    with open(args.out or args.triage, "w") as handle:
        json.dump(merged, handle, indent=1)
    for line in report_lines(report):
        print(line, file=sys.stderr)
    print(json.dumps(merged["counts"]), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
