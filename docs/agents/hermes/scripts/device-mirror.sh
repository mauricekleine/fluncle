#!/usr/bin/env bash
# device-mirror.sh — the `fluncle-device-mirror` host-timer entry.
#
# The Bun orchestrator beside it syncs production ONCE into a restart-safe local embedded replica,
# derives and verifies the anchored public cut locally, then stages it into ONE shared read-only
# device database. A final target transaction performs the live cutover without resetting libSQL's
# replication log or exposing a batch-wise partial generation.
#
# The source uses TURSO_DATABASE_URL + the read-only TURSO_AUTH_TOKEN already used by the backup
# sweep. The target uses DEVICE_TURSO_DATABASE_URL + a write-scoped DEVICE_TURSO_AUTH_TOKEN. All
# four arrive through the shared 0600 secrets file; this wrapper never contains a URL or token.
set -euo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export DEVICE_DERIVE_SCRIPT="${DEVICE_DERIVE_SCRIPT:-/opt/hermes-device/apps/web/scripts/derive-device-db.ts}"

DEVICE_MIRROR_ENV_FILE="${DEVICE_MIRROR_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${DEVICE_MIRROR_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${DEVICE_MIRROR_ENV_FILE}"
  set +a
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers send stdout to journald rather than the gateway cron-output tree. Wrap the payload
# so the same summary becomes both the freshness marker and the best-effort run-ledger payload.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output device-mirror -- "${BUN_BIN}" "${SCRIPT_DIR}/device-mirror.ts" "$@"
