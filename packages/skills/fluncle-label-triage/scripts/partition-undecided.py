#!/usr/bin/env python3
"""The triage pull's partition step: which undecided labels this round actually researches.

Split out of `pull-undecided.sh` so the two exclusions are testable without a database — the
pull's other half is SQL over production Turso, this half is pure. Reads the undecided rows on
stdin and the artist rules from `calib-rules.json` in CWD, writes the researchable rows to stdout
and the per-bucket report to stderr, exactly as the pull's inline step used to.

  pull-undecided.sh  →  partition-undecided.py  →  undecided.json

The two exclusions and the reasoning behind each live in `pull-undecided.sh`'s header, which is
the one place they are explained.
"""

from __future__ import annotations

import json
import sys

# The verdict buckets, in the order the report prints them.
FRESH = "fresh"
SETTLED = "settled"
UNIDENTIFIED = "unidentified"


def rules_by_label(rules: list[dict]) -> dict[str, list[dict]]:
    """Group the PER-LABEL artist rules by their label id; a global rule belongs to no label."""
    grouped: dict[str, list[dict]] = {}

    for rule in rules:
        if rule.get("label_id"):
            grouped.setdefault(rule["label_id"], []).append(
                {
                    "artistMbid": rule.get("artist_mbid"),
                    "artistName": rule.get("artist_name"),
                    "verdict": rule.get("verdict"),
                }
            )

    return grouped


def partition(rows: list[dict], rules: list[dict]) -> dict[str, list[dict]]:
    """Stamp each undecided row with its per-label rules and sort it into one of three buckets.

    UNIDENTIFIED is tested FIRST: a row with no `mb_label_id` names no MusicBrainz entity, so it
    is unresearchable whatever else it carries. SETTLED is the rule-carrying `dnb_partial`. What
    is left is FRESH — the round's worklist.
    """
    grouped = rules_by_label(rules)
    buckets: dict[str, list[dict]] = {FRESH: [], SETTLED: [], UNIDENTIFIED: []}

    for row in rows:
        row["rules"] = grouped.get(row.get("id"), [])

        if not row.get("mb_label_id"):
            buckets[UNIDENTIFIED].append(row)
        elif row["rules"]:
            buckets[SETTLED].append(row)
        else:
            buckets[FRESH].append(row)

    return buckets


def report(buckets: dict[str, list[dict]]) -> list[str]:
    """The stderr lines, as a list so a test can read them without capturing a stream."""
    total = sum(len(rows) for rows in buckets.values())
    lines = [
        f"undecided: {total} | settled dnb_partial (skipped): {len(buckets[SETTLED])} | "
        f"no mb_label_id (skipped): {len(buckets[UNIDENTIFIED])} | to triage: {len(buckets[FRESH])}"
    ]

    if buckets[SETTLED]:
        lines.append("  skipped: " + ", ".join(sorted(row["slug"] for row in buckets[SETTLED])))

    if buckets[UNIDENTIFIED]:
        lines.append(
            "  no mb_label_id: "
            + ", ".join(sorted(row["slug"] for row in buckets[UNIDENTIFIED]))
        )
        lines.append(
            "  → resolve each label's MusicBrainz identity before it can be ruled on "
            "(an undecided label never gets the crawl tick that would resolve it)."
        )

    return lines


def main() -> None:
    rows = json.load(sys.stdin)

    with open("calib-rules.json") as handle:
        rules = json.load(handle)

    buckets = partition(rows, rules)

    for line in report(buckets):
        print(line, file=sys.stderr)

    json.dump(buckets[FRESH], sys.stdout, indent=0)


if __name__ == "__main__":
    main()
