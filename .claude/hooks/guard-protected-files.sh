#!/usr/bin/env bash
# PreToolUse(Edit|Write): refuse edits the repo rules forbid by hand.
#   - Drizzle migrations under apps/web/drizzle/ are GENERATED, never hand-written.
#     Change apps/web/src/db/schema.ts, then `bun run --cwd apps/web db:generate`.
#   - .env / secret files are never edited by the agent (secrets live in 1Password
#     and Cloudflare Worker secrets, not the repo).
# Exit 2 blocks the call and feeds stderr back to Claude as the reason.
set -uo pipefail

input="$(cat)"
file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
[ -z "$file" ] && exit 0

case "$file" in
  */apps/web/drizzle/*.sql | */apps/web/drizzle/meta/*)
    echo "Refusing to hand-edit a Drizzle migration ($file). Migrations are generated: edit apps/web/src/db/schema.ts, then run \`bun run --cwd apps/web db:generate\` (AGENTS.md: NEVER write SQL migrations by hand)." >&2
    exit 2
    ;;
  */.env | */.env.* | .env | .env.*)
    echo "Refusing to edit an env/secret file ($file). Fluncle secrets live in 1Password and Cloudflare Worker secrets, not in the repo." >&2
    exit 2
    ;;
esac

exit 0
