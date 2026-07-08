#!/usr/bin/env bash
# social-capture-sweep.sh — the `--no-agent` social-URL-capture cron's job ENTRY.
#
# LIVE. Version-controlled source; the repo is canonical and the
# box is a deploy target (fluncle-hermes-operator skill). This script deploys to
# ~/.hermes/scripts/ on the devbox and the cron is wired there. See ../cron/README.md.
#
# Why a curl, NOT a `fluncle` CLI call: the capture sweep landed (#172) as the
# `fluncle admin tracks social --capture` verb, but the box's BAKED fluncle CLI
# predates that verb, so a `fluncle … --capture` is "unknown flag" on the box. This
# cron therefore POSTs the endpoint DIRECTLY. Switch to
# `fluncle admin tracks social --capture` when the baked CLI is next bumped past the
# version that carries the `--capture` verb (then this becomes a thin CLI wrapper
# like the other sweeps).
#
# THE WORKER-PACED MODEL: the box holds NO Postiz key; the Worker does. So the box
# just TRIGGERS — this one HTTP call paces one bounded capture pass per tick. The
# Worker queries Postiz's `/missing` per pending YouTube/TikTok post, builds each
# permalink from the platform's native content id, records the public `url`, links
# the analytics release-id, and flips a captured TikTok draft → published. The
# capture endpoint is AGENT tier (it only fills the public URL Postiz withheld on
# create — it publishes nothing), so the box's existing agent-scoped token drives
# it; no operator token.
#
# Operator wires it on the devbox (the image already carries curl; capture is AGENT
# tier, so the box's existing agent-scoped token drives it — no operator token):
#
#   hermes cron create "every 10m" --no-agent --script social-capture-sweep.sh --deliver local
#
# Confirm with `hermes cron list`; per-run output lands in
# ~/.hermes/cron/output/{job_id}/{timestamp}.md.
set -euo pipefail

# The Hermes cron `--no-agent --script` runner execs this with a minimal PATH that
# omits /usr/local/bin (the curl/bun symlinks) and /root/.bun/bin, so a bare command
# can be "not found" → exit 127 (the runner's env, not the image's; a manual
# `bash social-capture-sweep.sh` works because it inherits the container's full PATH).
# Prepend the known install dirs so `curl` resolves regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# The Worker origin (the agent-scoped token is a custom var that passes Hermes'
# provider-cred blocklist, so it rides the cron env like the other sweeps).
API_BASE_URL="${FLUNCLE_API_BASE_URL:-https://www.fluncle.com}"
CAPTURE_PATH="/api/admin/social/posts/capture"

# A JSON body is REQUIRED even when empty: the oRPC handler builds its input from the
# request body, and a bodyless POST deserializes to `undefined` → a 400
# `invalid_request`. Send `{}` with a JSON content-type. A short --max-time keeps a
# hung Worker from ever blowing the runner's ~120s kill; -fsS fails on a non-2xx so a
# bad tick exits nonzero (visible in the run output) instead of swallowing an error.
# Resolve this wrapper's dir so the shared marker helper is found next to it.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the
# /status freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) —
# WRAP the curl (never `exec`) so the marker is written even when the trigger fails.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output social-capture -- curl -fsS --max-time 30 \
  -X POST "${API_BASE_URL}${CAPTURE_PATH}" \
  -H "Authorization: Bearer ${FLUNCLE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}'
