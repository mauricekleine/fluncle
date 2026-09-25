#!/usr/bin/env bash

set -uo pipefail
[ "${FLUNCLE_UNATTENDED:-}" = "1" ] && exit 0
bun run quality:preflight -- start --quiet >/dev/null 2>&1 || true
exit 0
