#!/usr/bin/env bash
# enrich-sweep.sh — the `--no-agent` enrichment cron's job ENTRY.
#
# LIVE. Version-controlled source; the repo is canonical and the box is a deploy
# target (fluncle-hermes-operator skill). This pair is BAKED into the image at
# /opt/hermes-scripts/ and auto-updates from main via pin-watch; a rave-02 HOST systemd
# timer docker-execs it — no docker cp. The Worker-side enrichment trigger is
# removed — this is the only enrichment path. See ../cron/README.md.
#
# Why a .sh that execs a .ts: the host timer runs the sweep as `bash <sweep>.sh`,
# so this thin wrapper is the bash entry; all the JSON work lives in the bun
# orchestrator beside it. Its stdout is the cron's run output.
#
# Scheduled by a repo-checked-in HOST systemd timer (../enrich-timer/, installed by
# ../install-host-timers.sh), which `docker exec`s it in the container. Per-run output is a
# freshness marker the sweep self-writes via cron-output.sh under
# ~/.hermes/cron/output/fluncle-enrich/ (read by the /status prober). See ../cron/README.md.
set -euo pipefail

# A caller may exec this with a minimal PATH that
# omits /usr/local/bin (the bun + fluncle symlinks) and /root/.bun/bin, so a bare
# `bun`/`fluncle` is "not found" → exit 127 (a
# `docker exec` inherits the image's full PATH, so the prepend is a guard).
# Prepend the known install dirs so this wrapper's `bun` AND the orchestrator's
# `fluncle`/`bun` spawns resolve regardless of the caller's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: an exec context can lose the PATH export above,
# so pin ABSOLUTE paths for the interpreter + the CLI. The
# orchestrator reads BUN_BIN/FLUNCLE_BIN, so its `bun`/`fluncle` spawns resolve
# with zero PATH dependence; the wrapper itself execs bun by absolute path too.
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# Source the shared 0600 secrets file (the same single source every other sweep reads)
# so the R2 credentials for the captured full-song fetch are in this sweep's env (RFC
# docs/track-lifecycle.md). Match capture-sweep.sh: the container env carries
# only the agent token and the alert webhook, so the R2 creds arrive via this file.
# Absent file → the sweep still enriches
# on the preview (capture must never gate enrichment).
#
# The same file supplies FLUNCLE_API_TOKEN, which the CATALOGUE arm now needs: its worklist
# (`GET /api/v1/admin/tracks/work?kind=analyze&scope=catalogue`) is read over direct HTTP, since
# it is a NEW op and the box's `fluncle` CLI is a PINNED release. Absent token → the catalogue
# arm is skipped and the findings arm runs exactly as before (docs/gpu-batch-embed.md).
ENRICH_ENV_FILE="${ENRICH_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${ENRICH_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${ENRICH_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers write no per-run output file, so self-report the
# /status freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) —
# WRAP the payload (never `exec`) so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output enrich -- "${BUN_BIN}" "${SCRIPT_DIR}/enrich-sweep.ts" "$@"
