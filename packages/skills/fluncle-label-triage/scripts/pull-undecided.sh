#!/usr/bin/env bash

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

UNDECIDED="$(query "select l.id, l.name, l.slug, l.mb_label_id, count(t.track_id) as track_rows
from labels l left join tracks t on t.label_id = l.id
where l.seed_state = 'undecided'
group by l.id order by l.name")"

RULES="$(query "select r.id, r.artist_mbid, r.artist_name, r.artist_spotify_id, r.verdict,
  r.source, r.resolved_mbid, r.resolved_name, r.checked_at, r.label_id,
  l.name as label_name, l.slug as label_slug, l.seed_state as label_seed_state
from artist_rules r left join labels l on l.id = r.label_id
order by coalesce(l.name, '') collate nocase, r.artist_name collate nocase")"

query "select seed_state, name from labels where seed_state in ('enabled','disabled') order by seed_state, name" |
	python3 -c "
import json, sys
d = json.load(sys.stdin)
en = [r['name'] for r in d if r['seed_state'] == 'enabled']
di = [r['name'] for r in d if r['seed_state'] == 'disabled']
open('calib-enabled.txt', 'w').write('\n'.join(en))
open('calib-disabled.txt', 'w').write('\n'.join(di))
print(f'calibration: {len(en)} enabled / {len(di)} disabled', file=sys.stderr)
"

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
