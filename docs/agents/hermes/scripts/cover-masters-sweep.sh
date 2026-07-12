#!/usr/bin/env bash
# cover-masters-sweep.sh — the `--no-agent` owned-cover-master resolve cron's job ENTRY (RFC U3b).
#
# Version-controlled source; the repo is canonical and the box is a deploy target
# (fluncle-hermes-operator skill). This pair is BAKED into the image at /opt/hermes-scripts/ and
# auto-updates from main via pin-watch; a rave-02 HOST systemd timer docker-execs it — no docker
# cp. See ../cover-masters-timer/README.md.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by extension —
# bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts` would be fed to Python.
# This thin wrapper is the bash entry; all the JSON work lives in the bun orchestrator beside it.
# Its stdout is the cron's run output.
#
# THE WORKER-PACED MODEL (the label-images-sweep shape): the Worker fetches each album's/artist's
# best cover source and stores the ≤1200 master in R2; this driver just paces ONE bounded batch of
# EACH kind per tick via the `fluncle` CLI, and the Worker carries the durable per-entity
# reliability state + the ≤1200 cap. The publish path + catalogue crawl mint new `pending`
# albums/artists; this sweep is what gives each its OWN cover master instead of a hotlink.
#
# It resolves only a cover's IMAGE — it certifies nothing and publishes nothing. Zero LLM tokens.
#
# Scheduled by a repo-checked-in HOST systemd timer (../cover-masters-timer/, installed by
# ../install-host-timers.sh), NOT a gateway `hermes cron create`. `backfill_cover_masters` is AGENT
# tier, so the box's existing agent-scoped token drives it — no operator token, and NO NEW SECRET.
# Per-run output is a freshness marker the sweep self-writes via cron-output.sh under
# ~/.hermes/cron/output/fluncle-cover-masters/ (read by the /status prober). See ../cron/README.md.
set -euo pipefail

# The cron runner execs this with a minimal PATH that omits /usr/local/bin (the bun + fluncle
# symlinks) and /root/.bun/bin, so a bare `bun`/`fluncle` is "not found" → exit 127. Prepend the
# known install dirs so this wrapper's `bun` AND the orchestrator's `fluncle`/`bun` spawns resolve
# regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: pin ABSOLUTE paths for the interpreter + the CLI (the orchestrator reads
# BUN_BIN/FLUNCLE_BIN, so its spawns resolve with zero PATH dependence).
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the /status
# freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) — WRAP the payload
# (never `exec`) so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output cover-masters -- "${BUN_BIN}" "${SCRIPT_DIR}/cover-masters-sweep.ts" "$@"
