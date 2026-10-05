#!/usr/bin/env bash

set -uo pipefail

curl_config() {
	local key="$1" value="$2"
	value="${value//\\/\\\\}"
	value="${value//\"/\\\"}"
	value="${value//$'\n'/\\n}"
	value="${value//$'\r'/\\r}"
	value="${value//$'\t'/\\t}"
	printf '%s = "%s"\n' "$key" "$value"
}

ADMISSION_PATH='/api/v1/admin/database-admission'
ADMISSION_PROTOCOL_VERSION=2
LEGACY_LEASE_MS=90000
FALLBACK_HEARTBEAT_MS=30000
MIN_HEARTBEAT_MS=1000
HEARTBEAT_BACKOFF_CAP_MS=15000
TERMINAL_ADMISSION_ATTEMPTS=3
DEBT_FLUSH_LIMIT=4
DEBT_MAX_AGE_MS=1800000
DEBT_REQUEST_TIMEOUT_SECS=5

PHASE_YIELD_EXIT=75

phase_scoped=false
if [ "${1:-}" = "phase" ]; then
	phase_scoped=true
	shift
fi
owner="${1:-}"
shift || true
phase_name=""
if [ "$phase_scoped" = "true" ] && [ "${1:-}" = "--phase" ]; then
	shift
	phase_name="${1:-}"
	shift || true
	case "$phase_name" in *[!a-z0-9-]* | '')
		echo 'invalid database admission phase' >&2
		exit 2
		;;
	esac
fi
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
payload_command=("$@")

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [ -r "${HOME:-/nonexistent}/.fluncle-secrets.env" ]; then
	# shellcheck disable=SC1091
	. "${HOME}/.fluncle-secrets.env"
fi

ADMISSION_MAX_WAIT_SECS="${DATABASE_ADMISSION_MAX_WAIT_SECS:-120}"
ADMISSION_POLL_SECS="${DATABASE_ADMISSION_POLL_SECS-2}"
LOCAL_WAKE_MAX_SECS="${DATABASE_ADMISSION_LOCAL_WAKE_MAX_SECS-10}"
ADMISSION_HTTP_TIMEOUT_SECS="${DATABASE_ADMISSION_HTTP_TIMEOUT_SECS:-10}"
ADMISSION_KILL_GRACE_SECS="${DATABASE_ADMISSION_KILL_GRACE_SECS:-10}"
ADMISSION_FAIL_CLOSED="${DATABASE_ADMISSION_FAIL_CLOSED:-false}"
ADMISSION_BACKOFF_CAP_SECS="${DATABASE_ADMISSION_BACKOFF_CAP_SECS:-30}"
ADMISSION_STATE_DIR="${DATABASE_ADMISSION_STATE_DIR:-${HOME:-/tmp}/.database-admission}"
BREAKER_FAILURES="${DATABASE_ADMISSION_BREAKER_FAILURES:-4}"
BREAKER_WINDOW_SECS="${DATABASE_ADMISSION_BREAKER_WINDOW_SECS:-60}"
BREAKER_COOLDOWN_SECS="${DATABASE_ADMISSION_BREAKER_COOLDOWN_SECS:-60}"
BREAKER_MAX_COOLDOWN_SECS="${DATABASE_ADMISSION_BREAKER_MAX_COOLDOWN_SECS:-300}"

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
bounded_uint DATABASE_ADMISSION_LOCAL_WAKE_MAX_SECS "$LOCAL_WAKE_MAX_SECS" 1 15
LOCAL_WAKE_MAX_MS=$((LOCAL_WAKE_MAX_SECS * 1000))
bounded_uint DATABASE_ADMISSION_HTTP_TIMEOUT_SECS "$ADMISSION_HTTP_TIMEOUT_SECS" 1 30
bounded_uint DATABASE_ADMISSION_KILL_GRACE_SECS "$ADMISSION_KILL_GRACE_SECS" 0 10
bounded_uint DATABASE_ADMISSION_BACKOFF_CAP_SECS "$ADMISSION_BACKOFF_CAP_SECS" 1 300
bounded_uint DATABASE_ADMISSION_BREAKER_FAILURES "$BREAKER_FAILURES" 1 1000
bounded_uint DATABASE_ADMISSION_BREAKER_WINDOW_SECS "$BREAKER_WINDOW_SECS" 1 3600
bounded_uint DATABASE_ADMISSION_BREAKER_COOLDOWN_SECS "$BREAKER_COOLDOWN_SECS" 1 3600
bounded_uint DATABASE_ADMISSION_BREAKER_MAX_COOLDOWN_SECS "$BREAKER_MAX_COOLDOWN_SECS" "$BREAKER_COOLDOWN_SECS" 86400
[ "$ADMISSION_FAIL_CLOSED" = "true" ] || ADMISSION_FAIL_CLOSED=false

