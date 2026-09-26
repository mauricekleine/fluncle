#!/usr/bin/env bash

set -uo pipefail

ADMISSION_PATH='/api/v1/admin/database-admission'

PHASE_YIELD_EXIT=75

phase_scoped=false
if [ "${1:-}" = "phase" ]; then
	phase_scoped=true
	shift
fi
owner="${1:-}"
shift || true
if [ "${1:-}" = "--" ]; then
	shift
fi
if [ -z "$owner" ] || [ "$#" -eq 0 ]; then
	echo 'usage: database-admission-runner.sh [phase] <registry-owner> -- <command> [args...]' >&2
	exit 2
fi
case "$owner" in *[!a-z0-9.-]* | '')
	echo "invalid database admission owner" >&2
	exit 2
	;;
esac

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [ -r "${HOME:-/nonexistent}/.fluncle-secrets.env" ]; then
	# shellcheck disable=SC1091
	. "${HOME}/.fluncle-secrets.env"
fi

ADMISSION_MAX_WAIT_SECS="${DATABASE_ADMISSION_MAX_WAIT_SECS:-120}"
ADMISSION_POLL_SECS="${DATABASE_ADMISSION_POLL_SECS-2}"
ADMISSION_HTTP_TIMEOUT_SECS="${DATABASE_ADMISSION_HTTP_TIMEOUT_SECS:-10}"
ADMISSION_KILL_GRACE_SECS="${DATABASE_ADMISSION_KILL_GRACE_SECS:-10}"
ADMISSION_FAIL_CLOSED="${DATABASE_ADMISSION_FAIL_CLOSED:-false}"

bounded_uint() {
	local name="$1" value="$2" minimum="$3" maximum="$4"
	case "$value" in *[!0-9]* | '')
		echo "${name} must be an integer" >&2
		exit 2
		;;
	esac
	if [ "$value" -lt "$minimum" ] || [ "$value" -gt "$maximum" ]; then
		echo "${name} must be between ${minimum} and ${maximum}" >&2
		exit 2
	fi
}
bounded_uint DATABASE_ADMISSION_MAX_WAIT_SECS "$ADMISSION_MAX_WAIT_SECS" 0 120
case "$ADMISSION_POLL_SECS" in
*[!0-9]* | '' | 0)
	echo "DATABASE_ADMISSION_POLL_SECS must be a positive integer between 1 and 30" >&2
	exit 2
	;;
esac
bounded_uint DATABASE_ADMISSION_POLL_SECS "$ADMISSION_POLL_SECS" 1 30
bounded_uint DATABASE_ADMISSION_HTTP_TIMEOUT_SECS "$ADMISSION_HTTP_TIMEOUT_SECS" 1 30
bounded_uint DATABASE_ADMISSION_KILL_GRACE_SECS "$ADMISSION_KILL_GRACE_SECS" 0 10
[ "$ADMISSION_FAIL_CLOSED" = "true" ] || ADMISSION_FAIL_CLOSED=false

current_time_ms() {
	local timestamp seconds
	timestamp="$(date +%s%3N)"
	case "$timestamp" in
	'' | *[!0-9]*)
		if command -v perl >/dev/null 2>&1; then
			perl -MTime::HiRes=time -e 'printf "%.0f", time() * 1000'
		else
			seconds="$(date +%s)"
			printf '%s000' "$seconds"
		fi
		;;
	*) printf '%s' "$timestamp" ;;
	esac
}

api_base="${FLUNCLE_API_BASE_URL-https://www.fluncle.com}"
api_base="${api_base%/}"
api_token="${FLUNCLE_API_TOKEN:-}"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM:-0}"
started_seconds="$SECONDS"
started_at_ms="$(current_time_ms)"
acquisition_deadline_ms=$((started_at_ms + ADMISSION_MAX_WAIT_SECS * 1000))
enforced=0
enforcement_mode=false
fencing_token=""
contender_id="${owner}:${run_id}"
lane=""
heavy_read=false
operation_id=""
queue_age_ms=0
wait_ms=0
yield_reason=""
last_wait_yield_reason=""
recovered=false
payload_pid=""
terminal_action_started=0
admission_transport_failed=false
ADMISSION_RESPONSE=""
ADMISSION_RESPONSE_CODE=""
ADMISSION_ERROR_REASON="coordinator-unavailable"
watchdog_directory=""
watchdog_state=""
watchdog_window_ms=$(((90 - ADMISSION_KILL_GRACE_SECS - 5) * 1000))

