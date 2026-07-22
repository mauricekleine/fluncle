#!/usr/bin/env bash
# embed-sweep.sh — the audio-embedding sweep's job ENTRY (`fluncle-embed`).
#
# SCHEDULED BY A HOST SYSTEMD TIMER, not a Hermes gateway cron: a windowed full-song MuQ
# forward is minutes-scale and must not occupy the shared serial gateway runner (its ~300s
# global timeout would starve the latency-sensitive 5-min sweeps — the same reason capture is
# a host timer). The rave-02 host timer `docker exec`s this script inside the container on a
# schedule — see ../embed-timer/README.md for the unit files + install. The container runner
# dispatches by extension (bash for `.sh`), and a manual `bash /opt/hermes-scripts/embed-sweep.sh`
# runs it the same way, so this thin bash wrapper is the entry; all the JSON work lives in the
# bun orchestrator beside it (embed-sweep.ts, which in turn calls embed-track.py for the MuQ
# inference). Its stdout is the run output the /status prober reads.
#
# LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy
# target (fluncle-hermes-operator skill). This trio (embed-sweep.sh/.ts + embed-track.py) is
# BAKED into the image at /opt/hermes-scripts/ and auto-updates from main via pin-watch; a
# rave-02 HOST systemd timer docker-execs it — no docker cp. See ../embed-timer/README.md and
# docs/track-lifecycle.md.
#
# PRODUCTION PRE-REQS (see ../embed-timer/README.md for the full runbook):
#   - The MuQ torch layer + baked weights in the image; ffmpeg in the image (the decode path).
#     NO yt-dlp is needed here — embed only reads R2 + runs python (unlike capture).
#   - Secrets in the shared 0600 ${HOME}/.fluncle-secrets.env (op-injected by
#     fluncle-secrets-sync), sourced below:
#       FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID / _SECRET_ACCESS_KEY — an R2 token scoped
#         Object Read on fluncle-source-audio (the captured full songs; the same credential
#         capture writes with).
#       R2_ACCOUNT_ID — the (non-secret) Cloudflare account id (also in wrangler.jsonc).
#       optional: FLUNCLE_SOURCE_AUDIO_R2_BUCKET (default fluncle-source-audio).
#       FLUNCLE_API_TOKEN — the box's AGENT-scoped token. NOW REQUIRED: the queue read moved to
#         direct HTTP (`GET /api/v1/admin/tracks/work?kind=embed`), because the CATALOGUE-aware
#         worklist is a NEW op and the box's `fluncle` CLI is a PINNED release — reading it
#         through the CLI would gate this sweep behind a pin bump. Same trick capture-sweep.sh
#         already uses. It is already in this secrets file (capture + the cost emit read it).
#     The `fluncle` CLI's own admin auth still carries the vector WRITE-BACK (`tracks update
#     --embedding-file`, an existing command) — the box's baked config under HOME, unchanged.
set -euo pipefail

# The docker-exec / runner context hands this a minimal PATH that omits /usr/local/bin (the
# bun + fluncle symlinks) and /root/.bun/bin, so a bare `bun`/`fluncle`/`python3` is
# "not found" → exit 127. Prepend the known install dirs so this wrapper's `bun` AND the
# orchestrator's `fluncle`/`bun`/`python3` spawns resolve regardless of the caller's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: the exec context can lose the PATH export above, so pin ABSOLUTE paths
# for the interpreter + the CLI. The orchestrator reads BUN_BIN/FLUNCLE_BIN/PYTHON_BIN, so its
# spawns resolve with zero PATH dependence; the wrapper itself execs bun by absolute path too.
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"
# The MuQ torch trio + muq live in the baked venv (see the Dockerfile MuQ layer), so
# embed-track.py MUST run under that interpreter, not the system python3.
export PYTHON_BIN="${PYTHON_BIN:-/opt/muq-venv/bin/python}"

# Source the shared 0600 secrets file (the same single source every other sweep reads) so the
# R2 creds are present. Provider creds are dropped from the cron env by Hermes' blocklist, so
# the R2/account creds can only arrive via this file — they are unrecognized custom vars, so
# they pass.
EMBED_ENV_FILE="${EMBED_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${EMBED_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${EMBED_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the
# /status freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) —
# WRAP the payload (never `exec`) so the marker is written even on a nonzero run. Before
# this, embed (a host timer since day one) never wrote a marker → cron.embed was cosmetic.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output embed -- "${BUN_BIN}" "${SCRIPT_DIR}/embed-sweep.ts" "$@"
