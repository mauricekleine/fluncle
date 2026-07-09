#!/usr/bin/env bash
# artist-sweep.sh — the `--no-agent` artist-resolution cron's job ENTRY.
#
# LIVE. Version-controlled source; the repo is canonical and the box is a
# deploy target (fluncle-hermes-operator skill). This pair is BAKED into the image at
# /opt/hermes-scripts/ and auto-updates from main via pin-watch; a rave-02 HOST systemd
# timer docker-execs it — no docker cp.
#
# THE WORKER-PACED MODEL: the box holds NO FIRECRAWL_API_KEY and no YouTube
# OAuth (the Worker does). So this driver just PACES the resolution endpoint —
# one small bounded batch per tick via the `fluncle` CLI — and the Worker runs
# the MB url-rel walk, the Firecrawl /v2/extract gap-fill, and the YouTube
# channel-ID resolution. Pure trigger, zero LLM tokens on the box.
#
# Scheduled by a repo-checked-in HOST systemd timer (../artist-sweep-timer/, installed by
# ../install-host-timers.sh), NOT a gateway `hermes cron create`. `resolve_artist` is AGENT
# tier, so the box's existing agent-scoped token drives it — no operator token needed.
# Per-run output is a freshness marker the sweep self-writes via cron-output.sh under
# ~/.hermes/cron/output/fluncle-artist-sweep/ (read by the /status prober). See ../cron/README.md.
set -euo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the
# /status freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) —
# WRAP the payload (never `exec`) so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output artist-sweep -- "${BUN_BIN}" "${SCRIPT_DIR}/artist-sweep.ts" "$@"