BREAKER_FILE="${ADMISSION_STATE_DIR}/breaker"
BREAKER_PROBE_FILE="${ADMISSION_STATE_DIR}/breaker-probe"
BREAKER_FAILURE_DIR="${ADMISSION_STATE_DIR}/failures"
DEBT_DIR="${ADMISSION_STATE_DIR}/pending"

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
supervision_sleeper_pid=""
payload_started_ms=""
terminal_action_started=0
acquire_attempted=false
coordinator_answered=false
admission_transport_failed=false
breaker_probe_held=false
probe_claim_id="$$.${RANDOM:-0}.${run_id}"
probe_claim_content=""
breaker_since=0
breaker_until=0
breaker_cooldown_ms=0
JITTER_MS=0
LEASE_DEADLINE_MS=0
ADMISSION_RESPONSE=""
ADMISSION_RESPONSE_CODE=""
ADMISSION_REQUEST_STARTED_MS=0
ADMISSION_ERROR_REASON="coordinator-unavailable"
watchdog_directory=""
watchdog_state=""
RELEASE_BEACON=""
write_beacon_before=""
heavy_read_beacon_before=""

random_below() {
	local limit="$1"
	if [ "$limit" -le 0 ]; then
		JITTER_MS=0
		return 0
	fi
	JITTER_MS=$(((RANDOM * 32768 + RANDOM) % limit))
}

full_jitter_ms() {
	local attempt="$1" cap_ms="$2" ceiling_ms step=1
	ceiling_ms=$((ADMISSION_POLL_SECS * 1000))
	while [ "$step" -lt "$attempt" ] && [ "$ceiling_ms" -lt "$cap_ms" ]; do
		ceiling_ms=$((ceiling_ms * 2))
		step=$((step + 1))
	done
	[ "$ceiling_ms" -le "$cap_ms" ] || ceiling_ms="$cap_ms"
	random_below "$((ceiling_ms + 1))"
}

equal_jitter_ms() {
	local base_ms="$1" half
	half=$((base_ms / 2))
	random_below "$((half + 1))"
	JITTER_MS=$((base_ms - half + JITTER_MS))
}

duration_ms_as_seconds() {
	local duration_ms="$1"
	printf '%d.%03d' "$((duration_ms / 1000))" "$((duration_ms % 1000))"
}

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
	authentication-failed | breaker-open | containment-unavailable | coordinator-unavailable | database-busy | database-health | direct-read-latency | enforcement-not-active | gateway-transport | heartbeat-deadline | invalid-grant | public-latency | queue | write-latency)
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

admission_state_ready() {
	mkdir -p -- "$BREAKER_FAILURE_DIR" "$DEBT_DIR" 2>/dev/null
}

local_beacons_ready() {
	mkdir -p -- "$ADMISSION_STATE_DIR" 2>/dev/null &&
		[ -r "$ADMISSION_STATE_DIR" ] && [ -w "$ADMISSION_STATE_DIR" ] && [ -x "$ADMISSION_STATE_DIR" ]
}

read_release_beacon() {
	RELEASE_BEACON=""
	read -r RELEASE_BEACON 2>/dev/null <"${ADMISSION_STATE_DIR}/released-$1" || true
}

snapshot_release_beacons() {
	read_release_beacon write
	write_beacon_before="$RELEASE_BEACON"
	read_release_beacon heavy-read
	heavy_read_beacon_before="$RELEASE_BEACON"
}

publish_release_beacons() (
	local resource temporary content
	local resources=()
	local_beacons_ready || return 0
	case "$lane" in
	write)
		resources+=(write)
		[ "$heavy_read" != true ] || resources+=(heavy-read)
		;;
	heavy-read) resources+=(heavy-read) ;;
	*) resources+=(write heavy-read) ;;
	esac
	umask 077
	content="$(current_time_ms) $run_id $$"
	for resource in "${resources[@]}"; do
		temporary="$(mktemp "${ADMISSION_STATE_DIR}/.released-${resource}.XXXXXX" 2>/dev/null)" || continue
		if ! { printf '%s\n' "$content" >"$temporary" && mv -f -- "$temporary" "${ADMISSION_STATE_DIR}/released-${resource}"; } 2>/dev/null; then
			rm -f -- "$temporary" 2>/dev/null || true
		fi
	done
	return 0
)

