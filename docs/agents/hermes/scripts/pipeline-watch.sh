#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
HEALTHCHECK_ENV_FILE="${HEALTHCHECK_ENV_FILE:-${HOME:-/opt/data/home}/.healthcheck.env}"
if [ -r "$HEALTHCHECK_ENV_FILE" ]; then
  set -a
  . "$HEALTHCHECK_ENV_FILE"
  set +a
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output pipeline-watch -- "$BUN_BIN" "${SCRIPT_DIR}/pipeline-watch.ts"
