#!/usr/bin/env python3
"""Emit the MusicBrainz split brief for a round's conflated entities.

A conflated MBID holds two or more real labels. Fluncle's crawler walks BY MBID, so enabling one
imports the foreign catalogue wholesale — which is why a conflation is never enabled and never
carved with artist rules, only fixed upstream. This script turns a round's `conflation` objects
into a brief an editing agent can work from unattended.

Two rules are baked in because both were hand-applied and both changed an outcome:

* **The Group A/B split.** Group A is a conflation with a drum & bass catalogue trapped inside, so
  splitting it unblocks a crawl seed. Group B is broken but earns Fluncle nothing. The brief orders
  A first and tells the editor to stop rather than spend the account's standing on B — measured: a
  round where 10 of 23 entities were pure hygiene.
* **Notes are a hypothesis.** The researcher's reading is confirmed against the live catalogue, not
  taken as fact, and an ambiguous release is left in place and reported. Measured: three premises in
  a hand-written brief turned out wrong, and the editor caught all three because it was told to.

Offline, no credentials:
  python3 render-conflation-brief.py --triage label-triage.json --pile undecided.json --out brief.md
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

PREAMBLE = """# Brief: split {total} conflated MusicBrainz label entities

## Who you are working for, and why this matters

Fluncle (https://www.fluncle.com) is a drum & bass archive. Its catalogue crawler walks MusicBrainz \
label entities **by MBID**: when the operator enables a label, every release attached to that MBID \
gets crawled and its tracks stored. That only works when a MusicBrainz label entity holds exactly \
one real-world label.

Each entity below holds two or more real-world labels under one MBID. Enabling such an MBID would \
import the foreign catalogues wholesale, so the operator's standing rule is: **a conflated entity \
is never enabled and never patched around with per-artist rules; it is fixed upstream in \
MusicBrainz, and the crawler picks up the clean entity afterwards.**

Your job is to make each entity hold only one real-world label, by moving the foreign releases to \
the correct entity. This is a genuine contribution to MusicBrainz, not a workaround: every move \
must be a correction any MusicBrainz editor would agree with, and defensible to the editors who \
vote on it.

## The account and its standing

You will edit as the MusicBrainz user `fluncle`. The operator will log you in; do not ask for or \
store the password. **Its standing with other editors matters more than finishing quickly.** Every \
edit note must carry the evidence so a voter can verify it in under a minute. If a voter pushes \
back with better evidence, concede in the edit note and cancel the edit; do not argue.

## Work order — this is not a flat list

**Do Group A first and completely.** Group B is legitimate MusicBrainz hygiene but earns Fluncle \
nothing, so it is optional tail work — stop and report rather than spending the account's edit \
budget on it if anything in Group A is unfinished. Within each group the entities are ordered by \
fewest moves, so the early ones establish the pattern.

## What an edit looks like

One release at a time, in the release editor:

1. Open the release, click **Edit**, go to **Release information**, and change the label on the \
release-label row from the conflated entity to the correct one.
2. Set the label by pasting the **full entity URL** (`https://musicbrainz.org/label/<mbid>`) into \
the label field so it resolves to the exact entity. **Never pick from a same-name dropdown.** \
Verify the selection bubble shows the entity's disambiguation, not a bare name.
3. Write the edit note with the evidence, then click **Enter edit**. Wait for the page to leave the \
edit URL before navigating; navigating immediately aborts the submission.

Release-label changes are **auto-edits**: they apply immediately with no vote. That is exactly why \
the evidence in the note matters — there is no reviewer in front of the change.

Where a foreign release goes, in order of preference: an existing MusicBrainz entity for that label \
(search, and check disambiguation, area and releases); else create one at \
https://musicbrainz.org/label/create with a disambiguation that distinguishes it, ticking the \
duplicate checkbox when warned, and make the move that uses it right away (an empty new label is \
auto-removed after a few days); else, if the conflated label row is simply wrong and a third \
label's catalogue number is already on the release, remove the row instead of moving it.

**Never merge two label entities, never delete a label, and never edit recordings, artists or \
titles.** Release-label rows only.

## Before editing an entity, read its live catalogue

```
https://musicbrainz.org/ws/2/release?label=<mbid>&inc=labels+artist-credits&limit=100&fmt=json
```

Page with `offset` when `release-count` exceeds 100. **One request per second**, and a User-Agent \
naming you (e.g. `FluncleLabelSplit/1.0 ( https://www.fluncle.com )`) or you get 403.

Decide each release by, strongest first: **catalogue-number prefix** (the in-lane label almost \
always has its own scheme); **the Discogs link on the entity** (Discogs keeps same-name labels apart \
as "Name", "Name (2)" — but note the link itself sometimes points at the wrong one of the two); and \
**country, date and genre coherence**.

**The notes below are a HYPOTHESIS, not fact.** A researcher read these entities earlier; confirm \
each against the live catalogue, which may have changed. When a release is genuinely ambiguous, \
**leave it in place and say so in your report — a wrong move is worse than a missed one.**

## Browser handling that is known to be awkward on musicbrainz.org

- The **first click-and-type after a navigation is often silently dropped**. Verify every field \
landed; retry once if not.
- The release editor **autofocuses the Title field and steals the first click**. Click a neutral \
spot first, then the label field, and confirm focus before typing.
- The edit-note box is `#edit-note-text`. **All editor tabs stay mounted**, so a generic textarea \
search can find the hidden annotation box and typed text vanishes silently.
- Do not trigger browser dialogs; dismiss any that appear before continuing.

## What to report back

Per entity: how many releases it held at the start and how many you moved; where each moved release \
went (entity URL, noting any you created); anything you left in place and why; and **any note below \
that turned out to be wrong — say so plainly, a corrected hypothesis is worth more than a completed \
edit.**

---
"""


def conflations(triage: dict[str, Any]) -> list[dict[str, Any]]:
    """A conflation is always `unclear` (rail 5), and carries the filled object."""
    return [row for row in (triage.get("unclear") or []) if row.get("conflation")]


def move_count(row: dict[str, Any]) -> int:
    """Rough ordering key: how many releases the note names as moving. Ties fall back to slug."""
    moved = (row["conflation"].get("moveOut") or "").strip()
    return len([part for part in moved.split(";") if part.strip()]) or 1


def render(triage: dict[str, Any], pile: list[dict[str, Any]]) -> str:
    mbids = {row["slug"]: row.get("mb_label_id") for row in pile}
    rows = conflations(triage)
    if not rows:
        return ""

    group_a = [row for row in rows if row["conflation"].get("dnbStrandWorthRecovering")]
    group_b = [row for row in rows if not row["conflation"].get("dnbStrandWorthRecovering")]
    for group in (group_a, group_b):
        group.sort(key=lambda row: (move_count(row), row["slug"]))

    out = [PREAMBLE.format(total=len(rows))]
    out.append(f"# Appendix: the {len(rows)} entities\n")

    def section(title: str, blurb: str, group: list[dict[str, Any]], start: int) -> int:
        if not group:
            return start
        out.append(f"\n## {title}\n\n{blurb}\n")
        index = start
        for row in group:
            conflation = row["conflation"]
            out.append(f"\n### {index}. {row['name']} — `{mbids.get(row['slug']) or 'NO MBID'}`\n")
            out.append(f"\n**Keep:** {conflation.get('keep', '').strip()}\n")
            out.append(f"\n**Move out:** {conflation.get('moveOut', '').strip()}\n")
            trap = (conflation.get("trap") or "").strip()
            if trap:
                out.append(f"\n**Careful:** {trap}\n")
            index += 1
        return index

    nxt = section(
        "Group A — a drum & bass label is trapped inside",
        "Splitting these directly unblocks a crawl seed the operator wants. Do them first.",
        group_a,
        1,
    )
    section(
        "Group B — no drum & bass strand; MusicBrainz hygiene only",
        "These are correct edits but earn Fluncle nothing. Do them only if Group A is complete.",
        group_b,
        nxt,
    )
    return "".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--triage", default="label-triage.json")
    parser.add_argument("--pile", default="undecided.json")
    parser.add_argument("--out", default="mb-split-brief.md")
    args = parser.parse_args()

    with open(args.triage) as handle:
        triage = json.load(handle)
    with open(args.pile) as handle:
        pile = json.load(handle)

    brief = render(triage, pile)
    if not brief:
        print("no conflations in this round — no brief written")
        return 0
    with open(args.out, "w") as handle:
        handle.write(brief)

    rows = conflations(triage)
    worth = sum(1 for row in rows if row["conflation"].get("dnbStrandWorthRecovering"))
    print(f"{len(rows)} conflations -> {args.out}")
    print(f"  Group A (drum & bass strand to recover): {worth}")
    print(f"  Group B (hygiene only): {len(rows) - worth}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