emit_breaker_event() {
	local state="$1"
	printf '{"event":"database.admission.breaker","cooldown_ms":%s,"owner":"%s","run_id":"%s","since_ms":%s,"state":"%s","until_ms":%s}\n' \
		"$breaker_cooldown_ms" "$owner" "$run_id" "$breaker_since" "$state" "$breaker_until" >&2
}

read_breaker() {
	local since until cooldown
	breaker_since=0
	breaker_until=0
	breaker_cooldown_ms=0
	[ -r "$BREAKER_FILE" ] || return 1
	read -r since until cooldown _ <"$BREAKER_FILE" || true
	case "${since:-x}${until:-x}${cooldown:-x}" in *[!0-9]*) return 1 ;; esac
	breaker_since="$since"
	breaker_until="$until"
	breaker_cooldown_ms="$cooldown"
	return 0
}

open_breaker() {
	local cooldown_ms="$1" now_ms since temporary
	admission_state_ready || return 0
	now_ms="$(current_time_ms)"
	since="$now_ms"
	if read_breaker; then
		since="$breaker_since"
	fi
	random_below "$((cooldown_ms / 2 + 1))"
	breaker_since="$since"
	breaker_until=$((now_ms + cooldown_ms + JITTER_MS))
	breaker_cooldown_ms="$cooldown_ms"
	temporary="${ADMISSION_STATE_DIR}/.breaker.$$"
	printf '%s %s %s\n' "$breaker_since" "$breaker_until" "$breaker_cooldown_ms" >"$temporary" &&
		mv -f -- "$temporary" "$BREAKER_FILE"
	emit_breaker_event open
}

take_probe_claim_if() {
	local expected="$1" moved="${ADMISSION_STATE_DIR}/.probe-taken.${probe_claim_id}" taken
	mv -- "$BREAKER_PROBE_FILE" "$moved" 2>/dev/null || return 1
	taken="$(cat -- "$moved" 2>/dev/null)"
	if [ "$taken" != "$expected" ]; then
		ln -- "$moved" "$BREAKER_PROBE_FILE" 2>/dev/null || true
		rm -f -- "$moved"
		return 1
	fi
	rm -f -- "$moved"
	return 0
}

release_breaker_probe() {
	[ "$breaker_probe_held" = true ] || return 0
	breaker_probe_held=false
	take_probe_claim_if "$probe_claim_content" || true
}

close_breaker() {
	read_breaker || true
	rm -f -- "$BREAKER_FILE"
	rm -f -- "$BREAKER_FAILURE_DIR"/* 2>/dev/null
	release_breaker_probe
	emit_breaker_event closed
}

breaker_note_failure() {
	local now_ms cutoff_ms entry stamp count=0 next_cooldown_ms
	admission_state_ready || return 0
	if [ "$breaker_probe_held" = true ]; then
		read_breaker || true
		next_cooldown_ms=$((breaker_cooldown_ms * 2))
		[ "$next_cooldown_ms" -ge $((BREAKER_COOLDOWN_SECS * 1000)) ] || next_cooldown_ms=$((BREAKER_COOLDOWN_SECS * 1000))
		[ "$next_cooldown_ms" -le $((BREAKER_MAX_COOLDOWN_SECS * 1000)) ] || next_cooldown_ms=$((BREAKER_MAX_COOLDOWN_SECS * 1000))
		open_breaker "$next_cooldown_ms"
		release_breaker_probe
		return 0
	fi
	now_ms="$(current_time_ms)"
	: >"${BREAKER_FAILURE_DIR}/${now_ms}.$$.${RANDOM}" 2>/dev/null || return 0
	cutoff_ms=$((now_ms - BREAKER_WINDOW_SECS * 1000))
	for entry in "$BREAKER_FAILURE_DIR"/*; do
		[ -e "$entry" ] || continue
		stamp="${entry##*/}"
		stamp="${stamp%%.*}"
		case "$stamp" in '' | *[!0-9]*)
			rm -f -- "$entry"
			continue
			;;
		esac
		if [ "$stamp" -lt "$cutoff_ms" ]; then
			rm -f -- "$entry"
			continue
		fi
		count=$((count + 1))
	done
	[ "$count" -ge "$BREAKER_FAILURES" ] || return 0
	if read_breaker; then
		[ "$now_ms" -ge "$breaker_until" ] || return 0
		open_breaker "$breaker_cooldown_ms"
		return 0
	fi
	open_breaker "$((BREAKER_COOLDOWN_SECS * 1000))"
}

