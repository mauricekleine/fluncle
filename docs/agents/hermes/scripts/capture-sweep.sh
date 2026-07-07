#!/usr/bin/env bash
# capture-sweep.sh — the full-song CAPTURE sweep's job ENTRY (`fluncle-capture`).
#
# SCHEDULED BY A HOST SYSTEMD TIMER, not a Hermes gateway cron: a proxied yt-dlp fetch has
# an unbounded tail that would starve the latency-sensitive 5-min sweeps on the shared
# serial runner. The rave-02 host timer `docker exec`s this script inside the container
# every 5m — see ../capture-timer/README.md for the unit files + install. The container
# runner dispatches by extension (bash for `.sh`), and a manual `bash /opt/data/scripts/
# capture-sweep.sh` runs it the same way, so this thin bash wrapper is the entry; all the
# work lives in the bun orchestrator beside it (capture-sweep.ts). Its stdout is the run
# output the /status prober reads.
#
# LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy
# target (fluncle-hermes-operator skill). This pair deploys to /opt/data/scripts/ on the
# devbox via `docker cp`. See ../cron/README.md § The full-song capture sweep + ../capture-timer/.
#
# WHAT IT DOES: for each finding still needing a capture (newest-first, backoff-aware),
# downloads the full song ONCE via yt-dlp through a residential proxy on a per-track STICKY
# session, duration-guards the YouTube match against the finding's Spotify length, stores
# the bytes in the PRIVATE fluncle-source-audio R2 bucket (never fluncle-videos — that is
# world-served at found.fluncle.com), and writes the key + status back via the agent-tier
# update_track op. A NON-BLOCKING side-channel: it never gates the enrich/embed queues.
#
# PRODUCTION PRE-REQS (see ../capture-timer/README.md for the full runbook):
#   - yt-dlp AND ffprobe on PATH (a box deploy prereq — the orchestrator installs them).
#   - Secrets in the shared 0600 ${HOME}/.fluncle-secrets.env (op-injected by
#     fluncle-secrets-sync), sourced below:
#       FLUNCLE_API_TOKEN — the box's AGENT-scoped token (the update_track write-back).
#       FLUNCLE_YTDLP_PROXY_HOST / _PORT / _USERNAME / _PASSWORD — the residential proxy.
#       FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID / _SECRET_ACCESS_KEY — an R2 token scoped
#         Object Read & Write on fluncle-source-audio ONLY (never fluncle-videos).
#       R2_ACCOUNT_ID — the (non-secret) Cloudflare account id (also in wrangler.jsonc).
#       optional: FLUNCLE_API_BASE_URL (default https://www.fluncle.com),
#         FLUNCLE_SOURCE_AUDIO_R2_BUCKET (default fluncle-source-audio),
#         FLUNCLE_CAPTURE_BATCH_CAP (4) / _QUEUE_LIMIT (8) / _TOLERANCE_SEC (3) / _TOLERANCE_PCT (0.03).
#   - The private bucket must exist (operator step; done 2026-07-07).
#
# Operator install (host timer — full runbook in ../capture-timer/README.md): docker cp
# this pair into /opt/data/scripts/, then install fluncle-capture.{service,timer} into
# /etc/systemd/system/ + `systemctl enable --now fluncle-capture.timer`. The job needs the
# AGENT token but no operator token — it only writes analysis fields. Smoke-test as the
# cron user: `docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/data/scripts/capture-sweep.sh`.
set -euo pipefail

# The runner execs this with a minimal PATH that omits /usr/local/bin (the bun symlink)
# and /root/.bun/bin, so a bare `bun`/`yt-dlp`/`ffprobe` is "not found" → exit 127.
# Prepend the known install dirs so this wrapper's tools resolve regardless of the
# runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: pin the absolute interpreter path too (the runner can lose the
# PATH export above).
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

# Source the shared 0600 secrets file (the same single source every other sweep reads;
# provider creds are dropped from the cron env by Hermes' blocklist, so the proxy/R2/API
# creds can only arrive via this file — they are unrecognized custom vars, so they pass).
CAPTURE_ENV_FILE="${CAPTURE_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${CAPTURE_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${CAPTURE_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec "${BUN_BIN}" "${SCRIPT_DIR}/capture-sweep.ts" "$@"
