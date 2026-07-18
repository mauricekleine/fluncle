#!/usr/bin/env bash
# funnel-snapshot-sweep.sh — the catalogue-funnel snapshot cron's job ENTRY (`fluncle-funnel-snapshot`).
#
# SCHEDULED BY A HOST SYSTEMD TIMER (../funnel-snapshot-timer/), not a Hermes gateway cron. The
# rave-02 host timer docker-execs this script inside the container once a day; a manual
# `bash /opt/hermes-scripts/funnel-snapshot-sweep.sh` runs it the same way. This thin bash wrapper is
# the entry; all the work lives in the bun orchestrator beside it (funnel-snapshot-sweep.ts).
#
# LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy target
# (fluncle-hermes-operator skill). The pair is BAKED into the image at /opt/hermes-scripts/ and
# auto-updates from main via pin-watch — no docker cp. See ../funnel-snapshot-timer/README.md.
#
# WHAT IT DOES (docs/rfcs/catalogue-funnel-rfc.md): POST /api/admin/funnel/snapshot with the box's
# agent token — a bare trigger. The WORKER computes every stage total + queue depth + frontier count
# and UPSERTS one idempotent row per UTC day (a re-fired tick overwrites, never doubles a bar). It is
# the daily-snapshot history behind /admin/funnel. Zero LLM tokens.
#
# PRODUCTION PRE-REQS (see ../funnel-snapshot-timer/README.md):
#   - Secrets in the shared 0600 ${HOME}/.fluncle-secrets.env (op-injected), sourced below:
#       FLUNCLE_API_TOKEN — the box's AGENT-scoped token (`record_catalogue_snapshot` is agent tier).
#   - NO new secret: every count is computed Worker-side, so the box is a bare trigger (the reach-cron shape).
set -euo pipefail

# The docker-exec / runner context hands this a minimal PATH that omits /usr/local/bin (the bun
# symlink) and /root/.bun/bin — prepend the known install dirs so `bun` resolves regardless.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: pin an ABSOLUTE interpreter path (the exec context can lose the export).
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

# Source the shared 0600 secrets file (the same single source every other sweep reads) so the
# agent token is present.
FUNNEL_ENV_FILE="${FUNNEL_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${FUNNEL_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${FUNNEL_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the /status
# freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) — WRAP the payload
# (never `exec`) so the marker is written even on a nonzero run. The token is `funnel-snapshot`
# (the fluncle-funnel-snapshot dir + `# Cron Job: fluncle-funnel-snapshot` header the prober matches).
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output funnel-snapshot -- "${BUN_BIN}" "${SCRIPT_DIR}/funnel-snapshot-sweep.ts" "$@"
