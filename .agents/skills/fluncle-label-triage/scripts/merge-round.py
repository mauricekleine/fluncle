#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

BUCKETS = ("dnb", "dnb_partial", "not_dnb", "unclear")


class MergeError(Exception):
    pass


def normalize(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (value or "").lower())


def unique_index(pairs: list[tuple[str, str]]) -> dict[str, str]:
    candidates: dict[str, set[str]] = {}
    for key, slug in pairs:
        if key:
            candidates.setdefault(key, set()).add(slug)
    return {key: next(iter(slugs)) for key, slugs in candidates.items() if len(slugs) == 1}


def merge_round(
    scope: list[dict[str, Any]], journals: list[list[dict[str, Any]]], round_number: int | None = None
) -> tuple[dict[str, Any], list[str]]:
    by_slug = {row["slug"]: row for row in scope}
    if len(by_slug) != len(scope):
        raise MergeError("scope contains duplicate slugs")
    by_normalized_slug = unique_index([(normalize(slug), slug) for slug in by_slug])
    by_name = unique_index([(normalize(row.get("name")), row["slug"]) for row in scope])
    research: dict[str, dict[str, Any]] = {}
    census: dict[str, dict[str, Any]] = {}
    for entries in journals:
        labels = {
            entry["key"]: entry.get("label") or ""
            for entry in entries
            if entry.get("type") == "started"
        }
        results = {
            entry["key"]: entry.get("result") or {}
            for entry in entries
            if entry.get("type") == "result"
        }
        for key, result in results.items():
            if key not in labels:
                raise MergeError(f"result {key!r} has no started task label")
            destination = census if labels[key].startswith("census") else research
            for verdict in result.get("verdicts") or []:
                raw_slug = verdict.get("slug")
                if verdict.get("verdict") not in BUCKETS or "agrees" in verdict:
                    raise MergeError(f"{raw_slug}: expected a research or census verdict, not verify")
                slug_match = raw_slug if raw_slug in by_slug else by_normalized_slug.get(normalize(raw_slug))
                name_match = by_name.get(normalize(verdict.get("name")))
                if slug_match and name_match and slug_match != name_match:
                    raise MergeError(f"{raw_slug}: slug and name identify different scope labels")
                slug = slug_match or name_match
                if slug is None:
                    raise MergeError(f"{raw_slug}: no unique scope label matches the slug or name")
                if slug in destination:
                    raise MergeError(f"{slug}: duplicate {'census' if destination is census else 'research'} verdict")
                row = dict(verdict)
                if slug != raw_slug:
                    row.update(slug=slug, _slugFixedFrom=raw_slug)
                destination[slug] = row

    if not research and scope:
        raise MergeError("no research verdicts found in the journal")
    final = [census.get(slug, row) for slug, row in research.items()]
    merged = {bucket: [row for row in final if row["verdict"] == bucket] for bucket in BUCKETS}
    merged["counts"] = {
        **{bucket: len(merged[bucket]) for bucket in BUCKETS},
        "total": len(final),
        "censused": len(set(census) & set(research)),
        "rules": sum(len(row.get("rules") or []) for row in final),
    }
    if round_number is not None:
        merged["round"] = round_number
    warnings = []
    missing = sorted(set(by_slug) - set(research))
    pending = sorted(slug for slug, row in research.items() if row.get("needsCensus") and slug not in census)
    orphaned = sorted(set(census) - set(research))
    for title, slugs in [("MISSING research", missing), ("pending census", pending), ("census without research", orphaned)]:
        if slugs:
            warnings.append(f"{title}: {', '.join(slugs)}")
    return merged, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage research and census journal verdicts before merge-verify.")
    parser.add_argument("--journal", action="append", required=True, help="workflow journal.jsonl; repeat for separate research/census runs")
    parser.add_argument("--scope", required=True, help="JSON label array supplied to the research workflow")
    parser.add_argument("--round", type=int, help="optional positive round number recorded in the staged JSON")
    parser.add_argument("--out", help="output JSON path; defaults to stdout")
    args = parser.parse_args()
    if args.round is not None and args.round < 1:
        parser.error("--round must be positive")
    try:
        scope = json.loads(Path(args.scope).read_text())
        journals = [[json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()] for path in args.journal]
        merged, warnings = merge_round(scope, journals, args.round)
        serialized = json.dumps(merged, indent=1) + "\n"
        if args.out:
            Path(args.out).write_text(serialized)
        else:
            sys.stdout.write(serialized)
        prefix = f"round {args.round}: " if args.round is not None else ""
        print(prefix + json.dumps(merged["counts"]), file=sys.stderr)
        for warning in warnings:
            print(prefix + warning, file=sys.stderr)
    except (MergeError, OSError, ValueError, KeyError, TypeError) as error:
        print(f"merge-round: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
