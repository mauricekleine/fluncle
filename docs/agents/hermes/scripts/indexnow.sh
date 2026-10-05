#!/usr/bin/env bash

set -euo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

INDEXNOW_ENV_FILE="${INDEXNOW_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${INDEXNOW_ENV_FILE}" ]; then
	set -a
	. "${INDEXNOW_ENV_FILE}"
	set +a
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output indexnow -- "${BUN_BIN}" "${SCRIPT_DIR}/indexnow.ts" "$@"
