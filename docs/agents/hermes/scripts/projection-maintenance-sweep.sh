#!/usr/bin/env bash
# Entry point for the bounded runtime-projection maintenance timer. The agent token can invoke
# only repair for the four runtime families; every rebuild, audit, and cutover control remains
# server-side forbidden. The TypeScript driver reads status once, stays dark with each family's
# cutover, and advances the enabled families serially under fixed request budgets.
set -euo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

PROJECTION_MAINTENANCE_ENV_FILE="${PROJECTION_MAINTENANCE_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${PROJECTION_MAINTENANCE_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${PROJECTION_MAINTENANCE_ENV_FILE}"
  set +a
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output projection-maintenance -- "${BUN_BIN}" "${SCRIPT_DIR}/projection-maintenance-sweep.ts" "$@"
