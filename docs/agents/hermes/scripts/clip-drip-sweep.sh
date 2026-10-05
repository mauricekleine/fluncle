#!/usr/bin/env bash

curl_config() {
	local key="$1" value="$2"
	value="${value//\\/\\\\}"
	value="${value//\"/\\\"}"
	value="${value//$'\n'/\\n}"
	value="${value//$'\r'/\\r}"
	value="${value//$'\t'/\\t}"
	printf '%s = "%s"\n' "$key" "$value"
}

set -euo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

API_BASE_URL="${FLUNCLE_API_BASE_URL:-https://www.fluncle.com}"
DRIP_PATH="/api/v1/admin/clips/drip"

curl -fsS --max-time 30 \
	-X POST "${API_BASE_URL}${DRIP_PATH}" \
	--config - <<<"$(curl_config header "Authorization: Bearer ${FLUNCLE_API_TOKEN}")" \
	-H "Content-Type: application/json" \
	-d '{}'
