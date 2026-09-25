#!/usr/bin/env bash
# social-capture-sweep.sh — the `--no-agent` social-URL-capture cron's job ENTRY.
#
# LIVE. Version-controlled source; the repo is canonical and the
# box is a deploy target (fluncle-hermes-operator skill). This script is BAKED into the image
# at /opt/hermes-scripts/ and auto-updates from main via pin-watch; a rave-02 HOST systemd
# timer docker-execs it — no docker cp. See ../cron/README.md.
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
# Scheduled by a repo-checked-in HOST systemd timer (../social-capture-timer/, installed by
# ../install-host-timers.sh), which `docker exec`s it in the container. Capture is AGENT tier, so
# the box's existing agent-scoped token drives it — no operator token. Per-run output is a
# freshness marker the sweep self-writes via cron-output.sh under
# ~/.hermes/cron/output/fluncle-social-capture/ (read by the /status prober). See ../cron/README.md.
set -euo pipefail

# A caller may exec this with a minimal PATH that
# omits /usr/local/bin (the curl/bun symlinks) and /root/.bun/bin, so a bare command
# can be "not found" → exit 127 (a `docker exec`
# inherits the image's full PATH, so the prepend is a guard).
# Prepend the known install dirs so `curl` resolves regardless of the caller's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

# The Worker origin (the agent-scoped token rides the container env like the other
# sweeps).
API_BASE_URL="${FLUNCLE_API_BASE_URL:-https://www.fluncle.com}"
CAPTURE_PATH="/api/v1/admin/social/posts/capture"

# A JSON body is REQUIRED even when empty: the oRPC handler builds its input from the
# request body, and a bodyless POST deserializes to `undefined` → a 400
# `invalid_request`. Send `{}` with a JSON content-type. A short --max-time keeps a
# hung Worker from ever stalling the tick; -fsS fails on a non-2xx so a
# bad tick exits nonzero (visible in the run output) instead of swallowing an error.
# Resolve this wrapper's dir so the shared marker helper is found next to it.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers write no per-run output file, so self-report the
# /status freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) —
# WRAP the curl (never `exec`) so the marker is written even when the trigger fails.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"

run_social_capture() {
  local raw rc=0
  raw="$(curl -fsS --max-time 30 \
    -X POST "${API_BASE_URL}${CAPTURE_PATH}" \
    -H "Authorization: Bearer ${FLUNCLE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{}')" || rc="$?"

  if [ "$rc" -ne 0 ]; then
    printf '%s\n' '{"checked":null,"errors":1,"failed":null,"ok":false,"produced":null,"reason":"request_failed"}'
    return "$rc"
  fi

  printf '%s' "$raw" | "${BUN_BIN}" "${SCRIPT_DIR}/worker-trigger-counters.ts" social-capture
}

emit_cron_output social-capture -- run_social_capture
