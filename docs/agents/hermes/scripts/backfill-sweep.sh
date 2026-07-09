#!/usr/bin/env bash
# backfill-sweep.sh — the `--no-agent` catalogue-backfill cron's job ENTRY.
#
# LIVE. Version-controlled source; the repo is canonical and the
# box is a deploy target (fluncle-hermes-operator skill). This pair is BAKED into the image
# at /opt/hermes-scripts/ and auto-updates from main via pin-watch; a rave-02 HOST systemd
# timer docker-execs it — no docker cp. See ../cron/README.md.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts`
# would be fed to Python. This thin wrapper is the bash entry; all the JSON work
# lives in the bun orchestrator beside it. Its stdout is the cron's run output.
#
# THE WORKER-PACED MODEL: the box holds NO Discogs/Last.fm vendor keys; the Worker
# does. So the backfill API calls happen in the Worker — this driver just paces one
# small bounded batch of each source per tick via the `fluncle` CLI, and the Worker
# carries the per-finding reliability state + Retry-After backoff.
#
# Scheduled by a repo-checked-in HOST systemd timer (../backfill-timer/, installed by
# ../install-host-timers.sh), NOT a gateway `hermes cron create`. The backfills are AGENT
# tier, so the box's existing agent-scoped token drives them — no operator token needed.
# Per-run output is a freshness marker the sweep self-writes via cron-output.sh under
# ~/.hermes/cron/output/fluncle-backfill/ (read by the /status prober). See ../cron/README.md.
set -euo pipefail

# The Hermes cron `--no-agent --script` runner execs this with a minimal PATH that
# omits /usr/local/bin (the bun + fluncle symlinks) and /root/.bun/bin, so a bare
# `bun`/`fluncle` is "not found" → exit 127 (the runner's env, not the image's; a
# manual `bash backfill-sweep.sh` works because it inherits the container's full PATH).
# Prepend the known install dirs so this wrapper's `bun` AND the orchestrator's
# `fluncle`/`bun` spawns resolve regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: the cron runner's exec context loses the PATH export above,
# so pin ABSOLUTE paths for the interpreter + the CLI. The orchestrator reads
# BUN_BIN/FLUNCLE_BIN, so its `bun`/`fluncle` spawns resolve with zero PATH
# dependence; the wrapper itself execs bun by absolute path too.
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the
# /status freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) —
# WRAP the payload (never `exec`) so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output backfill -- "${BUN_BIN}" "${SCRIPT_DIR}/backfill-sweep.ts" "$@"
