#!/usr/bin/env bash
# PreToolUse(Bash): non-blocking reminder when pushing to main.
# A push to main is a production deploy — Cloudflare Workers Builds rebuilds apps/web
# on every push, and rapid successive pushes COALESCE: an intermediate build can be
# silently dropped. Codex PreToolUse has no soft "ask" (only allow/deny), so we surface
# the reminder as a non-blocking notice — stderr + exit 1, which Codex reports while
# letting the command proceed. The push still goes through.
set -uo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"

printf '%s' "$cmd" | grep -q 'git push' || exit 0

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo)"
if printf '%s' "$cmd" | grep -Eqw 'main' || [ "$branch" = "main" ]; then
  echo "Reminder: pushing to main is a production deploy (Cloudflare Workers Builds rebuilds apps/web). Rapid successive pushes coalesce and can silently drop an intermediate build — confirm the previous build finished. Proceeding with the push." >&2
  exit 1
fi

exit 0
