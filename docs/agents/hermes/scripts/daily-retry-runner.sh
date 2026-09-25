#!/usr/bin/env bash

set -uo pipefail

job="${1:-}"
time_zone="${2:-}"
primary_slot="${3:-}"
final_slot="${4:-}"
shift 4 || true
if [ "${1:-}" = "--" ]; then
	shift
fi
if [ -z "$job" ] || [ -z "$time_zone" ] || [[ ! "$primary_slot" =~ ^[0-2][0-9]:[0-5][0-9]$ ]] || [[ ! "$final_slot" =~ ^[0-2][0-9]:[0-5][0-9]$ ]] || [ "$#" -eq 0 ]; then
	echo 'usage: daily-retry-runner.sh fluncle-<job> <timezone> <primary-hour:minute> <final-hour:minute> -- <command> [args...]' >&2
	exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bun_bin="${BUN_BIN:-/usr/local/bin/bun}"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
local_time="$(TZ="$time_zone" date +%H%M)"
local_day="$(TZ="$time_zone" date +%Y%m%d)"
marker_dir="${HEALTHCHECK_CRON_OUTPUT_DIR:-$(dirname -- "${HOME:-/opt/data/home}")/cron/output}/${job}"
shopt -s nullglob
marker_snapshot() {
	local markers=("$marker_dir"/*.md)
	printf '%s\n' "${markers[@]}"
}
state="$("$bun_bin" "${script_dir}/daily-retry-state.ts" "$job" "$time_zone" "$primary_slot" "$started_at")" || exit 2
initial_state="$state"

if [ "$state" = "exhausted" ]; then
	echo "${job}: today's retry attempts are exhausted"
	exit 0
fi
if [ "$state" = "complete" ] || [ "$state" = "started" ]; then
	echo "${job}: today's payload already ran (${state})"
	exit 0
fi
if { [ "$state" = "skipped" ] || [ "$state" = "partial" ]; } && [[ "$local_time" < "${final_slot/:/}" ]]; then
	echo "${job}: today's retry slot is still pending"
	exit 0
fi

before_markers="$(marker_snapshot)"
set -m
FLUNCLE_DAILY_RETRY=1 "$@" &
child_pid="$!"
terminate_payload() {
	trap - TERM INT HUP
	kill -TERM -- "-$child_pid" 2>/dev/null || true
	(sleep 5; kill -KILL -- "-$child_pid" 2>/dev/null || true) &
	killer_pid="$!"
	wait "$child_pid" 2>/dev/null || true
	sleep 0.2
	kill "$killer_pid" 2>/dev/null || true
	wait "$killer_pid" 2>/dev/null || true
	kill -KILL -- "-$child_pid" 2>/dev/null || true
	exit 143
}
trap terminate_payload TERM INT HUP
wait "$child_pid"
payload_rc="$?"
trap - TERM INT HUP

state="$("$bun_bin" "${script_dir}/daily-retry-state.ts" "$job" "$time_zone" "$primary_slot" "$started_at")" || exit 2
after_markers="$(marker_snapshot)"
if [ "$state" = "complete" ]; then
	exit 0
fi
if [ "$state" = "started" ]; then
	exit "$payload_rc"
fi

rebake_lock="$(dirname -- "${HOME:-/opt/data/home}")/rebake.lock"
rebake_active=false
if [ -f "$rebake_lock" ] && [ -z "$(find "$rebake_lock" -mmin +45 2>/dev/null)" ]; then
	rebake_active=true
fi

if [ "$before_markers" = "$after_markers" ] && [ "$rebake_active" != true ]; then
	(
		CRON_OUTPUT_REBAKE_MARKER_ONLY=true
		export CRON_OUTPUT_REBAKE_MARKER_ONLY
		. "${script_dir}/cron-output.sh"
		emit_admission_skip_output "${job#fluncle-}" '{"checked":null,"errors":1,"gateState":"active","ok":false,"outcome":"payload-unconfirmed","payloadStarted":null,"produced":null}'
	) || true
	[ "$payload_rc" -ne 0 ] || payload_rc=75
	exit "$payload_rc"
fi

if [ "$state" = "exhausted" ]; then
	echo "${job}: today's two attempts are incomplete" >&2
	exit 75
fi

if [ "$payload_rc" -ne 0 ] && [ "$state" != "partial" ] && [ "$state" != "skipped" ]; then
	exit "$payload_rc"
fi

if [ "${FLUNCLE_DAILY_RETRY_STRADDLE_ATTEMPT:-0}" != "1" ]; then
	ended_time="$(TZ="$time_zone" date +%H%M)"
	ended_day="$(TZ="$time_zone" date +%Y%m%d)"
	if [ "$ended_day" = "$local_day" ] && [[ "$ended_time" < "${final_slot/:/}" ]]; then
		echo "${job}: today's payload remains incomplete; waiting for the retry slot" >&2
		exit 0
	fi
	if [ "$ended_day" = "$local_day" ] && { [ "$state" = "skipped" ] || [ "$state" = "partial" ]; } && [ "$before_markers" != "$after_markers" ] && { [[ "$local_time" < "${final_slot/:/}" ]] || [ "$initial_state" = "pending" ]; }; then
		jitter="${DAILY_RETRY_STRADDLE_JITTER_SECS:-$((5 + RANDOM % 26))}"
		case "$jitter" in
		'' | *[!0-9]*) echo 'DAILY_RETRY_STRADDLE_JITTER_SECS must be an integer from 0 to 30' >&2; exit 2 ;;
		esac
		if [ "$jitter" -gt 30 ]; then
			echo 'DAILY_RETRY_STRADDLE_JITTER_SECS must be an integer from 0 to 30' >&2
			exit 2
		fi
		echo "${job}: final calendar slot passed during the first attempt; retrying once after ${jitter}s" >&2
		sleep "$jitter"
		if [ "$(TZ="$time_zone" date +%Y%m%d)" = "$local_day" ]; then
			export FLUNCLE_DAILY_RETRY_STRADDLE_ATTEMPT=1
			exec bash "$0" "$job" "$time_zone" "$primary_slot" "$final_slot" -- "$@"
		fi
	fi
fi

echo "${job}: today's payload remains incomplete after the final retry" >&2
exit 75
