#!/usr/bin/env bash
# enrich-sweep.sh — the `--no-agent` enrichment cron's job ENTRY.
#
# LIVE. Version-controlled source; the repo is canonical and the box is a deploy
# target (fluncle-hermes-operator skill). This pair is deployed to ~/.hermes/scripts/
# on the devbox and the cron is wired there. The Worker-side enrichment trigger is
# removed — this is the only enrichment path. See ../cron/README.md.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts`
# would be fed to Python. This thin wrapper is the bash entry; all the JSON work
# lives in the bun orchestrator beside it. Its stdout is the cron's run output.
#
# Operator wires it on the devbox (once the image carries ffmpeg + bun and the
# fluncle-track-enrichment skill is installed under ~/.hermes/skills/):
#
#   hermes cron create "every 5m" --no-agent --script enrich-sweep.sh --deliver local
#
# Confirm with `hermes cron list`; per-run output lands in
# ~/.hermes/cron/output/{job_id}/{timestamp}.md.
set -euo pipefail

# The Hermes cron `--no-agent --script` runner execs this with a minimal PATH that
# omits /usr/local/bin (the bun + fluncle symlinks) and /root/.bun/bin, so a bare
# `bun`/`fluncle` is "not found" → exit 127 (the runner's env, not the image's; a
# manual `bash enrich-sweep.sh` works because it inherits the container's full PATH).
# Prepend the known install dirs so this wrapper's `bun` AND the orchestrator's
# `fluncle`/`bun` spawns resolve regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: the cron runner's exec context loses the PATH export above
# (the 127 proved it), so pin ABSOLUTE paths for the interpreter + the CLI. The
# orchestrator reads BUN_BIN/FLUNCLE_BIN, so its `bun`/`fluncle` spawns resolve
# with zero PATH dependence; the wrapper itself execs bun by absolute path too.
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# Source the shared 0600 secrets file (the same single source every other sweep reads)
# so the R2 credentials for the captured full-song fetch are in this sweep's env (RFC
# docs/full-audio-rfc.md § Unit 2). Match capture-sweep.sh: provider creds are dropped
# from the cron env by Hermes' blocklist, so the R2 creds can only arrive via this file —
# they are unrecognized custom vars, so they pass. Absent file → the sweep still enriches
# on the preview (capture must never gate enrichment).
ENRICH_ENV_FILE="${ENRICH_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${ENRICH_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${ENRICH_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec "${BUN_BIN}" "${SCRIPT_DIR}/enrich-sweep.ts" "$@"
