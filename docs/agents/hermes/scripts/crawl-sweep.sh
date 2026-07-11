#!/usr/bin/env bash
# crawl-sweep.sh — the `--no-agent` catalogue-crawl cron's job ENTRY.
#
# Version-controlled source; the repo is canonical and the box is a deploy target
# (fluncle-hermes-operator skill). This pair is BAKED into the image at
# /opt/hermes-scripts/ and auto-updates from main via pin-watch; a rave-02 HOST systemd
# timer docker-execs it — no docker cp. See ../crawl-timer/README.md.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts` would
# be fed to Python. This thin wrapper is the bash entry; all the JSON work lives in the
# bun orchestrator beside it. Its stdout is the cron's run output.
#
# THE WORKER-PACED MODEL (the backfill-sweep shape): the box holds no MusicBrainz budget
# and no vendor identity; the Worker does. So the crawl's HTTP walk happens IN THE WORKER
# — this driver just paces ONE bounded pass per tick via the `fluncle` CLI, and the Worker
# carries the durable frontier, the ~1 req/s gate, the Retry-After backoff, and the
# circuit breaker. A crawl is a marathon the SCHEDULE finishes, not the process.
#
# It certifies nothing (a crawled row has no `findings` row, hence no Log ID, no note, no
# video, no public surface) and it captures no audio. Zero LLM tokens.
#
# Scheduled by a repo-checked-in HOST systemd timer (../crawl-timer/, installed by
# ../install-host-timers.sh), NOT a gateway `hermes cron create`. `crawl_catalogue` is
# AGENT tier, so the box's existing agent-scoped token drives it — no operator token, and
# NO NEW SECRET. Per-run output is a freshness marker the sweep self-writes via
# cron-output.sh under ~/.hermes/cron/output/fluncle-crawl/. See ../cron/README.md.
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
emit_cron_output crawl -- "${BUN_BIN}" "${SCRIPT_DIR}/crawl-sweep.ts" "$@"
