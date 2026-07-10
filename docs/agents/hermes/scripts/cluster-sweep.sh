#!/usr/bin/env bash
# cluster-sweep.sh — the sonic-galaxy cluster engine's job ENTRY (`fluncle-cluster`).
#
# SCHEDULED BY A HOST SYSTEMD TIMER, not a Hermes gateway cron: the cluster engine is a
# stateful nightly batch job that reads the whole embedded corpus + the map and writes the
# map back — it wants the box and its admin token, never the shared serial gateway runner
# (the same reason embed + capture are host timers). The rave-02 host timer `docker exec`s
# this script inside the container once a night — see ../cluster-timer/README.md for the unit
# files + install. A manual `bash /opt/hermes-scripts/cluster-sweep.sh [--cold-start|--remint]`
# runs it the same way (the operator acts). Its stdout is the run output the /status prober reads.
#
# LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy
# target (fluncle-hermes-operator skill). This trio (cluster-sweep.sh/.ts + cluster.py) is
# BAKED into the image at /opt/hermes-scripts/ and auto-updates from main via pin-watch; a
# rave-02 HOST systemd timer docker-execs it — no docker cp. See ../cluster-timer/README.md
# and docs/agents/cluster-engine.md.
#
# PRODUCTION PRE-REQS (see ../cluster-timer/README.md for the full runbook):
#   - sklearn + scipy in the baked MuQ venv (the Dockerfile MuQ layer's THIRD pinned pip step,
#     numpy-constrained). The nightly assignment step is pure TS and never imports python; the
#     OPERATOR-act fits (cold-start / remint) + a split's k=2 fit are the only python spawns.
#   - The `fluncle` CLI's own admin auth (the map read + the corpus read + the map/assignment
#     write-back) is the box's baked config under HOME — the box holds only an `agent`-scoped
#     token, so the OPERATOR-tier `update_galaxy` (naming) 403s here by design; the cron only
#     ever reads/writes the map + assignments (admin tier) and consumes `split_requested_at`.
set -euo pipefail

# The docker-exec / runner context hands this a minimal PATH that omits /usr/local/bin (the
# bun + fluncle symlinks) and /root/.bun/bin, so a bare `bun`/`fluncle`/`python3` is
# "not found" -> exit 127. Prepend the known install dirs so this wrapper's `bun` AND the
# orchestrator's `fluncle`/`bun`/`python3` spawns resolve regardless of the caller's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: the exec context can lose the PATH export above, so pin ABSOLUTE paths
# for the interpreter + the CLI. The orchestrator reads BUN_BIN/FLUNCLE_BIN/PYTHON_BIN, so its
# spawns resolve with zero PATH dependence; the wrapper itself execs bun by absolute path too.
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"
# sklearn + scipy live in the baked MuQ venv (the Dockerfile's third pip step), so cluster.py
# MUST run under that interpreter, not the system python3.
export PYTHON_BIN="${PYTHON_BIN:-/opt/muq-venv/bin/python}"

# Pin the BLAS/OpenMP thread count to 1 so a k-means fit's float reductions are bit-stable
# across rebuilds (thread count changes the reduction order → tiny centroid drift). The
# nightly assignment step is single-threaded TS and already deterministic; this guards the
# operator-act fits (cold-start / remint / split) so a re-fit is reproducible.
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-1}"
export OPENBLAS_NUM_THREADS="${OPENBLAS_NUM_THREADS:-1}"
export MKL_NUM_THREADS="${MKL_NUM_THREADS:-1}"

# Source the shared 0600 secrets file (the same single source every other sweep reads) so
# FLUNCLE_API_TOKEN / FLUNCLE_API_BASE_URL are present for the best-effort cost emit (the CLI's
# own admin auth is the baked config under HOME, unchanged).
CLUSTER_ENV_FILE="${CLUSTER_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${CLUSTER_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${CLUSTER_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the
# /status freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) —
# WRAP the payload (never `exec`) so the marker is written even on a nonzero run. Forward
# every arg (e.g. --cold-start / --remint on a manual operator run) to the orchestrator.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output cluster -- "${BUN_BIN}" "${SCRIPT_DIR}/cluster-sweep.ts" "$@"
