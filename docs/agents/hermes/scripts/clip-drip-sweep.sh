#!/usr/bin/env bash
# clip-drip-sweep.sh — the `--no-agent` clip drip-feed cron's job ENTRY.
#
# LIVE. Version-controlled source; the repo is canonical and the box is a deploy
# target (fluncle-hermes-operator skill). This script deploys to ~/.hermes/scripts/ on
# the devbox and the cron is wired there. See ../cron/README.md.
#
# WHAT IT DOES: one bounded, idempotent tick of the Instagram clip drip-feed. Every clip
# auto-enters a schedule (clip-drip-feed RFC §3); this cron fires the due, cut ones to
# Instagram via Postiz at their slot time. The Worker owns the logic: it checks the kill
# switch first (a paused tick posts nothing), then posts the due clips bounded by a
# per-tick cap AND the rolling-24h IG cap.
#
# WHY A CURL, NOT A `fluncle` CLI call: mirrors social-capture-sweep.sh. The box's BAKED
# fluncle CLI predates the clip-drip verbs, so this cron POSTs the endpoint DIRECTLY.
# Switch to a thin CLI wrapper when the baked CLI is next bumped past the version that
# carries the drip ops.
#
# THE WORKER-PACED MODEL: the box holds NO Postiz key; the Worker does. So the box just
# TRIGGERS — this one HTTP call paces one bounded drip pass per tick. The drip endpoint is
# ADMIN tier (the `finalize_clip_cut` / `record_health` precedent — it needs the Worker's
# Postiz key, which the box never sees; the box only triggers), so the box's existing
# agent-scoped token drives it; no operator token.
#
# THE KILL SWITCH: the operator pauses/resumes the whole drip from the admin UI or the
# CLI (`fluncle admin clips drip-pause` / `drip-resume`). This cron does NOT gate on it —
# the Worker checks the kill switch first and no-ops the tick when paused. So leaving the
# cron running is safe; pausing halts every post within one tick, schedule intact.
#
# Operator wires it on the devbox (the image already carries curl; the drip is AGENT tier,
# so the box's existing agent-scoped token drives it — no operator token). Post-first-batch:
# watch the first automated posts survive on Instagram before trusting the cadence
# (clip-drip-feed RFC §6); the kill switch is the response if a clip gets struck.
#
#   hermes cron create "every 20m" --no-agent --script clip-drip-sweep.sh --deliver local
#
# Confirm with `hermes cron list`; per-run output lands in
# ~/.hermes/cron/output/{job_id}/{timestamp}.md.
set -euo pipefail

# The Hermes cron `--no-agent --script` runner execs this with a minimal PATH that omits
# /usr/local/bin (the curl/bun symlinks) and /root/.bun/bin, so a bare command can be "not
# found" → exit 127. Prepend the known install dirs so `curl` resolves regardless.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# The Worker origin (the agent-scoped token is a custom var that passes Hermes'
# provider-cred blocklist, so it rides the cron env like the other sweeps).
API_BASE_URL="${FLUNCLE_API_BASE_URL:-https://www.fluncle.com}"
DRIP_PATH="/api/admin/clips/drip"

# A JSON body is REQUIRED even when empty: the oRPC handler builds its input from the
# request body, and a bodyless POST deserializes to `undefined` → a 400 `invalid_request`.
# Send `{}` with a JSON content-type. A short --max-time keeps a hung Worker from ever
# blowing the runner's ~120s kill; -fsS fails on a non-2xx so a bad tick exits nonzero
# (visible in the run output) instead of swallowing an error.
curl -fsS --max-time 30 \
  -X POST "${API_BASE_URL}${DRIP_PATH}" \
  -H "Authorization: Bearer ${FLUNCLE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}'