breaker_note_answer() {
	[ "$breaker_probe_held" = true ] || return 0
	close_breaker
}

claim_breaker_probe() {
	local now_ms="$1" staged="${ADMISSION_STATE_DIR}/.probe-claim.${probe_claim_id}"
	printf '%s %s\n' "$now_ms" "$probe_claim_id" >"$staged" 2>/dev/null || return 1
	if ln -- "$staged" "$BREAKER_PROBE_FILE" 2>/dev/null; then
		probe_claim_content="$(cat -- "$staged")"
		rm -f -- "$staged"
		breaker_probe_held=true
		return 0
	fi
	rm -f -- "$staged"
	return 1
}

probe_claim_is_stale() {
	local claim="$1" now_ms="$2" started claimant
	read -r started claimant _ <<<"$claim"
	case "${started:-x}" in *[!0-9]*) return 0 ;; esac
	[ -n "${claimant:-}" ] || return 0
	[ "$((now_ms - started))" -gt $(((ADMISSION_HTTP_TIMEOUT_SECS + 5) * 1000)) ]
}

breaker_admits() {
	local now_ms claim
	[ "$breaker_probe_held" = false ] || return 0
	read_breaker || return 0
	now_ms="$(current_time_ms)"
	[ "$now_ms" -ge "$breaker_until" ] || return 1
	if claim_breaker_probe "$now_ms"; then
		emit_breaker_event half-open
		return 0
	fi
	claim="$(cat -- "$BREAKER_PROBE_FILE" 2>/dev/null)"
	probe_claim_is_stale "$claim" "$now_ms" || return 1
	take_probe_claim_if "$claim" || return 1
	if claim_breaker_probe "$now_ms"; then
		emit_breaker_event half-open
		return 0
	fi
	return 1
}

breaker_is_open() {
	read_breaker || return 1
	[ "$(current_time_ms)" -lt "$breaker_until" ]
}

admission_post() {
	local action="$1" token="${2:-}" request_timeout="${3:-$ADMISSION_HTTP_TIMEOUT_SECS}"
	local post_owner="${4:-$owner}" post_run_id="${5:-$run_id}"
	local body curl_status response response_code response_with_code
	ADMISSION_RESPONSE=""
	ADMISSION_RESPONSE_CODE=""
	ADMISSION_ERROR_REASON="coordinator-unavailable"
	admission_transport_failed=false
	[ -n "$api_base" ] || return 1
	[ -n "$api_token" ] || return 1
	command -v curl >/dev/null 2>&1 || return 1
	body="{\"action\":\"${action}\",\"owner\":\"${post_owner}\",\"protocolVersion\":${ADMISSION_PROTOCOL_VERSION},\"runId\":\"${post_run_id}\""
	if [ -n "$token" ]; then
		body="${body},\"fencingToken\":${token}"
	fi
	if [ "$action" = "acquire" ]; then
		body="${body},\"notAfterMs\":${acquisition_deadline_ms}"
	fi
	body="${body}}"
	ADMISSION_REQUEST_STARTED_MS="$(current_time_ms)"
	response_with_code="$(curl -sS --max-time "$request_timeout" -w '\n%{http_code}' \
		-X POST -H 'Content-Type: application/json' \
		--config - <<<"$(curl_config header "Authorization: Bearer ${api_token}")" \
		--data-binary "$body" "${api_base}${ADMISSION_PATH}" 2>/dev/null)"
	curl_status=$?
	if [ "$curl_status" -ne 0 ]; then
		admission_transport_failed=true
		ADMISSION_ERROR_REASON="gateway-transport"
		coordinator_answered=false
		breaker_note_failure
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
	2??)
		coordinator_answered=true
		breaker_note_answer
		return 0
		;;
	esac
	if [ "$(json_field "$response" code)" = "database_busy" ]; then
		ADMISSION_ERROR_REASON="database-busy"
	else
		case "$response_code" in
		401) ADMISSION_ERROR_REASON="authentication-failed" ;;
		502 | 503 | 504 | 520 | 522 | 524 | 525) ADMISSION_ERROR_REASON="gateway-transport" ;;
		*) ADMISSION_ERROR_REASON="coordinator-unavailable" ;;
		esac
	fi
	case "$response_code" in
	5??)
		if [ "$ADMISSION_ERROR_REASON" != "database-busy" ]; then
			coordinator_answered=false
			breaker_note_failure
			return 1
		fi
		;;
	esac
	coordinator_answered=true
	breaker_note_answer
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

