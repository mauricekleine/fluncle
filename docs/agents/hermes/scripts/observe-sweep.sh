#!/usr/bin/env bash

set -euo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

OBSERVE_ENV_FILE="${OBSERVE_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${OBSERVE_ENV_FILE}" ]; then
	set -a
	# shellcheck source=/dev/null
	. "${OBSERVE_ENV_FILE}"
	set +a
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output observation -- "${BUN_BIN}" "${SCRIPT_DIR}/observe-sweep.ts" "$@"
