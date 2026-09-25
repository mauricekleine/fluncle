# shellcheck shell=bash

AGENT_PASS_BUDGET_SECS="${AGENT_PASS_BUDGET_SECS:-4800}"

AGENT_PASS_KILL_GRACE_SECS="${AGENT_PASS_KILL_GRACE_SECS:-60}"

AGENT_PASS_CGROUP_EVENTS="${AGENT_PASS_CGROUP_EVENTS:-/sys/fs/cgroup/memory.events}"

AGENT_PASS_STATUS=0
AGENT_PASS_REASON=""
AGENT_PASS_OOM_KILLS=0
AGENT_PASS_SECONDS=0

agent_pass_oom_counter() {
	[ -r "${AGENT_PASS_CGROUP_EVENTS}" ] || return 0
	local value
	value="$(sed -n 's/^oom_kill \([0-9][0-9]*\)$/\1/p' "${AGENT_PASS_CGROUP_EVENTS}" 2>/dev/null | head -n 1)"
	printf '%s' "${value}"
}

agent_pass_run() {
	local before after started ended
	before="$(agent_pass_oom_counter)"
	started="$(date -u +%s)"

	AGENT_PASS_REASON=""
	AGENT_PASS_OOM_KILLS=0

	local errexit_was_set=0
	case "$-" in *e*) errexit_was_set=1 ;; esac
	set +e
	timeout -k "${AGENT_PASS_KILL_GRACE_SECS}" "${AGENT_PASS_BUDGET_SECS}" "$@"
	AGENT_PASS_STATUS=$?
	[ "${errexit_was_set}" = "0" ] || set -e

	ended="$(date -u +%s)"
	AGENT_PASS_SECONDS=$((ended - started))
	after="$(agent_pass_oom_counter)"
	if [ -n "${before}" ] && [ -n "${after}" ] && [ "${after}" -gt "${before}" ]; then
		AGENT_PASS_OOM_KILLS=$((after - before))
	fi

	if [ "${AGENT_PASS_STATUS}" = "124" ] || [ "${AGENT_PASS_STATUS}" = "137" ]; then
		AGENT_PASS_REASON="budget-exceeded"
	elif [ "${AGENT_PASS_OOM_KILLS}" != "0" ]; then

		AGENT_PASS_REASON="oom-killed"
	elif [ "${AGENT_PASS_STATUS}" != "0" ]; then
		AGENT_PASS_REASON="nonzero-exit"
	fi
	return 0
}