record_admission_debt() {
	local action="$1" token="${2:-}" temporary
	admission_state_ready || return 0
	temporary="${DEBT_DIR}/.debt.$$"
	printf '%s %s %s\n' "$(current_time_ms)" "$owner" "${token:-0}" >"$temporary" &&
		mv -f -- "$temporary" "${DEBT_DIR}/${run_id}.${action}"
}

flush_admission_debts() {
	local file name debt_action debt_run_id created debt_owner debt_token flushed=0 now_ms
	[ "$coordinator_answered" = true ] || return 0
	breaker_is_open && return 0
	[ -d "$DEBT_DIR" ] || return 0
	now_ms="$(current_time_ms)"
	for file in "$DEBT_DIR"/*; do
		[ -f "$file" ] || continue
		[ "$flushed" -lt "$DEBT_FLUSH_LIMIT" ] || break
		name="${file##*/}"
		debt_action="${name##*.}"
		debt_run_id="${name%.*}"
		created=""
		debt_owner=""
		debt_token=""
		read -r created debt_owner debt_token _ <"$file" || true
		case "$debt_action" in release | cancel) ;; *)
			rm -f -- "$file"
			continue
			;;
		esac
		case "${created:-x}${debt_token:-x}" in *[!0-9]*)
			rm -f -- "$file"
			continue
			;;
		esac
		case "$debt_owner" in *[!a-z0-9.-]* | '')
			rm -f -- "$file"
			continue
			;;
		esac
		case "$debt_run_id" in *[!A-Za-z0-9._:-]* | '')
			rm -f -- "$file"
			continue
			;;
		esac
		if [ "$((now_ms - created))" -gt "$DEBT_MAX_AGE_MS" ]; then
			rm -f -- "$file"
			continue
		fi
		[ "$debt_action" = "release" ] || debt_token=""
		flushed=$((flushed + 1))
		if admission_post "$debt_action" "$debt_token" "$DEBT_REQUEST_TIMEOUT_SECS" "$debt_owner" "$debt_run_id"; then
			rm -f -- "$file"
			continue
		fi
		transient_admission_failure && break
		rm -f -- "$file"
	done
}

terminal_admission() {
	local token action attempt settled=false attempts="$TERMINAL_ADMISSION_ATTEMPTS"
	[ "$terminal_action_started" -eq 0 ] || return 0
	terminal_action_started=1
	token="$fencing_token"
	fencing_token=""
	[ "$acquire_attempted" = true ] || return 0
	action=cancel
	[ -z "$token" ] || action=release
	if breaker_is_open; then
		attempts=1
	fi
	for ((attempt = 1; attempt <= attempts; attempt += 1)); do
		if admission_post "$action" "$token" || ! transient_admission_failure; then
			settled=true
			break
		fi
		if [ "$attempt" -lt "$attempts" ]; then
			full_jitter_ms "$attempt" "$((ADMISSION_POLL_SECS * 2000))"
			sleep "$(duration_ms_as_seconds "$JITTER_MS")"
		fi
	done
	[ "$settled" = true ] || record_admission_debt "$action" "$token"
	publish_release_beacons || true
	return 0
}

emit_admission_event() {
	local outcome="$1" hold_ms="$2"
	printf '{"event":"database.admission.runner","access_class":"%s","contender":"%s","enforced":%s,"heavy_read":%s,"hold_ms":%s,"operation_id":"%s","outcome":"%s","owner":"%s","phase":"%s","phase_scoped":%s,"queue_age_ms":%s,"recovered":%s,"run_id":"%s","wait_ms":%s,"yield_reason":"%s"}\n' \
		"$lane" "$contender_id" "$enforcement_mode" "$heavy_read" "$hold_ms" "$operation_id" \
		"$outcome" "$owner" "$phase_name" "$phase_scoped" "$queue_age_ms" "$recovered" "$run_id" "$wait_ms" "$yield_reason" >&2
}

