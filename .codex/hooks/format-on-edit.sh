#!/usr/bin/env bash
# PostToolUse(apply_patch): format the files Codex just edited, in Fluncle's house style.
# oxfmt owns JS/TS formatting (never prettier — see AGENTS.md); gofmt owns apps/ssh Go.
# Codex edits go through apply_patch, whose tool_input carries the patch envelope (no
# clean file_path), so we pull touched paths from the "*** ... File:" / "*** Move to:"
# markers. Always exits 0: formatting is best-effort and must never block an edit.
set -uo pipefail

input="$(cat)"
files="$(printf '%s' "$input" \
  | jq -r '.tool_input | [.. | strings] | join("\n")' 2>/dev/null \
  | sed -nE 's/^\*\*\* (Add|Update|Delete) File: (.*)$/\2/p; s/^\*\*\* Move to: (.*)$/\1/p')"

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
