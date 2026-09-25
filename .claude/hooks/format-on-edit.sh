#!/usr/bin/env bash

set -uo pipefail

HOOK_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_hook-json.sh
. "${HOOK_DIR}/_hook-json.sh"

[ "${FLUNCLE_UNATTENDED:-}" = "1" ] && exit 0

fields="$(hook_read_fields)" || exit 0
file="$(printf '%s' "$fields" | sed -n '2p')"
[ -z "$file" ] && exit 0
[ -f "$file" ] || exit 0

case "$file" in
*.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs)
	bunx oxfmt --write "$file" >/dev/null 2>&1 || true
	bunx oxlint --fix "$file" >/dev/null 2>&1 || true
	;;
*.go)
	gofmt -w "$file" >/dev/null 2>&1 || true
	;;
esac

exit 0
