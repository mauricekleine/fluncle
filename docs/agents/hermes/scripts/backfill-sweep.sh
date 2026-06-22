#!/usr/bin/env bash
# backfill-sweep.sh — the `--no-agent` catalogue-backfill cron's job ENTRY.
#
# PREPARED, NOT YET WIRED. Version-controlled source; the repo is canonical and the
# box is a deploy target (fluncle-hermes-operator skill). This pair deploys to
# ~/.hermes/scripts/ on the devbox and the cron is wired there. See ../cron/README.md.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts`
# would be fed to Python. This thin wrapper is the bash entry; all the JSON work
# lives in the bun orchestrator beside it. Its stdout is the cron's run output.
#
# THE WORKER-PACED MODEL: the box holds NO Discogs/Last.fm vendor keys; the Worker
# does. So the backfill API calls happen in the Worker — this driver just paces one
# small bounded batch of each source per tick via the `fluncle` CLI, and the Worker
# carries the per-finding reliability state + Retry-After backoff.
#
# Operator wires it on the devbox (the image already carries bun + the fluncle CLI;
# the backfills are AGENT tier, so the box's existing agent-scoped token drives them
# — no operator token needed):
#
#   hermes cron create "every 30m" --no-agent --script backfill-sweep.sh --deliver local
#
# Confirm with `hermes cron list`; per-run output lands in
# ~/.hermes/cron/output/{job_id}/{timestamp}.md.
set -euo pipefail

# The Hermes cron `--no-agent --script` runner execs this with a minimal PATH that
# omits /usr/local/bin (the bun + fluncle symlinks) and /root/.bun/bin, so a bare
# `bun`/`fluncle` is "not found" → exit 127 (the runner's env, not the image's; a
# manual `bash backfill-sweep.sh` works because it inherits the container's full PATH).
# Prepend the known install dirs so this wrapper's `bun` AND the orchestrator's
# `fluncle`/`bun` spawns resolve regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: the cron runner's exec context loses the PATH export above,
# so pin ABSOLUTE paths for the interpreter + the CLI. The orchestrator reads
# BUN_BIN/FLUNCLE_BIN, so its `bun`/`fluncle` spawns resolve with zero PATH
# dependence; the wrapper itself execs bun by absolute path too.
export BUN_BIN="${BUN_BIN:-/root/.bun/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec "${BUN_BIN}" "${SCRIPT_DIR}/backfill-sweep.ts" "$@"
