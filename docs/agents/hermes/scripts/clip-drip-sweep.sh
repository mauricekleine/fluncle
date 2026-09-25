#!/usr/bin/env bash

set -euo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

API_BASE_URL="${FLUNCLE_API_BASE_URL:-https://www.fluncle.com}"
DRIP_PATH="/api/v1/admin/clips/drip"

curl -fsS --max-time 30 \
	-X POST "${API_BASE_URL}${DRIP_PATH}" \
	-H "Authorization: Bearer ${FLUNCLE_API_TOKEN}" \
	-H "Content-Type: application/json" \
	-d '{}'
