#!/usr/bin/env bash
# device-mirror.sh — the `fluncle-device-mirror` host-timer entry.
#
# The Bun orchestrator beside it diffs production Turso's anchored public cut into ONE shared
# read-only device database. The target is mutated in place: rebuilding it would reset libSQL's
# replication log and force every installed device to bootstrap the full database again.
#
# The source uses TURSO_DATABASE_URL + the read-only TURSO_AUTH_TOKEN already used by the backup
# sweep. The target uses DEVICE_TURSO_DATABASE_URL + a write-scoped DEVICE_TURSO_AUTH_TOKEN. All
# four arrive through the shared 0600 secrets file; this wrapper never contains a URL or token.
set -euo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

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
