#!/usr/bin/env python3
"""Render a triage round for the operator's ratification (fluncle-label-triage skill, step 3).

Turns the staged verdicts (`label-triage.json`, the triage workflow's result object) into ONE
local HTML page and prints its path. A local file, never a hosted artifact — the round is the
operator's own working material.

    render-ratification.py [--triage-file label-triage.json] [--out label-triage.html]

The page leads with the ARTIST-RULE PROPOSALS, because those are the new judgment: each one is a
first-credit exception that changes what the next crawl takes, and each carries its evidence, its
census first-credit count, and whether the freshness tap can see it (a TAP-BLIND rule is enforced
by the crawler alone). Then the plain buckets, judgment calls first. Reads nothing but the file.
"""

from __future__ import annotations

import argparse
import html
import json
import os

BUCKET_TITLES = {
    "dnb": "Enable",
    "dnb_partial": "Stay disabled, take these artists",
    "not_dnb": "Disable",
    "unclear": "Left for your ear",
}

CSS = """
:root { color-scheme: dark; }
body { margin: 0 auto; padding: 2rem 1.25rem 6rem; max-width: 60rem; background: #0b0d12;
  color: #e6e8ef; font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.1rem; margin: 2.5rem 0 .75rem; border-bottom: 1px solid #232838; padding-bottom: .4rem; }
.sub { color: #8b93a7; margin: 0 0 2rem; }
.label { border: 1px solid #232838; border-radius: 10px; padding: .9rem 1rem; margin: 0 0 .75rem;
  background: #11141c; }
.label h3 { margin: 0 0 .3rem; font-size: 1rem; }
.label h3 .slug { color: #8b93a7; font-weight: 400; font-size: .82rem; margin-left: .5rem; }
.meta { color: #8b93a7; font-size: .85rem; margin: .35rem 0 0; }
.evidence { margin: .4rem 0 0; }
table { border-collapse: collapse; width: 100%; margin: .7rem 0 0; font-size: .88rem; }
th, td { text-align: left; padding: .35rem .5rem; border-top: 1px solid #232838; vertical-align: top; }
th { color: #8b93a7; font-weight: 500; }
.tag { display: inline-block; padding: .05rem .45rem; border-radius: 999px; font-size: .74rem;
  border: 1px solid #2c3247; color: #b9c0d4; }
.block { border-color: #6b2b34; color: #ff9aa6; }
.allow { border-color: #2c5f3c; color: #86e0a6; }
.blind { border-color: #6b5a2b; color: #f0d08a; }
.low { border-color: #6b5a2b; color: #f0d08a; }
.note { color: #f0d08a; margin: .5rem 0 0; font-size: .88rem; }
.empty { color: #8b93a7; font-style: italic; }
"""


def esc(value) -> str:
    return html.escape("" if value is None else str(value))


def rule_rows(rules: list[dict]) -> str:
    body = []
    for rule in rules:
        verdict = rule.get("verdict", "")
        bridge = rule.get("tapBridge", "unknown")
        bridge_tag = (
            '<span class="tag blind">tap-blind</span>'
            if bridge == "no"
            else f'<span class="tag">tap {esc(bridge)}</span>'
        )
        count = rule.get("firstCreditCount")
        inert = (
            ' <span class="tag blind">inert — will be dropped</span>'
            if not isinstance(count, (int, float)) or count <= 0
            else ""
        )
        body.append(
            f"<tr><td><span class='tag {esc(verdict)}'>{esc(verdict)}</span></td>"
            f"<td><strong>{esc(rule.get('artistName'))}</strong><br>"
            f"<span class='meta'>{esc(rule.get('artistMbid'))}</span></td>"
            f"<td>{esc(count)}{inert}</td><td>{bridge_tag}</td>"
            f"<td>{esc(rule.get('evidence'))}</td></tr>"
        )

    return (
        "<table><tr><th></th><th>Artist</th><th>First credits</th><th>Tap</th>"
        "<th>Evidence</th></tr>" + "".join(body) + "</table>"
    )


def label_card(row: dict, bucket: str) -> str:
    parts = [
        f"<div class='label'><h3>{esc(row.get('name'))}"
        f"<span class='slug'>{esc(row.get('slug'))}</span></h3>"
    ]
    confidence = row.get("confidence")
    tag_class = "low" if confidence in ("low", "medium") else ""
    parts.append(
        f"<p class='meta'><span class='tag {tag_class}'>{esc(confidence)} confidence</span> "
        f"{esc(BUCKET_TITLES.get(bucket, bucket))}</p>"
    )
    parts.append(f"<p class='evidence'>{esc(row.get('evidence'))}</p>")
    if row.get("notable"):
        parts.append(f"<p class='meta'>Notable: {esc(row['notable'])}</p>")
    if row.get("censusSummary"):
        parts.append(f"<p class='meta'>Census: {esc(row['censusSummary'])}</p>")
    if row.get("imprintChild") and row["imprintChild"] != "none":
        parts.append(f"<p class='note'>MusicBrainz imprint child: {esc(row['imprintChild'])}</p>")
    if row.get("offLaneFirstCreditShare") is not None:
        parts.append(
            f"<p class='meta'>Off-lane first-credit share: {esc(row['offLaneFirstCreditShare'])}</p>"
        )
    if row.get("rules"):
        parts.append(rule_rows(row["rules"]))
    if row.get("globalSuggestion"):
        parts.append(
            f"<p class='note'>Global suggestion (yours to author, never applied here): "
            f"{esc(row['globalSuggestion'])}</p>"
        )
    parts.append("</div>")

    return "".join(parts)


def render(triage: dict) -> str:
    buckets = {key: triage.get(key) or [] for key in BUCKET_TITLES}
    ruled = [(key, row) for key, rows in buckets.items() for row in rows if row.get("rules")]
    total = sum(len(rows) for rows in buckets.values())
    rule_total = sum(len(row.get("rules") or []) for _, row in ruled)

    sections = [
        "<h1>Label triage — ratify this round</h1>",
        f"<p class='sub'>{total} labels · {rule_total} artist rules proposed on {len(ruled)} of them · "
        f"{len(buckets['unclear'])} left for your ear. A rule changes what the next crawl takes; "
        f"everything already here stays.</p>",
        "<h2>Artist rules — the judgment calls</h2>",
    ]
    if ruled:
        sections.extend(label_card(row, key) for key, row in ruled)
    else:
        sections.append("<p class='empty'>No rules proposed this round.</p>")

    for key, title in BUCKET_TITLES.items():
        rows = [row for row in buckets[key] if not row.get("rules")]
        sections.append(f"<h2>{esc(title)} — {len(rows)}</h2>")
        if not rows:
            sections.append("<p class='empty'>None.</p>")
            continue
        # Judgment calls first: the low-confidence reads are the ones worth his eyes.
        rows.sort(key=lambda r: {"low": 0, "medium": 1, "high": 2}.get(r.get("confidence"), 0))
        sections.extend(label_card(row, key) for row in rows)

    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width, initial-scale=1'>"
        f"<title>Label triage — ratify this round</title><style>{CSS}</style></head><body>"
        + "".join(sections)
        + "</body></html>"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--triage-file", default="label-triage.json")
    parser.add_argument("--out", default="label-triage.html")
    args = parser.parse_args()

    triage = json.load(open(args.triage_file))
    with open(args.out, "w") as handle:
        handle.write(render(triage))
    print(os.path.abspath(args.out))


if __name__ == "__main__":
    main()
