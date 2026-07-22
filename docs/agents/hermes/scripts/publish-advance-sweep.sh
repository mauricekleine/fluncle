#!/usr/bin/env bash
# publish-advance-sweep.sh — the `--no-agent` render → publish AUTO-ADVANCE cron's job ENTRY.
#
# LIVE (baked), but the advance itself ships DARK: the Worker's kill switch defaults to
# PAUSED, so this tick is a no-op until an operator deliberately resumes it
# (`fluncle admin publish resume`, or the toggle on /admin/findings). Version-controlled
# source; the repo is canonical and the box is a deploy target (fluncle-hermes-operator
# skill). BAKED into the image at /opt/hermes-scripts/, auto-updated from main via
# pin-watch, docker-exec'd by a rave-02 HOST systemd timer — no docker cp. See
# ../cron/README.md.
#
# WHAT IT DOES: one bounded, idempotent tick of the last autonomy gap. The render conductor
# finishes a finding's video; this closes the chain to publish without an operator beat
# between the two — a freshly-rendered, READY finding goes out as a hands-off PUBLIC
# YouTube Short and a TikTok inbox draft (the operator still finishes TikTok in-app: the
# licensed sound attaches only there, a platform limit, not ours).
#
# THIS AUTOMATES A PUBLIC PUBLISH, so every gate lives Worker-side where it can be tested
# (apps/web/src/lib/server/publish-advance.ts): the kill switch is read FIRST; a finding is
# only ready when the render finalized BOTH masters, settled, and its whole bundle is served
# on R2; the (track, platform) row is CLAIMED atomically before any call to Postiz, so two
# overlapping ticks can never double-upload; and a failed push is left `failed` for the
# operator — never auto-retried.
#
# WHY A CURL, NOT A `fluncle` CLI call: mirrors social-capture-sweep.sh / clip-drip-sweep.sh.
# The box's BAKED fluncle CLI predates the `admin publish advance` verb, so this cron POSTs
# the endpoint DIRECTLY. Switch to `fluncle admin publish advance` when the baked CLI is
# next bumped past the version that carries it.
#
# THE WORKER-PACED MODEL: the box holds NO Postiz key; the Worker does. So the box just
# TRIGGERS — this one HTTP call paces one bounded advance per tick. The endpoint is ADMIN
# tier (the `drip_clips` / `capture_post_urls` precedent), so the box's existing
# agent-scoped token drives it; no operator token. The KILL SWITCH is operator tier — the
# box can tick the advance but can never turn it on.
#
# Scheduled by a repo-checked-in HOST systemd timer (../publish-advance-timer/, installed by
# ../install-host-timers.sh). Per-run output is a freshness marker the sweep self-writes via
# cron-output.sh under ~/.hermes/cron/output/fluncle-publish-advance/ (read by the /status
# prober). See ../cron/README.md.
set -euo pipefail

# The `--no-agent --script` runner execs this with a minimal PATH that omits /usr/local/bin
# (the curl/bun symlinks) and /root/.bun/bin, so a bare command can be "not found" → exit
# 127. Prepend the known install dirs so `curl` resolves regardless.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# The Worker origin (the agent-scoped token is a custom var that passes Hermes'
# provider-cred blocklist, so it rides the cron env like the other sweeps).
API_BASE_URL="${FLUNCLE_API_BASE_URL:-https://www.fluncle.com}"
ADVANCE_PATH="/api/v1/admin/social/publish/advance"

# Resolve this wrapper's dir so the shared marker helper is found next to it.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# A JSON body is REQUIRED even when empty: the oRPC handler builds its input from the
# request body, and a bodyless POST deserializes to `undefined` → a 400 `invalid_request`.
# Send `{}` with a JSON content-type. A short --max-time keeps a hung Worker from ever
# blowing the runner's ~120s kill; -fsS fails on a non-2xx so a bad tick exits nonzero
# (visible in the run output) instead of swallowing an error.
#
# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the /status
# freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) — WRAP the curl
# (never `exec`) so the marker is written even when the trigger fails.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output publish-advance -- curl -fsS --max-time 30 \
  -X POST "${API_BASE_URL}${ADVANCE_PATH}" \
  -H "Authorization: Bearer ${FLUNCLE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}'
