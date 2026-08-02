#!/usr/bin/env python3
"""Apply a label-triage round's operator-RATIFIED rulings (fluncle-label-triage skill, step 4).

Reads the staged verdicts (label-triage.json in CWD: the triage workflow's result object) and
writes them through the operator-tier label ops:

    dnb          -> PATCH  {seedState: "enabled"}   (+ PUT the label's block rules, when it carries any)
    not_dnb      -> PATCH  {seedState: "disabled"}
    dnb_partial  -> PUT    the label's allow rules ONLY; the seed state is NEVER touched
    unclear      -> nothing at all (it stays undecided for the operator's own ear)

    apply-rulings.py pilot     # ONE label, verify the round-trip, exit
    apply-rulings.py apply     # the rest
    apply-rulings.py rescope   # maintenance: re-check existing rules against MusicBrainz
    apply-rulings.py apply --dry-run   # print the planned HTTP calls, touch nothing, need no creds

THE RULE MODEL (docs/label-entity.md): a rule is a FIRST-CREDIT exception to the
label's seed state. A `block` on an enabled label refuses that act's own records; an `allow` on a
label that stays disabled takes theirs and nobody else's. Rules change what the NEXT crawl takes
and touch nothing already stored.

Safety shape, learned over four live rounds (2026-07-26/27) and extended for rules:
  - Only rows the server STILL lists as `undecided` are written (other sessions and the operator
    rule labels too; a slug that moved since the triage is skipped and reported, never clobbered).
  - Idempotent: a second `apply` finds nothing left in-plan and writes zero rows.
  - INERT-RULE GUARD: a proposed rule with `firstCreditCount <= 0` can never fire (it matches no
    first credit on the census), so it is dropped and reported rather than written.
  - Verdict/state coherence: `dnb` rows may carry `block` rules only, `dnb_partial` rows `allow`
    rules only; a mismatch refuses the whole row. `dnb_partial` REQUIRES rules (without them it is
    just an undecided label, and writing an empty set would only re-arm the crawl for nothing).
  - GLOBAL rules are never machine-applied. A round may only ever suggest one in prose
    (`globalSuggestion`); the operator authors globals himself with `fluncle admin artists rule`.
  - A rule PUT is a WHOLE-SET SWAP that re-arms the label's crawl scope. Rules the operator added
    by hand and the round did not re-propose are replaced away — the report says so per label.
  - The API sits behind Cloudflare, which 1010-rejects the default Python-urllib signature --
    every request carries a real User-Agent.
Needs FLUNCLE_API_TOKEN (operator) + FLUNCLE_API_BASE_URL in the env (`set -a; source ...`),
except under --dry-run, which makes no request at all.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = "fluncle-label-triage/1.0 (operator)"
MB_USER_AGENT = "FluncleLabelTriage/1.0 ( https://www.fluncle.com )"
MB_PACE_SECONDS = 1.2
RULE_LIMIT = 100  # replace_label_artist_rules caps a request at 100 rules.
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

# verdict bucket -> (seed state to write or None, the only rule verdict the bucket may carry)
BUCKETS = {
    "dnb": ("enabled", "block"),
    "not_dnb": ("disabled", None),
    "dnb_partial": (None, "allow"),
}


# ── HTTP ────────────────────────────────────────────────────────────────────────────────────


class Api:
    """The Fluncle admin API, or a dry-run recorder that performs no I/O."""

    def __init__(self, dry_run: bool) -> None:
        self.dry_run = dry_run
        self.planned: list[tuple[str, str, object]] = []
        self.base = "" if dry_run else os.environ["FLUNCLE_API_BASE_URL"].rstrip("/")
        self.token = "" if dry_run else os.environ["FLUNCLE_API_TOKEN"]

    def call(self, method: str, path: str, body=None):
        if self.dry_run:
            self.planned.append((method, path, body))
            print(f"  WOULD {method} {path}" + (f"  {json.dumps(body)}" if body else ""))
            return 200, {"dryRun": True}

        req = urllib.request.Request(
            self.base + path,
            method=method,
            data=json.dumps(body).encode() if body else None,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                # Cloudflare 1010s the default Python-urllib signature -- send a real UA.
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()[:200]


def musicbrainz(path: str):
    """One paced MusicBrainz read. Returns (status, payload). 1 req/s + a real UA, or 403s."""
    req = urllib.request.Request(
        "https://musicbrainz.org/ws/2/" + path,
        headers={"Accept": "application/json", "User-Agent": MB_USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]
    except OSError as e:  # network down, DNS, timeout
        return 0, str(e)[:200]
    finally:
        time.sleep(MB_PACE_SECONDS)


# ── The plan ────────────────────────────────────────────────────────────────────────────────


def normalize_rules(row: dict, want_verdict: str | None) -> tuple[list[dict], list[str]]:
    """Validate one row's proposed rules against the wire contract + the inert-rule guard.

    Returns (rules ready for the PUT body, human reasons a rule was dropped or the row refused).
    A reason starting with `REFUSED` means the whole row must not be written.
    """
    proposed = row.get("rules") or []
    kept: list[dict] = []
    notes: list[str] = []
    seen: set[str] = set()

    if proposed and want_verdict is None:
        return [], [f"REFUSED {row['slug']}: a not_dnb row may not carry artist rules"]

    for rule in proposed:
        mbid = str(rule.get("artistMbid") or "").strip()
        name = str(rule.get("artistName") or "").strip()
        verdict = rule.get("verdict")
        who = name or mbid or "<unnamed>"

        if not UUID_RE.match(mbid):
            notes.append(f"dropped {who}: artistMbid is not an MBID ({mbid!r})")
            continue
        if not name:
            notes.append(f"dropped {mbid}: blank artistName (the API rejects it)")
            continue
        if verdict != want_verdict:
            return [], [
                f"REFUSED {row['slug']}: rule for {who} is {verdict!r}, "
                f"but a {row['verdict']} row may carry only {want_verdict!r} rules"
            ]
        # The inert-rule guard: zero first credits on the census means the rule can never fire.
        count = rule.get("firstCreditCount")
        if not isinstance(count, (int, float)) or count <= 0:
            notes.append(f"dropped {who}: inert — {count!r} first credits on the census")
            continue
        if mbid in seen:
            notes.append(f"dropped duplicate {who}: {mbid} already in this label's set")
            continue

        seen.add(mbid)
        kept.append({"artistMbid": mbid, "artistName": name, "verdict": verdict})

    if len(kept) > RULE_LIMIT:
        return [], [f"REFUSED {row['slug']}: {len(kept)} rules exceeds the API's {RULE_LIMIT}"]

    return kept, notes


def build_plan(triage: dict) -> tuple[list[dict], list[str]]:
    """Turn the staged verdicts into per-label write plans. Never touches `unclear`."""
    plan: list[dict] = []
    notes: list[str] = []

    for bucket, (seed_state, rule_verdict) in BUCKETS.items():
        for row in triage.get(bucket) or []:
            row = {**row, "verdict": bucket}
            rules, row_notes = normalize_rules(row, rule_verdict)
            refused = [n for n in row_notes if n.startswith("REFUSED")]
            notes.extend(row_notes)
            if refused:
                continue
            if bucket == "dnb_partial" and not rules:
                notes.append(
                    f"REFUSED {row['slug']}: dnb_partial with no applicable allow rule is just "
                    f"an undecided label — left undecided"
                )
                continue
            plan.append(
                {
                    "bucket": bucket,
                    "name": row.get("name", row["slug"]),
                    "rules": rules,
                    "seedState": seed_state,
                    "slug": row["slug"],
                }
            )

    if any(row.get("globalSuggestion") for bucket in BUCKETS for row in triage.get(bucket) or []):
        notes.append(
            "NOTE global-rule suggestions are present in the staged file and are NOT applied — "
            "the operator authors globals with `fluncle admin artists rule`"
        )

    return plan, notes


def write_row(api: Api, entry: dict, label_id: str) -> tuple[bool, str]:
    """Apply one planned row. Returns (ok, detail)."""
    if entry["seedState"]:
        code, res = api.call(
            "PATCH", f"/api/v1/admin/labels/{label_id}", {"seedState": entry["seedState"]}
        )
        got = (res.get("label") or {}).get("seedState") if isinstance(res, dict) else None
        if api.dry_run:
            got = entry["seedState"]
        if code != 200 or got != entry["seedState"]:
            return False, f"PATCH {code} {str(res)[:90]}"

    if entry["rules"]:
        code, res = api.call(
            "PUT", f"/api/v1/admin/labels/{label_id}/artists", {"rules": entry["rules"]}
        )
        written = len(res.get("rules") or []) if isinstance(res, dict) else 0
        if api.dry_run:
            written = len(entry["rules"])
        if code != 200 or written != len(entry["rules"]):
            return False, f"PUT {code} {str(res)[:90]}"

    return True, f"{entry['seedState'] or 'undecided (unchanged)'} + {len(entry['rules'])} rule(s)"


# ── Modes ───────────────────────────────────────────────────────────────────────────────────


def load_live(api: Api, args) -> dict[str, str]:
    """slug -> id for the labels the server STILL lists as undecided (never a stale local list)."""
    if api.dry_run:
        if not os.path.exists(args.live_file):
            raise SystemExit(
                f"--dry-run needs {args.live_file}: a fixture of the server's undecided list, "
                f'either [{{"slug": …, "id": …}}] or {{"labels": [...]}}'
            )
        raw = json.load(open(args.live_file))
    else:
        status, raw = api.call("GET", "/api/v1/admin/labels?seedState=undecided")
        assert status == 200, f"list failed: {status} {raw}"

    rows = raw["labels"] if isinstance(raw, dict) else raw
    return {r["slug"]: r["id"] for r in rows}


def label_scope_stamp(api: Api, label_id: str, seed_state: str) -> str | None:
    """Read one label's current `scopeChangedAt` (the re-arm watermark) off the admin list."""
    code, raw = api.call("GET", f"/api/v1/admin/labels?seedState={seed_state}")
    if code != 200 or not isinstance(raw, dict):
        return None
    for row in raw.get("labels") or []:
        if row["id"] == label_id:
            return row.get("scopeChangedAt")
    return None


