#!/usr/bin/env python3
"""Build the verify pass's input from a staged round.

The verify pass is a second opinion that tries to REFUTE a verdict, and it is the round's only
defence against a confident wrong call. Which verdicts it covers is therefore a safety decision,
not a convenience one, and this script is where that decision lives so a round cannot quietly
drift from it.

Three populations go in:

1. **Every medium/low-confidence `dnb` and `not_dnb`.** The original bar. A verdict the researcher
   would not stake "high" on is the one most likely to be wrong in either direction.

2. **A sampled slice of HIGH-confidence `not_dnb`.** A disable is terminal: the pull reads only
   `undecided`, so a disabled label never returns to the pile and a wrong disable silently loses
   good music forever. High-confidence disables have never been checked, which means their error
   rate is unmeasured rather than low. The sample is deterministic in the round's own slugs, so a
   re-run picks the same labels and a resume does not reshuffle the set.

3. **Contested reversals.** A label whose verdict flipped against a previous round — especially one
   a previous verify pass refuted — is contested by construction, and its confidence alone will not
   flag it. (Measured: two labels a verify pass refuted came back `dnb` the next round; the second
   verify refuted one again and confirmed the other on new evidence. Both needed looking at.)

Offline, no credentials:
  python3 build-verify-input.py --triage label-triage.json --pile undecided.json --out verify-input.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from typing import Any

BUCKETS = ("dnb", "not_dnb", "dnb_partial", "unclear")
VERIFIABLE = ("dnb", "not_dnb")
LOW_CONFIDENCE = ("medium", "low")

# The sampled disable rate, and the reason it is not zero: see the module docstring. Three rounds of
# a clean sample retire it; one wrong disable found justifies it permanently.
DEFAULT_DISABLE_SAMPLE = 0.10


def sample_hash(slug: str, salt: str) -> float:
    """Stable 0–1 position for a slug. Deterministic across runs, resumes and machines."""
    digest = hashlib.sha256(f"{salt}:{slug}".encode()).digest()
    return int.from_bytes(digest[:8], "big") / float(1 << 64)


def index_prior(prior: dict[str, Any] | None) -> dict[str, tuple[str, bool | None]]:
    """Map slug -> (bucket, verifyAgrees) from a previous round, for the contested check."""
    if not prior:
        return {}
    out: dict[str, tuple[str, bool | None]] = {}
    for bucket in BUCKETS:
        for row in prior.get(bucket) or []:
            out[row["slug"]] = (bucket, row.get("verifyAgrees"))
    return out


def build(
    triage: dict[str, Any],
    pile: list[dict[str, Any]],
    prior: dict[str, Any] | None = None,
    disable_sample: float = DEFAULT_DISABLE_SAMPLE,
    salt: str = "verify",
) -> list[dict[str, Any]]:
    mbids = {row["slug"]: row.get("mb_label_id") for row in pile}
    was = index_prior(prior)
    selected: list[dict[str, Any]] = []

    for bucket in VERIFIABLE:
        for row in triage.get(bucket) or []:
            slug = row["slug"]
            confidence = row.get("confidence")
            reasons: list[str] = []

            if confidence in LOW_CONFIDENCE:
                reasons.append("low-confidence")

            # A disable is terminal, so a slice of the confident ones is checked anyway.
            if bucket == "not_dnb" and confidence == "high":
                if sample_hash(slug, salt) < disable_sample:
                    reasons.append("sampled-disable")

            prior_bucket, prior_agrees = was.get(slug, (None, None))
            if prior_bucket is not None and prior_bucket != bucket:
                reasons.append(
                    "contested-reversal-refuted"
                    if prior_agrees is False
                    else "contested-reversal"
                )

            if not reasons:
                continue

            selected.append(
                {
                    "_reason": ",".join(reasons),
                    "confidence": confidence,
                    "evidence": row.get("evidence", ""),
                    "mb_label_id": mbids.get(slug),
                    "name": row.get("name"),
                    "notable": row.get("notable", ""),
                    "slug": slug,
                    "verdict": bucket,
                }
            )

    selected.sort(key=lambda row: (row["verdict"], row["slug"]))
    return selected


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--triage", default="label-triage.json", help="the staged round")
    parser.add_argument("--pile", default="undecided.json", help="the pull, for mb_label_id")
    parser.add_argument("--prior", help="a previous round's staged verdicts, for the contested check")
    parser.add_argument("--out", default="verify-input.json")
    parser.add_argument(
        "--disable-sample",
        type=float,
        default=DEFAULT_DISABLE_SAMPLE,
        help="fraction of HIGH-confidence disables to verify anyway (0 disables the sample)",
    )
    parser.add_argument("--salt", default="verify", help="sampling salt; change to redraw")
    args = parser.parse_args()

    with open(args.triage) as handle:
        triage = json.load(handle)
    with open(args.pile) as handle:
        pile = json.load(handle)
    prior = None
    if args.prior:
        with open(args.prior) as handle:
            prior = json.load(handle)

    selected = build(triage, pile, prior, args.disable_sample, args.salt)
    with open(args.out, "w") as handle:
        json.dump(selected, handle, indent=1)

    counts: dict[str, int] = {}
    for row in selected:
        for reason in row["_reason"].split(","):
            counts[reason] = counts.get(reason, 0) + 1
    print(f"verify set: {len(selected)} -> {args.out}")
    for reason, count in sorted(counts.items()):
        print(f"  {reason}: {count}")
    missing = [row["slug"] for row in selected if not row["mb_label_id"]]
    if missing:
        print(f"  WARNING no mb_label_id on {len(missing)}: {', '.join(missing[:5])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