finish_admission_bookkeeping() {
	release_breaker_probe
	flush_admission_debts
}

exit_admission_yield() {
	local outcome="$1" reason="$2"
	yield_reason="$reason"
	emit_admission_event "$outcome" 0
	finish_admission_bookkeeping
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

run_payload_unadmitted() {
	local outcome="$1"
	emit_admission_event "$outcome" 0
	release_breaker_probe
	exec "${payload_command[@]}"
}

stand_aside_for_breaker() {
	if [ "$enforced" -eq 0 ] && [ "$ADMISSION_FAIL_CLOSED" != "true" ]; then
		yield_reason="breaker-open"
		run_payload_unadmitted shadow-unavailable
	fi
	if [ "$acquire_attempted" = true ]; then
		record_admission_debt cancel ""
	fi
	terminal_action_started=1
	wait_ms=$(($(current_time_ms) - started_at_ms))
	exit_admission_yield breaker-open breaker-open
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

sleep_within_acquisition() {
	local delay_ms="$1" remaining_ms
	remaining_ms=$((acquisition_deadline_ms - $(current_time_ms)))
	[ "$delay_ms" -lt "$remaining_ms" ] || delay_ms="$remaining_ms"
	if [ "$delay_ms" -gt 0 ]; then
		sleep "$(duration_ms_as_seconds "$delay_ms")"
	fi
}

sleep_for_queued_answer() {
	local retry_after_ms="$1" ahead_count active_conflict_count required_changes deadline_ms remaining_ms tick_ms resource seen known changes=0
	local resources=() observed=("$write_beacon_before" "$heavy_read_beacon_before")
	ahead_count="$(json_number "$response" aheadCount)"
	active_conflict_count="$(json_number "$response" activeConflictCount)"
	if [ "$outcome" != queued ] || [ -z "$ahead_count" ] || [ -z "$active_conflict_count" ] ||
		[ "$((ahead_count + active_conflict_count))" -lt 1 ] || ! local_beacons_ready; then
		equal_jitter_ms "$retry_after_ms"
		sleep_within_acquisition "$JITTER_MS"
		return 0
	fi
	required_changes=$((ahead_count + active_conflict_count))
	case "$lane" in
	write)
		resources+=(write)
		[ "$heavy_read" != true ] || resources+=(heavy-read)
		;;
	heavy-read) resources+=(heavy-read) ;;
	*)
		equal_jitter_ms "$retry_after_ms"
		sleep_within_acquisition "$JITTER_MS"
		return 0
		;;
	esac
	[ "$retry_after_ms" -ge "$LOCAL_WAKE_MAX_MS" ] || retry_after_ms="$LOCAL_WAKE_MAX_MS"
	equal_jitter_ms "$retry_after_ms"
	deadline_ms=$(($(current_time_ms) + JITTER_MS))
	[ "$deadline_ms" -le "$acquisition_deadline_ms" ] || deadline_ms="$acquisition_deadline_ms"
	while :; do
		for resource in "${resources[@]}"; do
			read_release_beacon "$resource"
			[ -n "$RELEASE_BEACON" ] || continue
			known=false
			for seen in "${observed[@]}"; do
				if [ "$RELEASE_BEACON" = "$seen" ]; then
					known=true
					break
				fi
			done
			[ "$known" = false ] || continue
			observed+=("$RELEASE_BEACON")
			changes=$((changes + 1))
			[ "$changes" -lt "$required_changes" ] || return 0
		done
		remaining_ms=$((deadline_ms - $(current_time_ms)))
		[ "$remaining_ms" -gt 0 ] || return 0
		tick_ms=100
		[ "$tick_ms" -le "$remaining_ms" ] || tick_ms="$remaining_ms"
		sleep "$(duration_ms_as_seconds "$tick_ms")"
	done
}

lease_deadline_from_response() {
	local response="$1" request_started_ms="$2" remaining_ms
	remaining_ms="$(json_number "$response" leaseRemainingMs)"
	[ -n "$remaining_ms" ] || remaining_ms="$LEGACY_LEASE_MS"
	LEASE_DEADLINE_MS=$((request_started_ms + remaining_ms - (ADMISSION_KILL_GRACE_SECS + 5) * 1000))
}

