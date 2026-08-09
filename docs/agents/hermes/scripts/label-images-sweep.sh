#!/usr/bin/env bash
# label-images-sweep.sh — the `--no-agent` label-image resolve cron's job ENTRY.
#
# Version-controlled source; the repo is canonical and the box is a deploy target
# (fluncle-hermes-operator skill). This pair is BAKED into the image at /opt/hermes-scripts/ and
# auto-updates from main via pin-watch; a rave-02 HOST systemd timer docker-execs it — no docker
# cp. See ../label-images-timer/README.md.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by extension —
# bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts` would be fed to Python.
# This thin wrapper is the bash entry; all the JSON work lives in the bun orchestrator beside it.
# Its stdout is the cron's run output.
#
# MusicBrainz preparation and Wikidata fallback remain in the Worker. This box performs only the
# paced Discogs detail/image reads and returns bounded evidence; the Worker re-verifies it and owns
# every R2/DB write. The named Discogs token comes from the existing sweep environment.
#
# It resolves only a label's METADATA logo — it certifies nothing and publishes nothing. Zero LLM
# tokens.
#
# Scheduled by a repo-checked-in HOST systemd timer (../label-images-timer/, installed by
# ../install-host-timers.sh), NOT a gateway `hermes cron create`. `backfill_label_images` is AGENT
# tier, so the box's existing agent-scoped token drives the Worker calls — no operator token.
# Per-run output is a freshness marker the sweep self-writes via cron-output.sh under
# ~/.hermes/cron/output/fluncle-label-images/ (read by the /status prober). See ../cron/README.md.
set -euo pipefail

# The cron runner execs this with a minimal PATH that omits /usr/local/bin (the bun + fluncle
# symlinks) and /root/.bun/bin, so a bare `bun` is "not found" → exit 127. Prepend the known install
# dirs so the wrapper resolves regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: pin the absolute interpreter path.
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

# Source the shared 0600 sweep environment so the agent token and box-side Discogs token are
# exported to the Bun driver. The host timer supplies only HOME; secrets never ride the unit.
LABEL_IMAGES_ENV_FILE="${LABEL_IMAGES_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${LABEL_IMAGES_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${LABEL_IMAGES_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the /status
# freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) — WRAP the payload
# (never `exec`) so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output label-images -- "${BUN_BIN}" "${SCRIPT_DIR}/label-images-sweep.ts" "$@"
