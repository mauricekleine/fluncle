#!/usr/bin/env bash
# PostToolUse(Edit|Write): format the file Claude just touched, in Fluncle's house style.
# oxfmt owns JS/TS formatting (never prettier — see AGENTS.md); gofmt owns apps/ssh Go.
# Always exits 0: formatting is best-effort and must never block or redact an edit.
set -uo pipefail

input="$(cat)"
file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
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
