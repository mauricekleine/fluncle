#!/usr/bin/env bash
# capture-sweep.sh — the `--no-agent` full-song CAPTURE cron's job ENTRY (`fluncle-capture`).
#
# LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy
# target (fluncle-hermes-operator skill). This pair deploys to ~/.hermes/scripts/ on the
# devbox and the cron is wired there. See ../cron/README.md § The full-song capture cron.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts` would
# be fed to Python. This thin wrapper is the bash entry; all the work lives in the bun
# orchestrator beside it (capture-sweep.ts). Its stdout is the cron's run output.
#
# WHAT IT DOES: for each finding still needing a capture (newest-first), downloads the
# full song ONCE via yt-dlp through a residential proxy on a per-track STICKY session,
# duration-guards the YouTube match against the finding's Spotify length, stores the bytes
# in the PRIVATE fluncle-source-audio R2 bucket (never fluncle-videos — that is
# world-served at found.fluncle.com), and writes the key + status back via the agent-tier
# update_track op. A NON-BLOCKING side-channel: it never gates the enrich/embed queues.
#
# PRODUCTION PRE-REQS (see ../cron/README.md § The full-song capture cron):
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
# Operator wires it on the devbox (the image already carries bun; the job needs the AGENT
# token but no operator token — it only writes analysis fields):
#
#   hermes cron create "every 5m" --no-agent --script capture-sweep.sh --deliver local --name fluncle-capture
#
# Confirm with `hermes cron list`; per-run output lands in
# ~/.hermes/cron/output/{job_id}/{timestamp}.md.
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
