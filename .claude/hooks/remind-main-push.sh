#!/usr/bin/env bash
# PreToolUse(Bash): non-blocking confirm-gate when pushing to main.
# A push to main is a production deploy — Cloudflare Workers Builds rebuilds
# apps/web on every push, and rapid successive pushes COALESCE: an intermediate
# build can be silently dropped (no build entry, not a failure). This turns the
# push into an explicit "ask" carrying that reminder, instead of letting it slip.
set -uo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"

printf '%s' "$cmd" | grep -q 'git push' || exit 0

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo)"
if printf '%s' "$cmd" | grep -Eqw 'main' || [ "$branch" = "main" ]; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Push to main is a production deploy: Cloudflare Workers Builds rebuilds apps/web. Rapid successive pushes coalesce and can silently drop an intermediate build. Confirm the previous build finished and that this push is intended."}}'
fi

exit 0
