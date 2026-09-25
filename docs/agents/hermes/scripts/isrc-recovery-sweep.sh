#!/usr/bin/env bash

set -euo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

ISRC_RECOVERY_ENV_FILE="${ISRC_RECOVERY_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${ISRC_RECOVERY_ENV_FILE}" ]; then
	set -a
	# shellcheck source=/dev/null
	. "${ISRC_RECOVERY_ENV_FILE}"
	set +a
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output isrc-recovery -- "${BUN_BIN}" "${SCRIPT_DIR}/isrc-recovery-sweep.ts" "$@"
