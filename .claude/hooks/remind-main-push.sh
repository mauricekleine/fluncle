#!/usr/bin/env bash
# PreToolUse(Bash): turn a push to main into an explicit confirm.
# A push to main is a production deploy — Cloudflare Workers Builds rebuilds apps/web
# on every push, and rapid successive pushes COALESCE: an intermediate build can be
# silently dropped. Claude Code PreToolUse supports a soft "ask", so the reminder
# surfaces as a confirm dialog carrying the coalescing note; approving proceeds.
set -uo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"

printf '%s' "$cmd" | grep -q 'git push' || exit 0

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo)"
if printf '%s' "$cmd" | grep -Eqw 'main' || [ "$branch" = "main" ]; then
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Pushing to main is a production deploy (Cloudflare Workers Builds rebuilds apps/web). Rapid successive pushes coalesce and can silently drop an intermediate build — confirm the previous build finished, then watch this one to green."}}
JSON
fi

exit 0
