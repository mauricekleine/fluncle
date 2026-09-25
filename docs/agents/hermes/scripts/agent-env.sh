#!/usr/bin/env bash

AGENT_ENV_ALWAYS_ALLOW="CLAUDE_CODE_OAUTH_TOKEN"

agent_env_scrub_args() {
	local secrets_file=""
	local allow=" ${AGENT_ENV_ALWAYS_ALLOW} "
	local extra=""
	local key kept=""

	while [ $# -gt 0 ]; do
		case "$1" in
		--secrets)
			secrets_file="${2:-}"
			shift 2
			;;
		--allow)
			allow="${allow}${2:-} "
			shift 2
			;;
		--scrub)
			extra="${extra}${2:-} "
			shift 2
			;;
		*)
			echo "[agent-env] ignoring unknown argument: $1" >&2
			shift
			;;
		esac
	done

	AGENT_ENV_SCRUB=()
	local scrubbed=""

	for key in ${extra}; do
		AGENT_ENV_SCRUB+=(-u "${key}")
		scrubbed="${scrubbed}${key} "
	done

	if [ -n "${secrets_file}" ] && [ -r "${secrets_file}" ]; then

		while IFS= read -r key; do
			case "${allow}" in
			*" ${key} "*)
				kept="${kept}${key} "
				continue
				;;
			esac
			AGENT_ENV_SCRUB+=(-u "${key}")
			scrubbed="${scrubbed}${key} "
		done < <(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)=.*/\2/p' "${secrets_file}")
	fi

	echo "[agent-env] kept: ${kept:-<none>}| scrubbed: ${scrubbed:-<none>}" >&2
}
