#!/usr/bin/env bash
# verify-captures.sh — the capture-verification backfill's job ENTRY (`fluncle-verify-captures`).
#
# SCHEDULED BY A HOST SYSTEMD TIMER (../verify-captures-timer/), not a Hermes gateway cron. The
# rave-02 host timer docker-execs this script inside the container on a schedule; a manual
# `bash /opt/hermes-scripts/verify-captures.sh` runs it the same way. This thin bash wrapper is
# the entry; all the work lives in the bun orchestrator beside it (verify-captures.ts).
#
# LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy target
# (fluncle-hermes-operator skill). The pair is BAKED into the image at /opt/hermes-scripts/ and
# auto-updates from main via pin-watch — no docker cp. See ../verify-captures-timer/README.md.
#
# WHAT IT DOES (docs/the-ear.md § Wrong audio): walk every captured row whose bytes were never
# fingerprint-checked against the track's ISRC-resolved official preview, run the Chromaprint
# match, and report the verdict to the Worker — which routes it (stamp `preview-match` /
# `unverified`, quarantine a catalogue mismatch, raise the operator attention item on a finding
# mismatch; a machine never rewinds a public finding). Resumable by construction: a stamped row
# leaves the worklist. DEGRADES HONESTLY without fpcalc (pre-rebake): the tick reports
# `fpcalc_missing` and stamps nothing.
#
# PRODUCTION PRE-REQS (see ../verify-captures-timer/README.md):
#   - fpcalc (the `libchromaprint-tools` apt package) in the image — the chromaprint rebake.
#   - Secrets in the shared 0600 ${HOME}/.fluncle-secrets.env (op-injected), sourced below:
#       FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID / _SECRET_ACCESS_KEY — the private-bucket R2 token
#         (Object Read is all this sweep uses; the same credential capture/embed already hold).
#       R2_ACCOUNT_ID — the (non-secret) Cloudflare account id.
#       FLUNCLE_API_TOKEN — the box's AGENT-scoped token (the two ops are agent tier).
set -euo pipefail

# The docker-exec / runner context hands this a minimal PATH that omits /usr/local/bin (the bun
# symlink) and /root/.bun/bin — prepend the known install dirs so `bun` resolves regardless.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: pin an ABSOLUTE interpreter path (the exec context can lose the export).
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

# Source the shared 0600 secrets file (the same single source every other sweep reads) so the
# R2 creds + agent token are present.
VERIFY_ENV_FILE="${VERIFY_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${VERIFY_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${VERIFY_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the /status
# freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) — WRAP the payload
# (never `exec`) so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output verify-captures -- "${BUN_BIN}" "${SCRIPT_DIR}/verify-captures.ts" "$@"
