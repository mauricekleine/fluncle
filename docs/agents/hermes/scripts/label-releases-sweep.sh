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
# WHAT IT DOES (docs/catalogue-crawler.md § the freshness tap): fetch the DUE enabled seed labels from
# the Worker with the box's agent token, run the Apify actor per label to find its fresh releases, and
# POST each label's candidates to `backfill_label_releases` — where the WORKER re-runs the full gate
# (artist-grounding + label attribution + dedupe) and mints the survivors. The tap is off the official
# Spotify budget entirely (the anchor-sweep model); the Worker touches no Spotify API on this path.
# Resumable by construction: the worklist is derived (the oldest-probed enabled labels) and completing
# a label stamps its re-probe cadence, so a stopped tick loses nothing and re-running drains what is due.
#
# PRODUCTION PRE-REQS (see ../label-releases-timer/README.md):
#   - Secrets in the shared 0600 ${HOME}/.fluncle-secrets.env (op-injected), sourced below:
#       FLUNCLE_API_TOKEN — the box's AGENT-scoped token (`backfill_label_releases` + the worklist read
#                           are agent tier).
#       APIFY_API_TOKEN   — the Apify account token that runs the Spotify-scraper actor. NOT a new
#                           secret — the catalogue anchor sweep already provisions it; the tap reuses
#                           the SAME one. Placeholder op://<vault>/APIFY_API_TOKEN/credential (concrete
#                           path in the private companion + the timer README's activation section).
set -euo pipefail

# The docker-exec / runner context hands this a minimal PATH that omits /usr/local/bin (the bun
# symlink) and /root/.bun/bin — prepend the known install dirs so `bun` resolves regardless.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: pin an ABSOLUTE interpreter path (the exec context can lose the export).
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

# Source the shared 0600 secrets file (the same single source every other sweep reads) so the
# agent token + the Apify token are present.
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