emit_admission_skip() {
	local outcome="$1" skip_yield_reason="$2" summary job errors=0
	case "$owner" in
	fluncle-*) job="${owner#fluncle-}" ;;
	*) return 0 ;;
	esac
	skip_yield_reason="$(safe_admission_yield_reason "$skip_yield_reason")"
	if [ "${FLUNCLE_DAILY_RETRY:-0}" = "1" ]; then
		errors=1
	fi

	summary="$(printf '{"admissionOutcome":"%s","admissionWaitMs":%s,"admissionYieldReason":"%s","checked":null,"errors":%s,"expectedIntervalMs":null,"gateState":"admission-skipped","payloadStarted":false,"produced":null,"queueDepth":null}' \
		"$outcome" "$wait_ms" "$skip_yield_reason" "$errors")"

	(
		CRON_OUTPUT_REBAKE_MARKER_ONLY=true
		export CRON_OUTPUT_REBAKE_MARKER_ONLY
		# shellcheck source=./cron-output.sh
		. "${SCRIPT_DIR}/cron-output.sh"
		emit_admission_skip_output "$job" "$summary"
	) || true
}

safe_admission_yield_reason() {
	case "$1" in
	authentication-failed | containment-unavailable | coordinator-unavailable | database-busy | database-health | direct-read-latency | enforcement-not-active | gateway-transport | heartbeat-deadline | invalid-grant | public-latency | queue)
		printf '%s' "$1"
		;;
	*) printf '%s' 'queue' ;;
	esac
}

json_field() {
	local json="$1" field="$2"
	printf '%s' "$json" | sed -n "s/.*\"${field}\":[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

json_number() {
	local json="$1" field="$2"
	printf '%s' "$json" | sed -n "s/.*\"${field}\":[[:space:]]*\([0-9][0-9]*\).*/\1/p"
}

json_boolean() {
	local json="$1" field="$2"
	local value
	value="$(printf '%s' "$json" | sed -n "s/.*\"${field}\":[[:space:]]*\([a-z][a-z]*\).*/\1/p")"
	case "$value" in true | false) printf '%s' "$value" ;; esac
}

admission_post() {
	local action="$1" token="${2:-}" request_timeout="${3:-$ADMISSION_HTTP_TIMEOUT_SECS}" body curl_status response response_code response_with_code
	ADMISSION_RESPONSE=""
	ADMISSION_RESPONSE_CODE=""
	ADMISSION_ERROR_REASON="coordinator-unavailable"
	admission_transport_failed=false
	[ -n "$api_base" ] || return 1
	[ -n "$api_token" ] || return 1
	command -v curl >/dev/null 2>&1 || return 1
	body="{\"action\":\"${action}\",\"owner\":\"${owner}\",\"runId\":\"${run_id}\""
	if [ -n "$token" ]; then
		body="${body},\"fencingToken\":${token}"
	fi
	body="${body}}"
	response_with_code="$(curl -sS --max-time "$request_timeout" -w '\n%{http_code}' \
		-X POST -H 'Content-Type: application/json' \
		-H "Authorization: Bearer ${api_token}" \
		--data-binary "$body" "${api_base}${ADMISSION_PATH}" 2>/dev/null)"
	curl_status=$?
	if [ "$curl_status" -ne 0 ]; then
		admission_transport_failed=true
		return 1
	fi
	response_code="${response_with_code##*$'\n'}"
	case "$response_code" in
	[0-9][0-9][0-9]) response="${response_with_code%$'\n'*}" ;;
	*)

		response_code=200
		response="$response_with_code"
		;;
	esac
	ADMISSION_RESPONSE="$response"
	ADMISSION_RESPONSE_CODE="$response_code"
	case "$response_code" in
	2??) return 0 ;;
	esac
	if [ "$(json_field "$response" code)" = "database_busy" ]; then
		ADMISSION_ERROR_REASON="database-busy"
	else
		case "$response_code" in
		401) ADMISSION_ERROR_REASON="authentication-failed" ;;
		502 | 503 | 504 | 520 | 522 | 525) ADMISSION_ERROR_REASON="gateway-transport" ;;
		*) ADMISSION_ERROR_REASON="coordinator-unavailable" ;;
		esac
	fi
	return 1
}

