#!/usr/bin/env bash
# label-triage-sweep.sh — the `--no-agent` label-triage GATE cron's job ENTRY
# (`fluncle-label-triage`).
#
# LIVE. Version-controlled source; the repo is canonical and the box is a deploy target
# (fluncle-hermes-operator skill). This pair is BAKED into the image at /opt/hermes-scripts/ and
# auto-updates from main via pin-watch; a rave-02 HOST systemd timer docker-execs it — no docker cp.
# See ../cron/README.md and the fluncle-label-triage skill.
#
# A PURE TRIGGER, zero model tokens. It reads the undecided pile through the `fluncle` CLI, sorts it
# by the triage cursor, and reports whether enough NEVER-LOOKED labels have accumulated to be worth
# a research round. That deliberate cheapness is the point: an agent-bearing sweep can rot silently
# (a dead Claude token reading green for six days, a pinned binary rotting for thirteen), so the
# part that must be trustworthy spends nothing and the part allowed to be fragile is fired by it.
#
# It CANNOT rule. The gate only reads; recording a round's finding is `admin labels triage` (agent
# tier) and ruling on a label is `update_label` (operator tier), which 403s the box's agent token.
#
# PRODUCTION PRE-REQS (see ../cron/README.md):
#   - the `fluncle` CLI + its agent-scoped token — already on the box for every other sweep.
#   - NO model credentials: this half runs no `claude -p`.
set -euo pipefail

# A caller may exec this with a minimal PATH that omits /usr/local/bin (the bun + fluncle symlinks),
# so a bare `bun`/`fluncle` is "not found" → exit 127. Prepend the known install dirs.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: pin ABSOLUTE paths so the orchestrator's spawns resolve with zero PATH
# dependence.
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers write no per-run output file, so self-report the /status freshness marker the
# fluncle-healthcheck prober reads (see cron-output.sh) — WRAP the payload (never `exec`) so the
# marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output label-triage -- "${BUN_BIN}" "${SCRIPT_DIR}/label-triage-sweep.ts" "$@"
