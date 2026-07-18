#!/usr/bin/env bash
# demand-sweep.sh — the `--no-agent` demand cron's job ENTRY (`fluncle-demand`). The nightly
# demand-driven reorder of crawl/capture priority (docs/catalogue-crawler.md § Demand).
#
# Version-controlled source; the repo is canonical and the box is a deploy target
# (fluncle-hermes-operator skill). This pair is BAKED into the image at /opt/hermes-scripts/ and
# auto-updates from main via pin-watch; a rave-02 HOST systemd timer docker-execs it once a day —
# no docker cp. See ../demand-timer/README.md. Box activation is OPERATOR-GATED (a new cron;
# nothing to retire).
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by extension —
# bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts` would be fed to Python.
# This thin wrapper is the bash entry; all the JSON work lives in the bun orchestrator beside it
# (demand-sweep.ts). Its stdout is the cron's run output.
#
# THE WORKER-PACED MODEL (the reach-collect / catalogue-rank shape): the box holds NO Simple
# Analytics key; the WORKER holds it and does the fetch. So this driver just fires
# `fluncle admin catalogue demand` ONCE — the Worker reads the `/artist/<slug>` + `/label/<slug>`
# pageviews and rewrites the two derived reorder columns (`tracks.demand_score` +
# `crawl_frontier.demand_rank`), a rank-order-only, idempotent, within-tier reorder. A same-window
# re-run lands the same columns. `record_demand` is AGENT tier, so the box's existing agent-scoped
# token drives it — NO new secret. Zero LLM tokens.
#
# Scheduled by a repo-checked-in HOST systemd timer (../demand-timer/, installed by
# ../install-host-timers.sh), NOT a gateway `hermes cron create`. Per-run output is a freshness
# marker the sweep self-writes via cron-output.sh under ~/.hermes/cron/output/fluncle-demand/
# (read by the /status prober). See ../cron/README.md.
set -euo pipefail

# The cron runner execs this with a minimal PATH that omits /usr/local/bin (the bun + fluncle
# symlinks) and /root/.bun/bin, so a bare `bun`/`fluncle` is "not found" → exit 127. Prepend the
# known install dirs so this wrapper's `bun` AND the orchestrator's `fluncle` spawn resolve
# regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: pin ABSOLUTE paths for the interpreter + the CLI (the orchestrator reads
# BUN_BIN/FLUNCLE_BIN, so its spawn resolves with zero PATH dependence).
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the /status
# freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) — WRAP the payload
# (never `exec`) so the marker is written even on a nonzero run. The bare token `demand` becomes
# the fluncle-demand output dir + the `# Cron Job: fluncle-demand` header the prober matches on.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output demand -- "${BUN_BIN}" "${SCRIPT_DIR}/demand-sweep.ts" "$@"
