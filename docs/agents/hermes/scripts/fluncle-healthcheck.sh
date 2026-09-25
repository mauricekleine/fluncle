#!/usr/bin/env bash

set -euo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

HEALTHCHECK_ENV_FILE="${HEALTHCHECK_ENV_FILE:-${HOME:-/opt/data/home}/.healthcheck.env}"
if [ -r "${HEALTHCHECK_ENV_FILE}" ]; then
	set -a
	# shellcheck source=/dev/null
	. "${HEALTHCHECK_ENV_FILE}"
	set +a
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec "${BUN_BIN}" "${SCRIPT_DIR}/fluncle-healthcheck.ts" "$@"