transient_admission_failure() {
	if [ "$admission_transport_failed" = "true" ]; then
		return 0
	fi
	case "$ADMISSION_RESPONSE_CODE" in
	5??) return 0 ;;
	esac
	return 1
}

admission_failure_outcome() {
	case "$1" in
	authentication-failed) printf '%s' 'acquisition-authentication-failed' ;;
	database-busy) printf '%s' 'acquisition-database-busy' ;;
	gateway-transport) printf '%s' 'acquisition-gateway-transport' ;;
	*) printf '%s' 'acquisition-unavailable' ;;
	esac
}

TERMINAL_ADMISSION_ATTEMPTS=3

terminal_admission() {
	local token action attempt
	[ "$terminal_action_started" -eq 0 ] || return 0
	terminal_action_started=1
	token="$fencing_token"
	fencing_token=""
	action=cancel
	[ -z "$token" ] || action=release
	for ((attempt = 1; attempt <= TERMINAL_ADMISSION_ATTEMPTS; attempt += 1)); do
		admission_post "$action" "$token" && return 0
		transient_admission_failure || return 0
		[ "$attempt" -lt "$TERMINAL_ADMISSION_ATTEMPTS" ] && sleep "$ADMISSION_POLL_SECS"
	done
	return 0
}

emit_admission_event() {
	local outcome="$1" hold_ms="$2"
	printf '{"event":"database.admission.runner","access_class":"%s","contender":"%s","enforced":%s,"heavy_read":%s,"hold_ms":%s,"operation_id":"%s","outcome":"%s","owner":"%s","phase_scoped":%s,"queue_age_ms":%s,"recovered":%s,"run_id":"%s","wait_ms":%s,"yield_reason":"%s"}\n' \
		"$lane" "$contender_id" "$enforcement_mode" "$heavy_read" "$hold_ms" "$operation_id" \
		"$outcome" "$owner" "$phase_scoped" "$queue_age_ms" "$recovered" "$run_id" "$wait_ms" "$yield_reason" >&2
}

exit_admission_yield() {
	local outcome="$1" reason="$2"
	yield_reason="$reason"
	emit_admission_event "$outcome" 0
	if [ "$phase_scoped" = "true" ]; then
		exit "$PHASE_YIELD_EXIT"
	fi
	emit_admission_skip "$outcome" "$yield_reason"
	exit 0
}

exit_wait_expired() {
	local reason="$1" now_ms
	now_ms="$(current_time_ms)"
	wait_ms=$((now_ms - started_at_ms))
	yield_reason="$reason"
	terminal_admission
	exit_admission_yield wait-expired "$yield_reason"
}

duration_ms_as_seconds() {
	local duration_ms="$1"
	printf '%d.%03d' "$((duration_ms / 1000))" "$((duration_ms % 1000))"
}

acquisition_request_timeout() {
	local now_ms remaining_ms configured_ms
	now_ms="$(current_time_ms)"
	remaining_ms=$((acquisition_deadline_ms - now_ms))
	configured_ms=$((ADMISSION_HTTP_TIMEOUT_SECS * 1000))
	[ "$remaining_ms" -gt 0 ] || remaining_ms=1
	[ "$remaining_ms" -lt "$configured_ms" ] || remaining_ms="$configured_ms"
	duration_ms_as_seconds "$remaining_ms"
}

stop_payload() {
	[ -n "$payload_pid" ] || return 0

	payload_group_is_alive || return 0
	kill -TERM -- "-${payload_pid}" 2>/dev/null || kill -TERM "$payload_pid" 2>/dev/null || true
	local deadline=$((SECONDS + ADMISSION_KILL_GRACE_SECS))
	while payload_group_is_alive && [ "$SECONDS" -lt "$deadline" ]; do
		sleep 0.1
	done
	if payload_group_is_alive; then
		kill -KILL -- "-${payload_pid}" 2>/dev/null || kill -KILL "$payload_pid" 2>/dev/null || true
		sleep 0.1
	fi
}