def run_apply(api: Api, args) -> int:
    undecided = load_live(api, args)
    print(f"server says undecided: {len(undecided)}")

    triage = json.load(open(args.triage_file))
    plan, notes = build_plan(triage)
    for note in notes:
        print(f"  {note}")

    missing = [e["slug"] for e in plan if e["slug"] not in undecided]
    if missing:
        print(f"SKIPPING {len(missing)} no longer undecided: {missing[:5]}")
    plan = [e for e in plan if e["slug"] in undecided]

    unclear = {r["slug"] for r in triage.get("unclear") or []}
    assert not (unclear & {e["slug"] for e in plan}), "unclear leaked into the plan"

    enables = sum(1 for e in plan if e["seedState"] == "enabled")
    disables = sum(1 for e in plan if e["seedState"] == "disabled")
    partials = sum(1 for e in plan if e["bucket"] == "dnb_partial")
    rules = sum(len(e["rules"]) for e in plan)
    print(
        f"plan: {enables} enable, {disables} disable, {partials} rules-only (seed state untouched), "
        f"{rules} artist rule(s), {len(unclear)} left undecided"
    )

    if not plan:
        print("nothing to apply")
        return 0

    if args.mode == "pilot":
        # Pilot a RULE-CARRYING label when the round proposed any — the rule leg is the new
        # machinery, so it is the leg worth proving before the batch runs.
        entry = next((e for e in plan if e["rules"]), plan[0])
        label_id = undecided[entry["slug"]]
        print(f"\nPILOT -> {entry['name']} ({entry['slug']}) => {entry['bucket']}")
        before = None if api.dry_run else label_scope_stamp(api, label_id, "undecided")
        ok, detail = write_row(api, entry, label_id)
        print(f"  wrote: {detail}" if ok else f"  FAILED: {detail}")
        if not ok:
            return 1
        if api.dry_run:
            return 0

        # Round-trip: the rule set the server actually holds, and a moved re-arm watermark.
        code, res = api.call("GET", f"/api/v1/admin/labels/{label_id}/artists")
        live_rules = res.get("rules") or [] if isinstance(res, dict) else []
        want = {(r["artistMbid"], r["verdict"]) for r in entry["rules"]}
        got = {(r["artistMbid"], r["verdict"]) for r in live_rules}
        print(f"  rules round-trip: GET {code}, {len(live_rules)} on the server")
        for rule in live_rules:
            bridge = "tap-bridged" if rule.get("artistSpotifyId") else "TAP-BLIND"
            print(f"    {rule['verdict']:5} {rule['artistName']} ({rule['artistMbid']}) {bridge}")
        after = label_scope_stamp(api, label_id, entry["seedState"] or "undecided")
        print(f"  scopeChangedAt: {before} -> {after}")

        if want != got:
            print("  MISMATCH: the server's rule set is not what was sent")
            return 1
        if entry["rules"] and (after is None or after == before):
            print("  scopeChangedAt did not move — the re-walk was not armed")
            return 1
        return 0

    ok = fail = 0
    failures = []
    for i, entry in enumerate(plan, 1):
        succeeded, detail = write_row(api, entry, undecided[entry["slug"]])
        if succeeded:
            ok += 1
        else:
            fail += 1
            failures.append((entry["slug"], detail))
        if i % 25 == 0 or i == len(plan):
            print(f"  {i}/{len(plan)}  ok={ok} fail={fail}")
        if not api.dry_run:
            time.sleep(0.12)

    print(f"\nDONE ok={ok} fail={fail}")
    for f in failures[:10]:
        print("  FAILED", f)
    return 1 if fail else 0


