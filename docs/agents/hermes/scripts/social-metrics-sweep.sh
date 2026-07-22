#!/usr/bin/env bash
# social-metrics-sweep.sh — the social-metrics snapshot cron's job ENTRY (`fluncle-social-metrics`).
#
# SCHEDULED BY A HOST SYSTEMD TIMER (../social-metrics-timer/), not a Hermes gateway cron. The
# rave-02 host timer docker-execs this script inside the container once a day; a manual
# `bash /opt/hermes-scripts/social-metrics-sweep.sh` runs it the same way. This thin bash wrapper is
# the entry; all the work lives in the bun orchestrator beside it (social-metrics-sweep.ts).
#
# LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy target
# (fluncle-hermes-operator skill). The pair is BAKED into the image at /opt/hermes-scripts/ and
# auto-updates from main via pin-watch — no docker cp. See ../social-metrics-timer/README.md.
#
# WHAT IT DOES: POST /api/v1/admin/social/metrics/record with the box's agent token — a bare trigger.
# The WORKER selects ≤25 published posts (the Postiz 30/hour cap), reads each one's Postiz per-post
# analytics, and APPENDS one social_metrics row per (post, source, UTC day) — append-only (velocity),
# idempotent per day (a re-fired tick lands inserted:0). It is the per-video performance history
# behind future reach reporting. Zero LLM tokens.
#
# PRODUCTION PRE-REQS (see ../social-metrics-timer/README.md):
#   - Secrets in the shared 0600 ${HOME}/.fluncle-secrets.env (op-injected), sourced below:
#       FLUNCLE_API_TOKEN — the box's AGENT-scoped token (`record_social_metrics` is agent tier).
#   - NO new secret: the Postiz key (and the SA key) live Worker-side, so the box is a bare trigger.
set -euo pipefail

# The docker-exec / runner context hands this a minimal PATH that omits /usr/local/bin (the bun
# symlink) and /root/.bun/bin — prepend the known install dirs so `bun` resolves regardless.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: pin an ABSOLUTE interpreter path (the exec context can lose the export).
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

# Source the shared 0600 secrets file (the same single source every other sweep reads) so the
# agent token is present.
SOCIAL_METRICS_ENV_FILE="${SOCIAL_METRICS_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${SOCIAL_METRICS_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${SOCIAL_METRICS_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the /status
# freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) — WRAP the payload
# (never `exec`) so the marker is written even on a nonzero run. The token is `social-metrics`
# (the fluncle-social-metrics dir + `# Cron Job: fluncle-social-metrics` header the prober matches).
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output social-metrics -- "${BUN_BIN}" "${SCRIPT_DIR}/social-metrics-sweep.ts" "$@"