cleanup_watchdog() {
	[ -n "$watchdog_directory" ] || return 0
	rm -f -- "$watchdog_state"
	rmdir -- "$watchdog_directory" 2>/dev/null || true
	watchdog_directory=""
	watchdog_state=""
}

refresh_watchdog_deadline() {
	local deadline temporary
	[ -n "$watchdog_state" ] || return 1
	deadline=$(($(current_time_ms) + watchdog_window_ms))
	temporary="${watchdog_state}.new"
	printf '%s\n' "$deadline" >"$temporary" || return 1
	mv -f -- "$temporary" "$watchdog_state"
}

watchdog_deadline_passed() {
	local deadline
	[ -r "$watchdog_state" ] || return 0
	deadline="$(sed -n '1p' "$watchdog_state" 2>/dev/null)"
	case "$deadline" in
	'' | *[!0-9]*) return 0 ;;
	esac
	[ "$(current_time_ms)" -ge "$deadline" ]
}

payload_group_is_alive() {
	[ -n "$payload_pid" ] || return 1
	kill -0 -- "-${payload_pid}" 2>/dev/null
}

payload_is_running() {
	local running_pid
	[ -n "$payload_pid" ] || return 1
	for running_pid in $(jobs -pr); do
		[ "$running_pid" = "$payload_pid" ] && return 0
	done
	return 1
}

# shellcheck disable=SC2329
on_signal() {
	stop_payload
	terminal_admission
	cleanup_watchdog
	emit_admission_event cancelled "$(((SECONDS - started_seconds) * 1000))"
	exit 143
}
trap on_signal TERM INT HUP

while :; do
	if [ "$enforced" -eq 1 ] && [ "$(current_time_ms)" -ge "$acquisition_deadline_ms" ]; then
		exit_wait_expired "${last_wait_yield_reason:-queue}"
	fi
	if ! admission_post acquire "" "$(acquisition_request_timeout)"; then

		case "$ADMISSION_ERROR_REASON" in
		coordinator-unavailable | gateway-transport)
			if [ "$enforced" -eq 0 ] && [ "$ADMISSION_FAIL_CLOSED" != "true" ]; then
				emit_admission_event shadow-unavailable 0
				exec "$@"
			fi
			;;
		esac

		if [ "$ADMISSION_ERROR_REASON" != "database-busy" ] && transient_admission_failure; then
			now_ms="$(current_time_ms)"
			if [ "$now_ms" -ge "$acquisition_deadline_ms" ]; then

				if [ "$enforced" -eq 1 ] && [ -n "$last_wait_yield_reason" ]; then
					exit_wait_expired "$last_wait_yield_reason"
				fi
				wait_ms=$((now_ms - started_at_ms))
				yield_reason="$ADMISSION_ERROR_REASON"
				terminal_admission
				failure_outcome="$(admission_failure_outcome "$yield_reason")"
				exit_admission_yield "$failure_outcome" "$yield_reason"
			fi
			yield_reason="$ADMISSION_ERROR_REASON"
			emit_admission_event acquire-retry 0
			remaining_ms=$((acquisition_deadline_ms - now_ms))
			poll_ms=$((ADMISSION_POLL_SECS * 1000))
			[ "$poll_ms" -lt "$remaining_ms" ] || poll_ms="$remaining_ms"
			sleep "$(duration_ms_as_seconds "$poll_ms")"
			continue
		fi
		yield_reason="$ADMISSION_ERROR_REASON"
		terminal_admission
		failure_outcome="$(admission_failure_outcome "$yield_reason")"
		exit_admission_yield "$failure_outcome" "$yield_reason"
	fi

	response="$ADMISSION_RESPONSE"
	response_enforced="$(json_boolean "$response" enforced)"
	outcome="$(json_field "$response" outcome)"
	lane="$(json_field "$response" lane)"
	heavy_read="$(json_boolean "$response" heavyRead)"
	operation_id="$(json_field "$response" operationId)"
	contender_id="$(json_field "$response" contenderId)"
	queue_age_ms="$(json_number "$response" queueAgeMs)"
	wait_ms="$(json_number "$response" waitMs)"
	recovered="$(json_boolean "$response" recovered)"
	yield_reason="$(json_field "$response" yieldReason)"
	queue_age_ms="${queue_age_ms:-0}"
	wait_ms="${wait_ms:-0}"
	recovered="${recovered:-false}"
	heavy_read="${heavy_read:-false}"

	if [ "$response_enforced" != "true" ]; then
		if [ "$ADMISSION_FAIL_CLOSED" = "true" ] || [ "$enforced" -eq 1 ]; then
			yield_reason="enforcement-not-active"
			terminal_admission
			exit_admission_yield enforcement-not-active "$yield_reason"
		fi
		emit_admission_event shadow 0
		exec "$@"
	fi
	enforced=1
	enforcement_mode=true

	if [ "$outcome" = "acquired" ]; then
		fencing_token="$(json_number "$response" fencingToken)"
		heartbeat_after_ms="$(json_number "$response" heartbeatAfterMs)"
		if [ -z "$fencing_token" ] || [ -z "$heartbeat_after_ms" ]; then
			terminal_admission
			exit_admission_yield invalid-grant "invalid-grant"
		fi
		if [ "$(current_time_ms)" -ge "$acquisition_deadline_ms" ]; then
			exit_wait_expired "${last_wait_yield_reason:-queue}"
		fi
		break
	fi

	last_wait_yield_reason="$(safe_admission_yield_reason "${yield_reason:-queue}")"

	remaining_ms=$((acquisition_deadline_ms - $(current_time_ms)))
	if [ "$remaining_ms" -le 0 ]; then
		exit_wait_expired "$last_wait_yield_reason"
	fi
	poll_ms=$((ADMISSION_POLL_SECS * 1000))
	[ "$poll_ms" -lt "$remaining_ms" ] || poll_ms="$remaining_ms"
	if [ "$poll_ms" -gt 0 ]; then
		sleep "$(duration_ms_as_seconds "$poll_ms")"
	fi