def load_rescope_rules(api: Api, args) -> list[dict]:
    """The maintenance worklist: every artist rule Fluncle holds, with the label it is scoped to.

    Preferred source is `calib-rules.json` (pull-undecided.sh writes it from the DB in one read).
    Without it, walk the API: the armed labels, then each one's rule set.
    """
    if os.path.exists(args.rules_file):
        rows = json.load(open(args.rules_file))
        print(f"rescope worklist: {len(rows)} rule(s) from {args.rules_file}")
        return rows

    print(f"{args.rules_file} not found — walking the API instead")
    rows: list[dict] = []
    code, raw = api.call("GET", "/api/v1/admin/artist-rules")
    if code == 200 and isinstance(raw, dict):
        for rule in raw.get("rules") or []:
            rows.append({**rule, "label_id": None, "label_name": None})

    for seed_state in ("enabled", "disabled"):
        code, raw = api.call("GET", f"/api/v1/admin/labels?seedState={seed_state}")
        if code != 200 or not isinstance(raw, dict):
            continue
        # Only labels whose scope has ever been armed can carry rules; that is the bounded set.
        armed = [row for row in raw.get("labels") or [] if row.get("scopeChangedAt")]
        print(f"  {seed_state}: {len(armed)} armed label(s) to read")
        for label in armed[: args.limit]:
            code, res = api.call("GET", f"/api/v1/admin/labels/{label['id']}/artists")
            if code != 200 or not isinstance(res, dict):
                continue
            for rule in res.get("rules") or []:
                rows.append({**rule, "label_id": label["id"], "label_name": label["name"]})

    print(f"rescope worklist: {len(rows)} rule(s) from the API")
    return rows


