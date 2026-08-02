#!/usr/bin/env bash
# pull-undecided.sh — the label-triage pass's data pull (fluncle-label-triage skill, step 1).
#
# Emits (to stdout) a JSON array of every `undecided` label with its mb_label_id + stored-track
# count + any artist rules it already carries, and refreshes calib-enabled.txt / calib-disabled.txt
# / calib-rules.txt / calib-rules.json (in CWD) from the LIVE rulings. The DB read is REQUIRED for
# the stored-track counts and the whole-corpus calibration lists (the admin labels API pages), and
# it is what lets a research agent hit the EXACT MusicBrainz entity instead of a same-named label.
#
#   pull-undecided.sh [--exclude held-slugs.txt] > undecided.json
#
# --exclude: one slug per line — labels the operator is holding for their own ear (prior rounds'
# `unclear`). Optional; re-triaging a held label is harmless (it comes back unclear again).
#
# THE ARTIST-RULE OUTPUTS (the exception model, docs/label-entity.md):
#   - each undecided row carries `rules: [...]` — an undecided/disabled label can already hold
#     ALLOW rules (the dnb_partial shape), and a re-triage must see them before proposing more.
#   - calib-rules.txt — the operator's RATIFIED rule precedent, one line per rule, for the
#     research brief (agents calibrate proposals against rules he has already accepted).
#   - calib-rules.json — the same set machine-readable: the input to `apply-rulings.py rescope`.
#
# SECRETS: prod Turso creds resolve through `op` via the FLUNCLE_TURSO_OP_ITEM indirection var
# (the open-source posture — no concrete op:// path in this public script). Read-only by
# construction: this script only ever SELECTs.
set -euo pipefail

EXCLUDE=""
if [ "${1:-}" = "--exclude" ]; then
  EXCLUDE="${2:?--exclude needs a file}"
fi

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
# scoped to. This is the ratified precedent AND the rescope round's worklist.
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
    lines.append(f\"{r['verdict']:5} | {scope} | {r['artist_name']} ({r['artist_mbid']}) | {bridge} | source={r['source']}\")
open('calib-rules.txt', 'w').write('\n'.join(lines) + ('\n' if lines else ''))
json.dump(rules, open('calib-rules.json', 'w'), indent=0)
g = sum(1 for r in rules if not r['label_id'])
print(f'rules: {len(rules)} total ({g} global / {len(rules)-g} per-label)', file=sys.stderr)
"

printf '%s' "$UNDECIDED" | python3 -c "
import json, sys
rows = json.load(sys.stdin)
rules = json.load(open('calib-rules.json'))
by_label = {}
for r in rules:
    if r['label_id']:
        by_label.setdefault(r['label_id'], []).append(
            {'artistMbid': r['artist_mbid'], 'artistName': r['artist_name'], 'verdict': r['verdict']})
exclude = set()
path = '''$EXCLUDE'''
if path:
    exclude = {l.strip() for l in open(path) if l.strip()}
fresh = []
for r in rows:
    if r['slug'] in exclude:
        continue
    r['rules'] = by_label.get(r['id'], [])
    fresh.append(r)
ruled = sum(1 for r in fresh if r['rules'])
print(f'undecided: {len(rows)} | excluded (held): {len(rows)-len(fresh)} | to triage: {len(fresh)} | already rule-carrying: {ruled}', file=sys.stderr)
json.dump(fresh, sys.stdout, indent=0)
"
