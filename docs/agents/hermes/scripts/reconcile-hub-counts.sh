#!/usr/bin/env bash

set -euo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

RECONCILE_ENV_FILE="${RECONCILE_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${RECONCILE_ENV_FILE}" ]; then
	set -a
	# shellcheck source=/dev/null
	. "${RECONCILE_ENV_FILE}"
	set +a
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output reconcile-hub-counts -- "${BUN_BIN}" "${SCRIPT_DIR}/reconcile-hub-counts.ts" "$@"
