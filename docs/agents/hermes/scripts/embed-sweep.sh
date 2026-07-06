#!/usr/bin/env bash
# embed-sweep.sh — the `--no-agent` audio-embedding cron's job ENTRY.
#
# LIVE. Version-controlled source; the repo is canonical and the box is a deploy
# target (fluncle-hermes-operator skill). This pair (+ embed-track.py) is deployed to
# ~/.hermes/scripts/ on the devbox and the cron is wired there. See ../cron/README.md
# and docs/audio-embedding-rfc.md.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts`
# would be fed to Python. This thin wrapper is the bash entry; all the JSON work lives
# in the bun orchestrator beside it (which in turn calls embed-track.py for the MuQ
# inference). Its stdout is the cron's run output.
#
# Operator wires it on the devbox (once the image carries the MuQ torch layer + baked
# weights and this trio is under ~/.hermes/scripts/):
#
#   hermes cron create "every 5m" --no-agent --script embed-sweep.sh --deliver local --name fluncle-embed
#
# Confirm with `hermes cron list`; per-run output lands in
# ~/.hermes/cron/output/{job_id}/{timestamp}.md.
set -euo pipefail

# The Hermes cron `--no-agent --script` runner execs this with a minimal PATH that
# omits /usr/local/bin (the bun + fluncle symlinks) and /root/.bun/bin, so a bare
# `bun`/`fluncle`/`python3` is "not found" → exit 127 (the runner's env, not the
# image's; a manual `bash embed-sweep.sh` works because it inherits the container's
# full PATH). Prepend the known install dirs so this wrapper's `bun` AND the
# orchestrator's `fluncle`/`bun`/`python3` spawns resolve regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: the cron runner's exec context loses the PATH export above, so
# pin ABSOLUTE paths for the interpreter + the CLI. The orchestrator reads
# BUN_BIN/FLUNCLE_BIN/PYTHON_BIN, so its spawns resolve with zero PATH dependence; the
# wrapper itself execs bun by absolute path too.
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"
# The MuQ torch trio + muq live in the baked venv (see the Dockerfile MuQ layer), so
# embed-track.py MUST run under that interpreter, not the system python3.
export PYTHON_BIN="${PYTHON_BIN:-/opt/muq-venv/bin/python}"

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec "${BUN_BIN}" "${SCRIPT_DIR}/embed-sweep.ts" "$@"
