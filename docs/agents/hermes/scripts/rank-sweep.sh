#!/usr/bin/env bash
# rank-sweep.sh — the `--no-agent` catalogue-ranking cron's job ENTRY. THE EAR's schedule.
#
# Version-controlled source; the repo is canonical and the box is a deploy target
# (fluncle-hermes-operator skill). This pair is BAKED into the image at
# /opt/hermes-scripts/ and auto-updates from main via pin-watch; a rave-02 HOST systemd
# timer docker-execs it — no docker cp. See ../rank-timer/README.md.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts` would
# be fed to Python. This thin wrapper is the bash entry; all the JSON work lives in the
# bun orchestrator beside it. Its stdout is the cron's run output.
#
# WHY IT LANDS WITH THE CRAWLER. The Ear shipped `rank_catalogue` deliberately without a
# schedule: a timer ranking an empty table would be a /status row that means nothing, and
# the crawler is what creates rows. The crawler now exists (docs/catalogue-crawler.md), so
# the ranking has something to rank.
#
# It ranks stale CATALOGUE rows (a `tracks` row with no `findings` row) against the
# findings — all of the vector arithmetic runs in SQL inside the Worker; this driver just
# paces the drain. It certifies nothing and writes only derived columns, so the box's
# existing AGENT-scoped token drives it: NO new secret. Zero LLM tokens.
#
# Scheduled by a repo-checked-in HOST systemd timer (../rank-timer/, installed by
# ../install-host-timers.sh), NOT a gateway `hermes cron create`. Per-run output is a
# freshness marker the sweep self-writes via cron-output.sh under
# ~/.hermes/cron/output/fluncle-rank/ (read by the /status prober). See ../cron/README.md.
set -euo pipefail

# The cron runner execs this with a minimal PATH that omits /usr/local/bin (the bun +
# fluncle symlinks) and /root/.bun/bin, so a bare `bun`/`fluncle` is "not found" → exit
# 127. Prepend the known install dirs so this wrapper's `bun` AND the orchestrator's
# `fluncle`/`bun` spawns resolve regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: pin ABSOLUTE paths for the interpreter + the CLI (the orchestrator
# reads BUN_BIN/FLUNCLE_BIN, so its spawns resolve with zero PATH dependence).
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the
# /status freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) —
# WRAP the payload (never `exec`) so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output rank -- "${BUN_BIN}" "${SCRIPT_DIR}/rank-sweep.ts" "$@"
