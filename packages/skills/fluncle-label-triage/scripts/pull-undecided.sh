#!/usr/bin/env bash
# pull-undecided.sh — the label-triage pass's data pull (fluncle-label-triage skill, step 1).
#
# Emits (to stdout) a JSON array of every `undecided` label with its mb_label_id + stored-track
# count + any artist rules it already carries, and refreshes calib-enabled.txt / calib-disabled.txt
# / calib-rules.txt / calib-rules.json (in CWD) from the LIVE rulings. The DB read is REQUIRED for
# the stored-track counts and the whole-corpus calibration lists (the admin labels API pages), and
# it is what lets a research agent hit the EXACT MusicBrainz entity instead of a same-named label.
#
#   pull-undecided.sh > undecided.json
#
# THE TWO EXCLUSIONS, AND WHY THERE ARE ONLY TWO:
#
#   1. RULE-CARRYING — an `undecided` label that CARRIES ARTIST RULES is a settled `dnb_partial`:
#      the operator ruled it by writing allows and leaving the seed state alone, which is that
#      verdict's whole shape. Re-triaging one spends tokens to re-derive a ruling that already
#      exists, and applying the result would re-PUT a WHOLE-SET SWAP over rules he may have since
#      hand-tuned. The check is exact, not a heuristic — an undecided label has no other way to
#      acquire per-label rules.
#   2. NO `mb_label_id` — a research agent cannot identify which same-named MusicBrainz entity a
#      row without an MBID means, and label names are not unique (Radar Records is a Belgian DnB
#      label AND a 1978 UK punk one), so handing it to a batch invites a confident ruling on the
#      wrong label — the namesake class, and the one failure mode a round cannot detect afterwards.
#      An ENABLED label without one self-resolves on its first crawl tick (`expandSeedLabel`'s
#      exact-fold search with its ambiguity guard); an UNDECIDED one never gets that tick, because
#      nothing crawls it until the operator rules, so it is HIS to resolve by hand. Named on stderr
#      for exactly that: one `mb_label_id` write and the next round picks the label up untouched.
#
# Both exclusions are applied by `partition-undecided.py` beside this script rather than inline,
# so they are unit-tested with no database and no credentials (scripts/tests/test_partition_undecided.py).
#
# Everything else undecided is triaged EVERY round, including labels a prior round returned
# `unclear`. There is deliberately NO hold list. A hold is a snapshot of a judgment, and a
# hand-maintained one drifts silently until it skips labels that were settled and misses labels that
# were not (it did exactly that, twice). Re-triage is cheap and self-correcting: a still-unclear
# label costs one slice of a research batch and comes back unclear, while a label held pending an
# upstream MusicBrainz split, or pending a global rule that changes its share test, RESOLVES ITSELF
# the first round after the fix lands instead of waiting for someone to remember it.
#
# THE ARTIST-RULE OUTPUTS (the exception model, docs/label-entity.md):
#   - each emitted row carries `rules: [...]`, empty by construction while exclusion 1 above
#     holds — it is what that exclusion is decided ON, and it stays on the row so a deliberate
#     re-triage of a partial has the standing exceptions in hand before proposing more.
#   - calib-rules.txt — the operator's RATIFIED rule precedent, one line per rule, for the
#     research brief (agents calibrate proposals against rules he has already accepted).
#   - calib-rules.json — the same set machine-readable: the input to `apply-rulings.py rescope`.
#
# SECRETS: prod Turso creds resolve through `op` via the FLUNCLE_TURSO_OP_ITEM indirection var
# (the open-source posture — no concrete op:// path in this public script). Read-only by
# construction: this script only ever SELECTs.
set -euo pipefail

: "${FLUNCLE_TURSO_OP_ITEM:?set FLUNCLE_TURSO_OP_ITEM (see the private ops runbook)}"
URL="$(op read "${FLUNCLE_TURSO_OP_ITEM}/TURSO_DATABASE_URL")"
TOK="$(op read "${FLUNCLE_TURSO_OP_ITEM}/TURSO_AUTH_TOKEN")"
HTTP="https://${URL#libsql://}"

