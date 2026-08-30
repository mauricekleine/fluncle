#!/usr/bin/env bash
# Entry point for the bounded public-projection maintenance timer. The agent token can invoke
# only repair for public_aggregates and artist_qualification; every other projection control
# remains server-side forbidden. The TypeScript driver reads status once, stays dark with the
# shared cutover, and gives each family its own four-call budget.
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
