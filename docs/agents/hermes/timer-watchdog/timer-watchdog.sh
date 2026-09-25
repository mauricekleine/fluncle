#!/usr/bin/env bash

set -uo pipefail

SELF_TIMER="fluncle-timer-watchdog.timer"
CONTAINER="${HERMES_CONTAINER:-hermes}"

RECHECK_DELAY="${TIMER_WATCHDOG_RECHECK_DELAY:-5}"

RUN_EVENT_UNIT="fluncle-timer-watchdog"
RUN_EVENT_INTERVAL_MS=900000

CHECKED=0
REARMED=0
ERRORS=0
STRANDED=0
SUMMARY_EMITTED=0
STARTED_AT=""

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

container_env() {
	docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null |
		sed -n "s/^$1=//p" | head -1 || true
}

RUN_EVENT_PATH='/api/v1/admin/telemetry/runs'

RUN_EVENT_TIMEOUT_SECS="${RUN_EVENT_TIMEOUT_SECS:-5}"
RUN_EVENT_FAILURE_REASON=""

_run_event_json_string() {
	local s="${1:0:4000}"
	s="${s//\\/\\\\}"
	s="${s//\"/\\\"}"
	s="${s//$'\t'/\\t}"
	s="${s//$'\r'/\\r}"
	printf '%s' "$s" | tr -d '\000-\037'
}

record_run_event() {
	local unit="$1" started_at="$2" ended_at="$3" exit_code="$4" summary_raw="$5"
	local base token body
	RUN_EVENT_FAILURE_REASON=""

	base="${FLUNCLE_API_BASE_URL-https://www.fluncle.com}"
	base="${base%/}"
	token="${FLUNCLE_API_TOKEN:-}"
	if [ -z "$token" ]; then
		RUN_EVENT_FAILURE_REASON="missing-token"
		return 1
	fi
	if [ -z "$base" ]; then
		RUN_EVENT_FAILURE_REASON="missing-base-url"
		return 1
	fi
	if ! command -v curl >/dev/null 2>&1; then
		RUN_EVENT_FAILURE_REASON="curl-unavailable"
		return 1
	fi
	case "$exit_code" in '' | *[!0-9]*) exit_code=0 ;; esac
	body="$(printf '{"unit":"%s","started_at":"%s","ended_at":"%s","exit_code":%s,"summary_raw":"%s"}' \
		"$(_run_event_json_string "$unit")" \
		"$(_run_event_json_string "$started_at")" \
		"$(_run_event_json_string "$ended_at")" \
		"$exit_code" \
		"$(_run_event_json_string "$summary_raw")")"
	if ! curl -fsS -o /dev/null --max-time "$RUN_EVENT_TIMEOUT_SECS" \
		-X POST -H 'Content-Type: application/json' \
		-H "Authorization: Bearer ${token}" \
		--data-binary "$body" "${base}${RUN_EVENT_PATH}" >/dev/null 2>&1; then
		RUN_EVENT_FAILURE_REASON="post-failed"
		return 1
	fi
	return 0
}

run_event_now() {
	date -u +%Y-%m-%dT%H:%M:%SZ
}

emit_run_summary() {
	local rc="${1:-0}" ended summary
	if [ "$SUMMARY_EMITTED" = "1" ]; then return 0; fi
	SUMMARY_EMITTED=1
	case "$rc" in '' | *[!0-9]*) rc=0 ;; esac
	ended="$(run_event_now)"
	summary="$(printf '{"checked":%d,"produced":%d,"errors":%d,"queue_depth":%d,"gateState":null,"expectedIntervalMs":%d}' \
		"$CHECKED" "$REARMED" "$ERRORS" "$STRANDED" "$RUN_EVENT_INTERVAL_MS")"
	printf '%s\n' "$summary"
	if [ -z "${FLUNCLE_API_TOKEN:-}" ]; then
		FLUNCLE_API_TOKEN="$(container_env FLUNCLE_API_TOKEN)"
	fi
	record_run_event "$RUN_EVENT_UNIT" "$STARTED_AT" "$ended" "$rc" "$summary" || true
	return 0
}