bounded_heartbeat_interval() {
	local interval_ms="${1:-$FALLBACK_HEARTBEAT_MS}"
	[ "$interval_ms" -ge "$MIN_HEARTBEAT_MS" ] || interval_ms="$MIN_HEARTBEAT_MS"
	printf '%s' "$interval_ms"
}

stop_payload() {
	local deadline
	[ -n "$payload_pid" ] || return 0

	payload_group_is_alive || return 0
	kill -TERM -- "-${payload_pid}" 2>/dev/null || kill -TERM "$payload_pid" 2>/dev/null || true
	deadline=$((SECONDS + ADMISSION_KILL_GRACE_SECS))
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
	local deadline="$1" temporary
	[ -n "$watchdog_state" ] || return 1
	temporary="${watchdog_state}.new"
	printf '%s\n' "$deadline" >"$temporary" || return 1
	mv -f -- "$temporary" "$watchdog_state"
}

watchdog_deadline_ms() {
	local deadline
	deadline="$(sed -n '1p' "$watchdog_state" 2>/dev/null)"
	case "$deadline" in
	'' | *[!0-9]*) printf '0' ;;
	*) printf '%s' "$deadline" ;;
	esac
}

watchdog_deadline_passed() {
	[ -r "$watchdog_state" ] || return 0
	[ "$(current_time_ms)" -ge "$(watchdog_deadline_ms)" ]
}

heartbeat_request_timeout() {
	local remaining_ms configured_ms
	remaining_ms=$(($(watchdog_deadline_ms) - $(current_time_ms)))
	configured_ms=$((ADMISSION_HTTP_TIMEOUT_SECS * 1000))
	[ "$remaining_ms" -gt 0 ] || remaining_ms=1
	[ "$remaining_ms" -lt "$configured_ms" ] || remaining_ms="$configured_ms"
	duration_ms_as_seconds "$remaining_ms"
}

payload_group_is_alive() {
	[ -n "$payload_pid" ] || return 1
	kill -0 -- "-${payload_pid}" 2>/dev/null || payload_is_running
}

payload_is_running() {
	local running_pid
	[ -n "$payload_pid" ] || return 1
	for running_pid in $(jobs -pr); do
		[ "$running_pid" = "$payload_pid" ] && return 0
	done
	return 1
}

cleanup_supervision_sleeper() {
	local sleeper="$supervision_sleeper_pid"
	supervision_sleeper_pid=""
	[ -n "$sleeper" ] || return 0
	kill "$sleeper" 2>/dev/null || true
	wait "$sleeper" 2>/dev/null || true
}

wait_for_payload_or_tick() {
	sleep 1 &
	supervision_sleeper_pid="$!"
	if kill -0 "$payload_pid" 2>/dev/null; then
		wait -n "$payload_pid" "$supervision_sleeper_pid" 2>/dev/null || true
	fi
	cleanup_supervision_sleeper
}

elapsed_hold_ms() {
	if [ -z "$payload_started_ms" ]; then
		printf '0'
		return 0
	fi
	printf '%s' "$(($(current_time_ms) - payload_started_ms))"
}

# shellcheck disable=SC2329
on_signal() {
	cleanup_supervision_sleeper
	stop_payload
	terminal_admission
	cleanup_watchdog
	release_breaker_probe
	emit_admission_event cancelled "$(elapsed_hold_ms)"
	exit 143
}
trap on_signal TERM INT HUP

