#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
FOLLOW_DIGEST_ENV_FILE="${FOLLOW_DIGEST_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${FOLLOW_DIGEST_ENV_FILE}" ]; then
  set -a
  . "${FOLLOW_DIGEST_ENV_FILE}"
  set +a
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output follow-digest -- "${BUN_BIN}" "${SCRIPT_DIR}/follow-digest-sweep.ts" "$@"
