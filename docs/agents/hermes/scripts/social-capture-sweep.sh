#!/usr/bin/env bash

set -euo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

API_BASE_URL="${FLUNCLE_API_BASE_URL:-https://www.fluncle.com}"
CAPTURE_PATH="/api/v1/admin/social/posts/capture"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"

run_social_capture() {
	local raw rc=0
	raw="$(curl -fsS --max-time 30 \
		-X POST "${API_BASE_URL}${CAPTURE_PATH}" \
		-H "Authorization: Bearer ${FLUNCLE_API_TOKEN}" \
		-H "Content-Type: application/json" \
		-d '{}')" || rc="$?"

	if [ "$rc" -ne 0 ]; then
		printf '%s\n' '{"checked":null,"errors":1,"failed":null,"ok":false,"produced":null,"reason":"request_failed"}'
		return "$rc"
	fi

	printf '%s' "$raw" | "${BUN_BIN}" "${SCRIPT_DIR}/worker-trigger-counters.ts" social-capture
}

emit_cron_output social-capture -- run_social_capture