STARTED_AT="$(run_event_now)"
on_exit() {
	local rc=$?
	if [ "$CHECKED" -eq 0 ] && [ "$rc" -eq 0 ]; then
		ERRORS=$((ERRORS + 1))
		log "FAILED — watchdog examined zero timers"
		rc=1
	fi
	emit_run_summary "$rc" || true
	trap - EXIT
	exit "$rc"
}
trap 'on_exit' EXIT

has_no_next_elapse() {
	local mono real
	mono="$(systemctl show "$1" -p NextElapseUSecMonotonic --value 2>/dev/null)"
	real="$(systemctl show "$1" -p NextElapseUSecRealtime --value 2>/dev/null)"
	[ "$mono" = "infinity" ] && [ -z "$real" ]
}

service_busy() {
	case "$(systemctl show "$1" -p ActiveState --value 2>/dev/null)" in
	active | activating | reloading | deactivating) return 0 ;;
	esac
	return 1
}

list_timers() {
	{
		systemctl list-units --type=timer --state=active --no-legend --plain 'fluncle-*.timer' 2>/dev/null | awk '{print $1}'
		systemctl list-units --type=timer --state=active --no-legend --plain 'pin-watch.timer' 2>/dev/null | awk '{print $1}'
	} | grep -vxF "$SELF_TIMER" | sort -u
}

suspects=()
while IFS= read -r timer; do
	[ -n "$timer" ] || continue

	CHECKED=$((CHECKED + 1))
	service="${timer%.timer}.service"
	has_no_next_elapse "$timer" || continue
	service_busy "$service" && continue
	suspects+=("$timer")
done < <(list_timers)

if [ "$CHECKED" -eq 0 ]; then
	ERRORS=$((ERRORS + 1))
	log "FAILED — watchdog examined zero timers"
	exit 1
fi

if [ "${#suspects[@]}" -eq 0 ]; then
	log "ok — every active timer has a next elapse"
	exit 0
fi

sleep "$RECHECK_DELAY"

stranded=()
for timer in "${suspects[@]}"; do
	service="${timer%.timer}.service"
	has_no_next_elapse "$timer" || continue
	service_busy "$service" && continue
	stranded+=("$timer")
done

if [ "${#stranded[@]}" -eq 0 ]; then
	log "ok — ${#suspects[@]} timer(s) re-armed on their own during the re-check"
	exit 0
fi

STRANDED="${#stranded[@]}"

healed=()
for timer in "${stranded[@]}"; do
	service="${timer%.timer}.service"
	if systemctl start --no-block "$service" >/dev/null 2>&1; then
		healed+=("${timer%.timer}")
		REARMED=$((REARMED + 1))
		log "re-armed ${timer} (no next elapse; kicked ${service} once)"
	else
		ERRORS=$((ERRORS + 1))
		log "FAILED to re-arm ${timer} — could not start ${service}"
	fi
done

webhook="$(container_env DISCORD_ALERT_WEBHOOK)"
if [ -n "$webhook" ]; then
	names="$(
		IFS=', '
		echo "${stranded[*]}"
	)"
	payload="$(printf '{"content": "\\u23f0 timer-watchdog: found %d stranded sweep(s); re-armed %d, failed %d — %s. They were `active` with no next elapse, so they would never have fired again."}' "${#stranded[@]}" "${#healed[@]}" "$ERRORS" "$names")"
	curl -sS --max-time 20 -H "Content-Type: application/json" -d "$payload" "$webhook" >/dev/null 2>&1 || true
fi

[ "${#healed[@]}" -gt 0 ] || exit 1

log "re-armed ${#healed[@]} stranded timer(s)"
