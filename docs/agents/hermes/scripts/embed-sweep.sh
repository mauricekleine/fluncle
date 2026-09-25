#!/usr/bin/env bash

set -euo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

export PYTHON_BIN="${PYTHON_BIN:-/opt/muq-venv/bin/python}"

EMBED_ENV_FILE="${EMBED_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${EMBED_ENV_FILE}" ]; then
	set -a
	# shellcheck source=/dev/null
	. "${EMBED_ENV_FILE}"
	set +a
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output embed -- "${BUN_BIN}" "${SCRIPT_DIR}/embed-sweep.ts" "$@"