transient_failures=0
while :; do
	if [ "$enforced" -eq 1 ] && [ "$(current_time_ms)" -ge "$acquisition_deadline_ms" ]; then
		exit_wait_expired "${last_wait_yield_reason:-queue}"
	fi
	breaker_admits || stand_aside_for_breaker
	acquire_attempted=true
	snapshot_release_beacons
	if ! admission_post acquire "" "$(acquisition_request_timeout)"; then

		case "$ADMISSION_ERROR_REASON" in
		coordinator-unavailable | gateway-transport)
			if [ "$enforced" -eq 0 ] && [ "$ADMISSION_FAIL_CLOSED" != "true" ]; then
				run_payload_unadmitted shadow-unavailable
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
			if breaker_is_open; then
				stand_aside_for_breaker
			fi
			transient_failures=$((transient_failures + 1))
			full_jitter_ms "$transient_failures" "$((ADMISSION_BACKOFF_CAP_SECS * 1000))"
			sleep_within_acquisition "$JITTER_MS"
			continue
		fi
		yield_reason="$ADMISSION_ERROR_REASON"
		terminal_admission
		failure_outcome="$(admission_failure_outcome "$yield_reason")"
		exit_admission_yield "$failure_outcome" "$yield_reason"
	fi
	transient_failures=0

	response="$ADMISSION_RESPONSE"
	acquire_request_started_ms="$ADMISSION_REQUEST_STARTED_MS"
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
		run_payload_unadmitted shadow
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
		lease_deadline_from_response "$response" "$acquire_request_started_ms"
		break
	fi

	last_wait_yield_reason="$(safe_admission_yield_reason "${yield_reason:-queue}")"

	remaining_ms=$((acquisition_deadline_ms - $(current_time_ms)))
	if [ "$remaining_ms" -le 0 ]; then
		exit_wait_expired "$last_wait_yield_reason"
	fi
	retry_after_ms="$(json_number "$response" retryAfterMs)"
	[ -n "$retry_after_ms" ] || retry_after_ms=$((ADMISSION_POLL_SECS * 1000))
	sleep_for_queued_answer "$retry_after_ms"
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
if ! refresh_watchdog_deadline "$LEASE_DEADLINE_MS"; then
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
		database-admission-payload "$owner_pid" "$ADMISSION_KILL_GRACE_SECS" "$watchdog_state" "${payload_command[@]}" &
else
	setsid bash -c "$payload_supervisor_source" \
		database-admission-payload "$owner_pid" "$ADMISSION_KILL_GRACE_SECS" "$watchdog_state" "${payload_command[@]}" &
fi
payload_pid="$!"
payload_started_ms="$(current_time_ms)"
heartbeat_after_ms="$(bounded_heartbeat_interval "$heartbeat_after_ms")"
next_heartbeat_ms=$((payload_started_ms + heartbeat_after_ms))
heartbeat_failures=0
fence_lost=0

while payload_is_running; do
	if [ "$(current_time_ms)" -ge "$next_heartbeat_ms" ]; then
		if watchdog_deadline_passed; then
			fence_lost=1
			yield_reason="heartbeat-deadline"
			break
		fi
		if ! admission_post heartbeat "$fencing_token" "$(heartbeat_request_timeout)"; then

			if transient_admission_failure && ! watchdog_deadline_passed; then
				yield_reason="$ADMISSION_ERROR_REASON"
				emit_admission_event heartbeat-retry "$(elapsed_hold_ms)"
				heartbeat_failures=$((heartbeat_failures + 1))
				full_jitter_ms "$heartbeat_failures" "$HEARTBEAT_BACKOFF_CAP_MS"
				next_heartbeat_ms=$(($(current_time_ms) + JITTER_MS))
				wait_for_payload_or_tick
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
		lease_deadline_from_response "$response" "$ADMISSION_REQUEST_STARTED_MS"
		if ! refresh_watchdog_deadline "$LEASE_DEADLINE_MS"; then
			fence_lost=1
			yield_reason="heartbeat-deadline"
			break
		fi

		yield_reason=""
		heartbeat_failures=0
		heartbeat_after_ms="$(bounded_heartbeat_interval "$(json_number "$response" heartbeatAfterMs)")"
		next_heartbeat_ms=$(($(current_time_ms) + heartbeat_after_ms))
	fi
	wait_for_payload_or_tick
done

if [ -r "$watchdog_state" ] && [ "$(sed -n '1p' "$watchdog_state")" = "expired" ]; then
	fence_lost=1
	yield_reason="heartbeat-deadline"
fi

if [ "$fence_lost" -eq 1 ]; then
	stop_payload
fi

wait "$payload_pid" 2>/dev/null
payload_rc="$?"
stop_payload
hold_ms="$(elapsed_hold_ms)"

if [ "$enforced" -eq 1 ]; then
	terminal_admission
fi
cleanup_watchdog
if [ "$fence_lost" -eq 1 ]; then
	emit_admission_event fenced "$hold_ms"
	finish_admission_bookkeeping
	exit 75
fi
emit_admission_event released "$hold_ms"
finish_admission_bookkeeping
exit "$payload_rc"
