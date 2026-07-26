#!/usr/bin/env bash
# reconcile-hub-counts.sh — the hub-counts reconciliation cron's job ENTRY
# (`fluncle-reconcile-hub-counts`).
#
# SCHEDULED BY A HOST SYSTEMD TIMER (../reconcile-hub-counts-timer/), not a Hermes gateway cron.
# The rave-02 host timer docker-execs this script inside the container once a night; a manual
# `bash /opt/hermes-scripts/reconcile-hub-counts.sh` runs it the same way. This thin bash wrapper
# is the entry; all the work lives in the bun orchestrator beside it (reconcile-hub-counts.ts).
#
# LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy target
# (fluncle-hermes-operator skill). The pair is BAKED into the image at /opt/hermes-scripts/ and
# auto-updates from main via pin-watch — no docker cp. See ../reconcile-hub-counts-timer/README.md.
#
# WHAT IT DOES (docs/db-scale-backlog Wave 2 keystone 2, slice C): POST
# /api/v1/admin/hub-counts/reconcile with the box's agent token — a bare trigger. The WORKER
# recomputes truth for `renderable_track_count` / `certified_finding_count` on labels/albums/artists
# and rewrites ONLY the rows that disagreed, acking the corrected count per table. It is the
# self-healing backstop under the delta-maintained counters, and its corrected-row numbers are the
# operator's DRIFT AUDIT — the sweep logs them and journalctl holds the history:
#
#   journalctl -u fluncle-reconcile-hub-counts.service | grep AUDIT
#
# Zero LLM tokens.
#
# PRODUCTION PRE-REQS (see ../reconcile-hub-counts-timer/README.md):
#   - Secrets in the shared 0600 ${HOME}/.fluncle-secrets.env (op-injected), sourced below:
#       FLUNCLE_API_TOKEN — the box's AGENT-scoped token (`reconcile_hub_counts` is agent tier).
#   - NO new secret: every statement runs Worker-side, so the box is a bare trigger (the
#     funnel-snapshot shape).
set -euo pipefail

# The docker-exec / runner context hands this a minimal PATH that omits /usr/local/bin (the bun
# symlink) and /root/.bun/bin — prepend the known install dirs so `bun` resolves regardless.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: pin an ABSOLUTE interpreter path (the exec context can lose the export).
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

# Source the shared 0600 secrets file (the same single source every other sweep reads) so the
# agent token is present.
RECONCILE_ENV_FILE="${RECONCILE_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${RECONCILE_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${RECONCILE_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the /status
# freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) — WRAP the payload
# (never `exec`) so the marker is written even on a nonzero run. The token is
# `reconcile-hub-counts` (the fluncle-reconcile-hub-counts dir + the
# `# Cron Job: fluncle-reconcile-hub-counts` header the prober matches).
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output reconcile-hub-counts -- "${BUN_BIN}" "${SCRIPT_DIR}/reconcile-hub-counts.ts" "$@"
