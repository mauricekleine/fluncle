#!/usr/bin/env bash

set -euo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

SOCIAL_METRICS_ENV_FILE="${SOCIAL_METRICS_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${SOCIAL_METRICS_ENV_FILE}" ]; then
	set -a
	# shellcheck source=/dev/null
	. "${SOCIAL_METRICS_ENV_FILE}"
	set +a
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output social-metrics -- "${BUN_BIN}" "${SCRIPT_DIR}/social-metrics-sweep.ts" "$@"
