#!/usr/bin/env bash

set -uo pipefail

input="$(cat)"
files="$(printf '%s' "$input" |
	jq -r '.tool_input | [.. | strings] | join("\n")' 2>/dev/null |
	sed -nE 's/^\*\*\* (Add|Update|Delete) File: (.*)$/\2/p; s/^\*\*\* Move to: (.*)$/\1/p')"

[ -z "$files" ] && exit 0

while IFS= read -r file; do
	[ -z "$file" ] && continue
	[ -f "$file" ] || continue
	case "$file" in
	*.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs)
		bunx oxfmt --write "$file" >/dev/null 2>&1 || true
		bunx oxlint --fix "$file" >/dev/null 2>&1 || true
		;;
	*.go)
		gofmt -w "$file" >/dev/null 2>&1 || true
		;;
	esac
done <<EOF
$files
EOF

exit 0