done

if ! command -v setsid >/dev/null 2>&1; then
	terminal_admission
	yield_reason="containment-unavailable"
	exit_admission_yield containment-unavailable "$yield_reason"
fi
watchdog_directory="$(mktemp -d "${TMPDIR:-/tmp}/fluncle-database-admission.XXXXXX")" || {
	terminal_admission
	yield_reason="containment-unavailable"
	exit_admission_yield containment-unavailable "$yield_reason"
}
watchdog_state="${watchdog_directory}/heartbeat-deadline-ms"
if ! refresh_watchdog_deadline; then
	terminal_admission
	cleanup_watchdog
	yield_reason="containment-unavailable"
	exit_admission_yield containment-unavailable "$yield_reason"
fi
pdeathsig_available=false
if command -v setpriv >/dev/null 2>&1 && setpriv --pdeathsig TERM true >/dev/null 2>&1; then
	pdeathsig_available=true
fi
owner_pid="$$"

# shellcheck disable=SC2016
payload_supervisor_source='
  set -uo pipefail
  expected_parent="$1"
  kill_grace="$2"
  heartbeat_deadline_file="$3"
  shift 3
  [ "$PPID" = "$expected_parent" ] || exit 75
  supervisor_pid="$$"
  watchdog_now_ms() {
    local now
    now="$(date +%s%3N)"
    case "$now" in
      *[!0-9]* | "") now="$(perl -MTime::HiRes=time -e '\''printf "%.0f", time() * 1000'\'')" ;;
    esac
    printf "%s" "$now"
  }
  on_parent_loss() {
    trap "" TERM INT HUP
    kill -TERM -- "-$$" 2>/dev/null || true
    sleep "$kill_grace"
    kill -KILL -- "-$$" 2>/dev/null || true
  }
  trap on_parent_loss TERM INT HUP
  initial_deadline="$(sed -n "1p" "$heartbeat_deadline_file" 2>/dev/null)"
  case "$initial_deadline" in
    *[!0-9]* | "") exit 75 ;;
  esac
  if [ "$(watchdog_now_ms)" -ge "$initial_deadline" ]; then
    printf "%s\n" expired > "$heartbeat_deadline_file"
    exit 75
  fi
  FLUNCLE_ADMISSION_RUNNER_PID="$expected_parent" "$@" &
  child_pid="$!"
  (
    while kill -0 "$child_pid" 2>/dev/null; do
      if ! kill -0 "$expected_parent" 2>/dev/null; then
        kill -TERM "$supervisor_pid" 2>/dev/null || true
        exit 0
      fi
      deadline="$(sed -n "1p" "$heartbeat_deadline_file" 2>/dev/null)"
      case "$deadline" in
        *[!0-9]* | "")
          kill -TERM "$supervisor_pid" 2>/dev/null || true
          exit 0
          ;;
      esac
      now="$(watchdog_now_ms)"
      if [ "$now" -ge "$deadline" ]; then
        printf "%s\n" expired > "$heartbeat_deadline_file"
        kill -TERM "$supervisor_pid" 2>/dev/null || true
        exit 0
      fi
      sleep 0.1
    done
  ) &
  watchdog_pid="$!"
  wait "$child_pid"
  child_rc="$?"
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  trap - TERM INT HUP
  exit "$child_rc"
