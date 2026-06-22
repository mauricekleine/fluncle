#!/usr/bin/env bash
# PreToolUse(apply_patch): refuse edits the repo rules forbid by hand.
#   - Drizzle migrations under apps/web/drizzle/ are GENERATED, never hand-written.
#     Change apps/web/src/db/schema.ts, then `bun run --cwd apps/web db:generate`.
#   - .env / secret files are never edited by the agent (1Password / Worker secrets).
# Codex file edits arrive as an apply_patch envelope; we extract every touched path
# from the "*** ... File:" / "*** Move to:" markers and check each one.
# Exit 2 blocks the call; Codex surfaces the stderr text as the reason.
set -uo pipefail

input="$(cat)"
files="$(printf '%s' "$input" \
  | jq -r '.tool_input | [.. | strings] | join("\n")' 2>/dev/null \
  | sed -nE 's/^\*\*\* (Add|Update|Delete) File: (.*)$/\2/p; s/^\*\*\* Move to: (.*)$/\1/p')"

blocked=0
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    *apps/web/drizzle/*.sql | *apps/web/drizzle/meta/*)
      echo "Refusing to hand-edit a Drizzle migration ($file). Migrations are generated: edit apps/web/src/db/schema.ts, then run \`bun run --cwd apps/web db:generate\` (AGENTS.md: NEVER write SQL migrations by hand)." >&2
      blocked=1
      ;;
  esac
  case "${file##*/}" in
    .env | .env.*)
      echo "Refusing to edit an env/secret file ($file). Fluncle secrets live in 1Password and Cloudflare Worker secrets, not in the repo." >&2
      blocked=1
      ;;
  esac
done <<EOF
$files
EOF

[ "$blocked" -eq 1 ] && exit 2
exit 0
