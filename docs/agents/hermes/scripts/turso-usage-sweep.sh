#!/usr/bin/env bash

set -euo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

TURSO_USAGE_ENV_FILE="${TURSO_USAGE_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${TURSO_USAGE_ENV_FILE}" ]; then
	set -a
	# shellcheck source=/dev/null
	. "${TURSO_USAGE_ENV_FILE}"
	set +a
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output turso-usage -- "${BUN_BIN}" "${SCRIPT_DIR}/turso-usage-sweep.ts" "$@"