'
if [ "$pdeathsig_available" = true ]; then
	setsid setpriv --pdeathsig TERM bash -c "$payload_supervisor_source" \
		database-admission-payload "$owner_pid" "$ADMISSION_KILL_GRACE_SECS" "$watchdog_state" "$@" &
else
	setsid bash -c "$payload_supervisor_source" \
		database-admission-payload "$owner_pid" "$ADMISSION_KILL_GRACE_SECS" "$watchdog_state" "$@" &
fi
payload_pid="$!"
payload_started_seconds="$SECONDS"
heartbeat_seconds=$(((heartbeat_after_ms + 999) / 1000))
[ "$heartbeat_seconds" -gt 0 ] || heartbeat_seconds=1
next_heartbeat=$((SECONDS + heartbeat_seconds))
fence_lost=0

while payload_is_running; do
	if [ "$SECONDS" -ge "$next_heartbeat" ]; then
		if ! admission_post heartbeat "$fencing_token"; then

			if transient_admission_failure && ! watchdog_deadline_passed; then
				yield_reason="$ADMISSION_ERROR_REASON"
				emit_admission_event heartbeat-retry "$(((SECONDS - payload_started_seconds) * 1000))"
				next_heartbeat=$((SECONDS + ADMISSION_POLL_SECS))
				sleep 1
				continue
			fi
			fence_lost=1
			if watchdog_deadline_passed; then
				yield_reason="heartbeat-deadline"
			else
				yield_reason="partition"
			fi
			break
		fi
		response="$ADMISSION_RESPONSE"
		if [ "$(json_boolean "$response" enforced)" != "true" ]; then
			fence_lost=1
			yield_reason="enforcement-not-active"
			break
		fi
		if [ "$(json_field "$response" outcome)" != "acquired" ]; then
			fence_lost=1
			yield_reason="$(json_field "$response" yieldReason)"
			break
		fi
		if ! refresh_watchdog_deadline; then
			fence_lost=1
			yield_reason="heartbeat-deadline"
			break
		fi

		yield_reason=""
		next_heartbeat=$((SECONDS + heartbeat_seconds))
	fi
	sleep 1
done

if [ -r "$watchdog_state" ] && [ "$(sed -n '1p' "$watchdog_state")" = "expired" ]; then
	fence_lost=1
	yield_reason="heartbeat-deadline"
fi

if [ "$fence_lost" -eq 1 ]; then
	stop_payload
fi

set +e
wait "$payload_pid" 2>/dev/null
payload_rc="$?"
set -e
stop_payload
hold_ms="$(((SECONDS - payload_started_seconds) * 1000))"

if [ "$enforced" -eq 1 ]; then
	terminal_admission
fi
cleanup_watchdog
if [ "$fence_lost" -eq 1 ]; then
	emit_admission_event fenced "$hold_ms"
	exit 75
fi
emit_admission_event released "$hold_ms"
exit "$payload_rc"
