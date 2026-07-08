#!/usr/bin/env bash
# clip-sweep.sh — the `--no-agent` Fluncle Studio clip-cut cron's job ENTRY
# (`fluncle-studio-clip`).
#
# Version-controlled source; the repo is canonical and the box is a deploy target
# (fluncle-hermes-operator skill). This pair deploys to ~/.hermes/scripts/ on the devbox
# and the cron is wired there. See ../cron/README.md and docs/fluncle-studio.md.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts` would
# be fed to Python. This thin wrapper is the bash entry; all the JSON work lives in the
# bun orchestrator beside it. Its stdout is the cron's run output.
#
# PURE-TRIGGER (the enrich-sweep shape, NOT the note/observe hybrid): there is NO
# `claude -p` step. The cut is a deterministic ffmpeg job driven entirely by the
# `fluncle` CLI (`admin clips list` → `admin clips cut`), so this script needs only the
# agent-scoped FLUNCLE_API_TOKEN (the `list_clips` read + the agent-tier
# `presign_clip_upload` / `finalize_clip_cut`) — no provider credentials.
#
# PRODUCTION PRE-REQS (see docs/fluncle-studio.md § box deploy):
#   - `ffmpeg` installed on the box (apt-get install -y ffmpeg) + a font for the brand
#     frame (fontconfig + e.g. fonts-dejavu-core, or set CLIP_FONT_FILE to a .ttf path).
#   - the baked `bun` + `fluncle` CLI (already in the image).
#
# Operator wires it on the devbox (`presign_clip_upload`/`finalize_clip_cut` are AGENT
# tier, so the box's existing agent-scoped token drives them — no operator token needed):
#
#   hermes cron create "every 15m" --no-agent --script clip-sweep.sh --deliver local --name fluncle-studio-clip
#
# Confirm with `hermes cron list`; per-run output lands in
# ~/.hermes/cron/output/{job_id}/{timestamp}.md.
set -euo pipefail

# The Hermes cron `--no-agent --script` runner execs this with a minimal PATH that omits
# the bun + fluncle symlink dirs, so a bare `bun`/`fluncle` is "not found" → exit 127.
# Prepend the known install dirs so this wrapper's `bun` AND the orchestrator's
# `fluncle`/`bun`/`ffmpeg` spawns resolve regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: pin ABSOLUTE paths for the interpreter + the CLI; the orchestrator
# reads BUN_BIN/FLUNCLE_BIN so its spawns resolve with zero PATH dependence.
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# Optional config (CLIP_FONT_FILE for the brand-frame font; CLIP_BATCH_CAP to widen the
# per-tick batch) can live in the shared 0600 secrets file the other sweeps source. It is
# NOT required — the cut runs with fontconfig's default font and a batch of 1 otherwise.
CLIP_ENV_FILE="${CLIP_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${CLIP_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${CLIP_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the
# /status freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) —
# WRAP the payload (never `exec`) so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output studio-clip -- "${BUN_BIN}" "${SCRIPT_DIR}/clip-sweep.ts" "$@"