def run_rescope(api: Api, args) -> int:
    """Re-check every existing rule's MB identity. READ-ONLY: it never fixes anything.

    Drift shows up three ways, and each is reported for the operator to act on by hand:
      - MERGED — MusicBrainz answered with a DIFFERENT entity id than the one requested (an MB
        merge redirects), so the rule's match key now points at a merged-away artist.
      - GONE — the entity 404s.
      - RENAMED — the entity's name no longer matches the credited spelling the rule was written
        with (display only; the rule still matches, since the MBID is the key).

    The refresh WRITE half (stamping `resolved_mbid` / `resolved_name` / `checked_at` on the rule)
    has no API carrier today: `replace_label_artist_rules` takes only
    `{artistMbid, artistName, verdict}` and hard-writes those three columns to NULL, and a re-PUT
    would additionally re-arm the label's whole crawl scope. So this mode detects and reports; it
    does not stamp. Correcting a drifted rule is a deliberate operator act.
    """
    rows = load_rescope_rules(api, args)
    if not rows:
        print("no rules to re-check")
        return 0

    def field(rule, snake, camel):
        return rule.get(snake, rule.get(camel))

    drift = []
    checked = ok = 0
    for rule in rows:
        mbid = field(rule, "artist_mbid", "artistMbid")
        name = field(rule, "artist_name", "artistName") or ""
        scope = rule.get("label_name") or rule.get("label_slug") or "GLOBAL"
        if not mbid:
            continue
        checked += 1
        if api.dry_run:
            print(f"  WOULD GET musicbrainz artist/{mbid} for {scope} | {name}")
            ok += 1
            continue
        status, payload = musicbrainz(f"artist/{urllib.parse.quote(mbid)}?fmt=json")
        if status == 404 or status == 410:
            drift.append(("GONE", scope, name, mbid, f"MusicBrainz {status}"))
            continue
        if status != 200 or not isinstance(payload, dict):
            drift.append(("UNREACHABLE", scope, name, mbid, f"{status} {str(payload)[:60]}"))
            continue
        returned = payload.get("id")
        if returned and returned != mbid:
            drift.append(("MERGED", scope, name, mbid, f"MusicBrainz now answers as {returned}"))
            continue
        if payload.get("name") and payload["name"] != name:
            drift.append(("RENAMED", scope, name, mbid, f"MusicBrainz calls it {payload['name']!r}"))
            continue
        ok += 1

    print(f"\nrescope: {checked} rule(s) checked — {ok} clean, {len(drift)} needing a look")
    for kind, scope, name, mbid, detail in drift:
        print(f"  {kind:11} {scope} | {name} ({mbid}) — {detail}")
    if drift:
        json.dump(
            [
                {"detail": d, "kind": k, "mbid": m, "name": n, "scope": s}
                for k, s, n, m, d in drift
            ],
            open(args.report_file, "w"),
            indent=2,
        )
        print(f"\nwrote {args.report_file}")
        print(
            "NOT auto-fixed by design. A drifted rule is re-authored by the operator "
            "(`fluncle admin labels artists <slug> --replace --rules-file …`, which also re-arms "
            "that label's crawl scope), and `checked_at`/`resolved_*` stay unstamped until an op "
            "can carry them."
        )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("mode", choices=["pilot", "apply", "rescope"], nargs="?", default="pilot")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the planned HTTP calls and make none; needs no credentials",
    )
    parser.add_argument("--triage-file", default="label-triage.json", help="the staged verdicts")
    parser.add_argument(
        "--live-file",
        default="live-labels.json",
        help="dry-run only: a fixture standing in for the server's undecided list",
    )
    parser.add_argument(
        "--rules-file",
        default="calib-rules.json",
        help="rescope: the existing-rule worklist (pull-undecided.sh writes it)",
    )
    parser.add_argument("--report-file", default="rescope-drift.json", help="rescope: the report")
    parser.add_argument(
        "--limit", type=int, default=500, help="rescope: max armed labels to read per seed state"
    )
    args = parser.parse_args()

    api = Api(args.dry_run)
    if args.mode == "rescope":
        return run_rescope(api, args)
    return run_apply(api, args)


if __name__ == "__main__":
    sys.exit(main())
