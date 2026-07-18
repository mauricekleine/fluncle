#!/usr/bin/env bash
# anchor-sweep.sh — the catalogue Spotify-anchor cron's job ENTRY (`fluncle-anchor`).
#
# SCHEDULED BY A HOST SYSTEMD TIMER (../anchor-timer/), not a Hermes gateway cron. The rave-02
# host timer docker-execs this script inside the container on a schedule; a manual
# `bash /opt/hermes-scripts/anchor-sweep.sh` runs it the same way. This thin bash wrapper is the
# entry; all the work lives in the bun orchestrator beside it (anchor-sweep.ts).
#
# LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy target
# (fluncle-hermes-operator skill). The pair is BAKED into the image at /opt/hermes-scripts/ and
# auto-updates from main via pin-watch — no docker cp. See ../anchor-timer/README.md.
#
# WHAT IT DOES (docs/catalogue-crawler.md § the anchor): fetch the anchor worklist from the Worker
# with the box's agent token, run the Apify actor to find Spotify candidates for each row, and POST
# the candidates to `anchor_track` — where the WORKER re-runs verification and writes the anchor on
# a hit. This is the ONLY catalogue anchor-fill path; the official Spotify app serves user-facing
# paths only. Resumable by construction: the worklist is derived (`spotify_uri is null`) and every
# attempt stamps a re-ask backoff, so a stopped tick loses nothing and a missed row is not re-billed
# for weeks.
#
# PRODUCTION PRE-REQS (see ../anchor-timer/README.md):
#   - Secrets in the shared 0600 ${HOME}/.fluncle-secrets.env (op-injected), sourced below:
#       FLUNCLE_API_TOKEN — the box's AGENT-scoped token (`anchor_track` + the worklist read are agent tier).
#       APIFY_API_TOKEN   — the Apify account token that runs the Spotify-scraper actor. The ONLY new
#                           secret; placeholder op://<vault>/APIFY_API_TOKEN/credential (concrete path
#                           in the private companion + the timer README's activation section).
set -euo pipefail

# The docker-exec / runner context hands this a minimal PATH that omits /usr/local/bin (the bun
# symlink) and /root/.bun/bin — prepend the known install dirs so `bun` resolves regardless.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: pin an ABSOLUTE interpreter path (the exec context can lose the export).
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

# Source the shared 0600 secrets file (the same single source every other sweep reads) so the
# agent token + the Apify token are present.
ANCHOR_ENV_FILE="${ANCHOR_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${ANCHOR_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${ANCHOR_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the /status
# freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) — WRAP the payload
# (never `exec`) so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output anchor -- "${BUN_BIN}" "${SCRIPT_DIR}/anchor-sweep.ts" "$@"
