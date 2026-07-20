#!/usr/bin/env bash
# label-releases-sweep.sh — the FRESHNESS TAP cron's job ENTRY (`fluncle-label-releases`, D8).
#
# SCHEDULED BY A HOST SYSTEMD TIMER (../label-releases-timer/), not a Hermes gateway cron. The rave-02
# host timer docker-execs this script inside the container on a schedule; a manual
# `bash /opt/hermes-scripts/label-releases-sweep.sh` runs it the same way. This thin bash wrapper is
# the entry; all the work lives in the bun orchestrator beside it (label-releases-sweep.ts).
#
# LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy target
# (fluncle-hermes-operator skill). The pair is BAKED into the image at /opt/hermes-scripts/ and
# auto-updates from main via pin-watch — no docker cp. See ../label-releases-timer/README.md.
#
# WHAT IT DOES (docs/catalogue-crawler.md § the freshness tap): POST bounded passes of
# `backfill_label_releases` with the box's agent token until the due seed labels are drained. The
# WORKER does all of it — the official-Spotify fresh-release search, the artist-grounding + copyright
# gate, the dedupe, the mint — and paces itself against the shared per-app call meter so a user's
# playlist mint always finds window headroom. This wrapper is a TRIGGER; the box holds no Spotify
# identity and no vendor token on this path.
# Resumable by construction: the worklist is derived (the oldest-probed enabled labels) and completing
# a label stamps its re-probe cadence, so a stopped tick loses nothing and re-running drains what is due.
#
# PRODUCTION PRE-REQS (see ../label-releases-timer/README.md):
#   - Secrets in the shared 0600 ${HOME}/.fluncle-secrets.env (op-injected), sourced below:
#       FLUNCLE_API_TOKEN — the box's AGENT-scoped token (`backfill_label_releases` is agent tier).
#                           The ONLY secret this sweep needs; the tap's Spotify calls happen in the
#                           Worker on the publish path's OAuth grant.
set -euo pipefail

# The docker-exec / runner context hands this a minimal PATH that omits /usr/local/bin (the bun
# symlink) and /root/.bun/bin — prepend the known install dirs so `bun` resolves regardless.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: pin an ABSOLUTE interpreter path (the exec context can lose the export).
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

# Source the shared 0600 secrets file (the same single source every other sweep reads) so the
# agent token is present.
LABEL_RELEASES_ENV_FILE="${LABEL_RELEASES_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${LABEL_RELEASES_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${LABEL_RELEASES_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the /status
# freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) — WRAP the payload
# (never `exec`) so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output label-releases -- "${BUN_BIN}" "${SCRIPT_DIR}/label-releases-sweep.ts" "$@"
