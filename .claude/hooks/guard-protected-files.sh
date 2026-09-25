#!/usr/bin/env bash

set -uo pipefail

HOOK_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_hook-json.sh
. "${HOOK_DIR}/_hook-json.sh"

if ! fields="$(hook_read_fields)"; then
	echo "guard-protected-files: cannot read the hook payload (no bun, node, or jq on PATH, or malformed JSON). Refusing the call rather than allowing it unchecked. Install bun in this environment." >&2
	exit 2
fi

tool="$(printf '%s' "$fields" | sed -n '1p')"
file="$(printf '%s' "$fields" | sed -n '2p')"
cmd="$(printf '%s' "$fields" | sed -n '3p')"

unattended=0
[ "${FLUNCLE_UNATTENDED:-}" = "1" ] && unattended=1

deny() {
	echo "$1" >&2
	exit 2
}

MSG_DRIZZLE="Refusing to hand-edit a Drizzle migration. Migrations are generated: edit apps/web/src/db/schema.ts, then run \`bun run --cwd apps/web db:generate\` (AGENTS.md: NEVER write SQL migrations by hand)."
MSG_ENV="Refusing to touch an env/secret file. Fluncle secrets live in 1Password and Cloudflare Worker secrets, not in the repo."
MSG_CI="Refusing to touch CI/workflow config in an unattended run. Every sweep prompt lists .github/workflows/* as a hard rail; a workflow edit runs arbitrary code with repo secrets. File it instead."
MSG_SELF="Refusing to touch .claude/** in an unattended run. That is the guard this run is executing under; a sweep does not get to edit its own rails. File it instead."
MSG_AUTH="Refusing to touch the auth-tier guards in an unattended run. Every sweep prompt lists adminAuth/operatorGuard and the publish boundary as a hard rail. File it instead."

check_path() {
	local p="$1"
	case "$p" in
	*/apps/web/drizzle/*.sql | apps/web/drizzle/*.sql | */apps/web/drizzle/meta/* | apps/web/drizzle/meta/*)
		deny "${MSG_DRIZZLE} ($p)"
		;;
	*/.env | */.env.* | .env | .env.* | */.dev.vars | */.dev.vars.* | .dev.vars | .dev.vars.*)
		deny "${MSG_ENV} ($p)"
		;;
	esac
	[ "$unattended" = "1" ] || return 0
	case "$p" in
	*/.github/workflows/* | .github/workflows/*) deny "${MSG_CI} ($p)" ;;
	*/.claude/* | .claude/*) deny "${MSG_SELF} ($p)" ;;
	*/lib/server/orpc-auth.ts) deny "${MSG_AUTH} ($p)" ;;
	esac
}

case "$tool" in
Edit | Write | NotebookEdit)
	[ -n "$file" ] && check_path "$file"
	;;
Bash)
	[ -n "$cmd" ] || exit 0

	protected_re='(^|[^[:alnum:]_-])(\.env|\.dev\.vars)([^[:alnum:]_.-]|$)|apps/web/drizzle/'

	write_re='(>)|(^|[^[:alnum:]_-])(tee|cp|mv|install|dd|truncate|rm)([^[:alnum:]_-]|$)|(^|[^[:alnum:]_-])sed([^|]*)-i'
	if [[ $cmd =~ $protected_re ]]; then
		if [ "$unattended" = "1" ]; then
			deny "${MSG_ENV} / ${MSG_DRIZZLE} — refused via Bash in an unattended run."
		elif [[ $cmd =~ $write_re ]]; then
			deny "${MSG_ENV} / ${MSG_DRIZZLE} — refused: this Bash command writes to a protected path."
		fi
	fi
	if [ "$unattended" = "1" ]; then
		[[ $cmd =~ \.github/workflows/ ]] && deny "${MSG_CI}"
		[[ $cmd =~ (^|[^[:alnum:]_-])\.claude/ ]] && deny "${MSG_SELF}"
		[[ $cmd =~ orpc-auth\.ts ]] && deny "${MSG_AUTH}"
	fi
	;;
esac

exit 0