query() {
  python3 - "$HTTP" "$TOK" "$1" <<'PY'
import json, sys, urllib.request
http, tok, sql = sys.argv[1], sys.argv[2], sys.argv[3]
body = {"requests": [{"type": "execute", "stmt": {"sql": sql}}, {"type": "close"}]}
req = urllib.request.Request(http.rstrip('/') + "/v2/pipeline", data=json.dumps(body).encode(),
    method="POST", headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
r0 = json.load(urllib.request.urlopen(req, timeout=90))["results"][0]
if r0.get("type") != "ok":
    print("QUERY ERROR:", json.dumps(r0)[:300], file=sys.stderr); raise SystemExit(1)
rs = r0["response"]["result"]
cols = [c["name"] for c in rs["cols"]]
rows = [{c: (None if v.get("type") == "null" else v.get("value")) for c, v in zip(cols, row)}
        for row in rs["rows"]]
print(json.dumps(rows))
PY
}

# The pile, with the load-bearing MBID + how many rows already point at each label.
UNDECIDED="$(query "select l.id, l.name, l.slug, l.mb_label_id, count(t.track_id) as track_rows
from labels l left join tracks t on t.label_id = l.id
where l.seed_state = 'undecided'
group by l.id order by l.name")"

# Every artist rule Fluncle holds — global (label_id is null) and per-label — with the label it is
# scoped to. This is the ratified precedent AND the rescope round's worklist. It carries all three
# verdicts: a global `unlisted` is a VISIBILITY ruling (no public artist page), not acquisition
# scope, so it rides along for the rescope's MusicBrainz drift check and is never proposed for a
# label — `apply-rulings.py` refuses a label-scoped one outright.
RULES="$(query "select r.id, r.artist_mbid, r.artist_name, r.artist_spotify_id, r.verdict,
  r.source, r.resolved_mbid, r.resolved_name, r.checked_at, r.label_id,
  l.name as label_name, l.slug as label_slug, l.seed_state as label_seed_state
from artist_rules r left join labels l on l.id = r.label_id
order by coalesce(l.name, '') collate nocase, r.artist_name collate nocase")"

# The calibration — the operator's LIVE boundary, refreshed every pass (it moves every round).
query "select seed_state, name from labels where seed_state in ('enabled','disabled') order by seed_state, name" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
en = [r['name'] for r in d if r['seed_state'] == 'enabled']
di = [r['name'] for r in d if r['seed_state'] == 'disabled']
open('calib-enabled.txt', 'w').write('\n'.join(en))
open('calib-disabled.txt', 'w').write('\n'.join(di))
print(f'calibration: {len(en)} enabled / {len(di)} disabled', file=sys.stderr)
"

# calib-rules.txt (the brief's precedent) + calib-rules.json (the rescope worklist).
printf '%s' "$RULES" | python3 -c "
import json, sys
rules = json.load(sys.stdin)
lines = []
for r in rules:
    scope = f\"{r['label_name']} [{r['label_seed_state']}]\" if r['label_id'] else 'GLOBAL'
    bridge = 'tap-bridged' if r['artist_spotify_id'] else 'TAP-BLIND'
    lines.append(f\"{r['verdict']:8} | {scope} | {r['artist_name']} ({r['artist_mbid']}) | {bridge} | source={r['source']}\")
open('calib-rules.txt', 'w').write('\n'.join(lines) + ('\n' if lines else ''))
json.dump(rules, open('calib-rules.json', 'w'), indent=0)
g = sum(1 for r in rules if not r['label_id'])
print(f'rules: {len(rules)} total ({g} global / {len(rules)-g} per-label)', file=sys.stderr)
"

printf '%s' "$UNDECIDED" | python3 "$(dirname "${BASH_SOURCE[0]}")/partition-undecided.py"
