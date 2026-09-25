#!/usr/bin/env bash

set -euo pipefail

log() { printf '[fluncle-rave-watchdog] %s\n' "$*" >&2; }

RAVE01_BEACON_URL="${RAVE01_BEACON_URL:-}"
WATCH_STATUS_URL="${WATCH_STATUS_URL:-}"
WATCH_STALE_MINUTES="${WATCH_STALE_MINUTES:-30}"
DISCORD_ALERT_WEBHOOK="${DISCORD_ALERT_WEBHOOK:-}"

WATCH_ONION_URL="${WATCH_ONION_URL:-}"
WATCH_TOR_SOCKS="${WATCH_TOR_SOCKS:-127.0.0.1:9050}"
WATCH_ONION_TIMEOUT="${WATCH_ONION_TIMEOUT:-30}"
WATCH_ONION_ATTEMPTS="${WATCH_ONION_ATTEMPTS:-3}"
WATCH_ONION_RETRY_SLEEP="${WATCH_ONION_RETRY_SLEEP:-5}"
WATCH_WORKER_URL="${WATCH_WORKER_URL:-}"
FLUNCLE_API_TOKEN="${FLUNCLE_API_TOKEN:-}"

STATE_DIR="${WATCH_STATE_DIR:-${STATE_DIRECTORY:-/var/lib/fluncle-rave-watchdog}}"
STATE_FILE="${STATE_DIR}/watchdog-state.json"
ONION_STATE_FILE="${STATE_DIR}/onion-state.json"

CURL_BIN="${WATCH_CURL_BIN:-curl}"

ping_beacon() {
	if [ -z "${RAVE01_BEACON_URL}" ]; then
		return 0
	fi

	if ! "${CURL_BIN}" -sS -o /dev/null --max-time 10 "${RAVE01_BEACON_URL}"; then
		log "beacon ping failed (best-effort, ignored)"
	fi
}

ping_discord() {
	local content="$1"

	if [ -z "${DISCORD_ALERT_WEBHOOK}" ]; then
		log "no DISCORD_ALERT_WEBHOOK — skipping the cross-ping alert"
		return 0
	fi

	if ! "${CURL_BIN}" -sS -X POST -H "Content-Type: application/json" \
		-d "{\"content\":\"${content}\"}" --max-time 10 "${DISCORD_ALERT_WEBHOOK}"; then
		log "discord alert POST failed (best-effort, ignored)"
	fi
}

read_prev_stale() {
	if [ -f "${STATE_FILE}" ] && grep -q '"stale"[[:space:]]*:[[:space:]]*true' "${STATE_FILE}" 2>/dev/null; then
		printf 'true'
	else
		printf 'false'
	fi
}

write_stale() {
	local stale="$1"
	mkdir -p "${STATE_DIR}"
	printf '{ "stale": %s }\n' "${stale}" >"${STATE_FILE}"
}

extract_seconds() {
	local body="$1"

	local value
	value="$(printf '%s' "${body}" |
		grep -o '"secondsSinceProberReport"[[:space:]]*:[[:space:]]*[0-9][0-9]*' |
		grep -o '[0-9][0-9]*$' |
		head -n1)"

	if [ -n "${value}" ]; then
		printf '%s' "${value}"
		return 0
	fi

	if command -v python3 >/dev/null 2>&1; then
		value="$(printf '%s' "${body}" | python3 -c '
import json, sys
try:
    v = json.load(sys.stdin).get("secondsSinceProberReport")
    if isinstance(v, int):
        print(v)
except Exception:
    pass
' 2>/dev/null)"

		if [ -n "${value}" ]; then
			printf '%s' "${value}"
			return 0
		fi
	fi

	return 0
}

cross_ping() {
	if [ -z "${WATCH_STATUS_URL}" ]; then
		log "no WATCH_STATUS_URL — skipping the cross-ping this round"
		return 0
	fi

	local body
	if ! body="$("${CURL_BIN}" -sS --max-time 10 "${WATCH_STATUS_URL}")"; then
		log "/api/v1/status unreachable — skipping the freshness check this round"
		return 0
	fi

	local seconds
	seconds="$(extract_seconds "${body}")"

	if [ -z "${seconds}" ]; then

		log "could not read secondsSinceProberReport — skipping the freshness check this round"
		return 0
	fi

	local threshold=$((WATCH_STALE_MINUTES * 60))
	local prev_stale
	prev_stale="$(read_prev_stale)"

	if [ "${seconds}" -gt "${threshold}" ]; then

		if [ "${prev_stale}" != "true" ]; then
			local minutes=$((seconds / 60))
			ping_discord "Fluncle cross-ping: 🔴 rave-02 prober dark — last health report ${minutes}m ago"
			write_stale "true"
		fi
	else

		if [ "${prev_stale}" = "true" ]; then
			ping_discord "Fluncle cross-ping: 🟢 rave-02 prober recovered"
		fi
		write_stale "false"
	fi
}

read_prev_onion_down() {
	if [ -f "${ONION_STATE_FILE}" ] && grep -q '"down"[[:space:]]*:[[:space:]]*true' "${ONION_STATE_FILE}" 2>/dev/null; then
		printf 'true'
	else
		printf 'false'
	fi
}

write_onion_down() {
	mkdir -p "${STATE_DIR}"
	printf '{ "down": %s }\n' "$1" >"${ONION_STATE_FILE}"
}

probe_and_post_onion() {
	if [ -z "${WATCH_ONION_URL}" ] || [ -z "${WATCH_WORKER_URL}" ] || [ -z "${FLUNCLE_API_TOKEN}" ]; then
		log "onion probe not fully configured (URL / worker URL / token) — skipping"
		return 0
	fi

	local out code time_total attempt
	code="000"
	time_total="0"
	for attempt in $(seq 1 "${WATCH_ONION_ATTEMPTS}"); do
		out="$("${CURL_BIN}" -x "socks5h://onion-probe-${attempt}:x@${WATCH_TOR_SOCKS}" -s -o /dev/null \
			-w '%{http_code} %{time_total}' --max-time "${WATCH_ONION_TIMEOUT}" \
			"${WATCH_ONION_URL}" 2>/dev/null || true)"
		code="${out%% *}"
		time_total="${out##* }"
		[ -z "${code}" ] && code="000"
		[ "${code}" != "000" ] && break
		[ "${attempt}" -lt "${WATCH_ONION_ATTEMPTS}" ] && sleep "${WATCH_ONION_RETRY_SLEEP}"
	done

	local status message latency_ms
	if [ "${code}" = "000" ]; then
		status="down"
		message="unreachable over Tor (${WATCH_ONION_ATTEMPTS} attempts)"
		latency_ms="null"
	else
		status="ok"
		latency_ms="$(awk -v t="${time_total:-0}" 'BEGIN { printf "%d", t * 1000 }')"
		message="reachable (HTTP ${code} in ${time_total}s)"
	fi

	local prev_down now_down transitioned="false"
	prev_down="$(read_prev_onion_down)"
	now_down="false"
	[ "${status}" = "down" ] && now_down="true"
	if [ "${now_down}" != "${prev_down}" ]; then
		transitioned="true"
		if [ "${now_down}" = "true" ]; then
			ping_discord "Fluncle status: 🔴 DOWN: onion — the Tor mirror is unreachable"
		else
			ping_discord "Fluncle status: 🟢 recovered: onion"
		fi
	fi
	write_onion_down "${now_down}"

	local at body producer core digest key reconcile_body response http_status response_body attempt
	at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
	producer="rave-watchdog"
	core="$(printf '{"at":"%s","checks":[{"latencyMs":%s,"message":"%s","service":"onion","status":"%s","transitioned":%s}],"producer":"%s"}' \
		"${at}" "${latency_ms}" "${message}" "${status}" "${transitioned}" "${producer}")"
	if command -v sha256sum >/dev/null 2>&1; then
		digest="$(printf '%s' "$core" | sha256sum | awk '{print $1}')"
	else
		digest="$(printf '%s' "$core" | shasum -a 256 | awk '{print $1}')"
	fi
	key="health.snapshot:${producer}:${at}"
	body="$(printf '{"at":"%s","checks":[{"service":"onion","status":"%s","message":"%s","latencyMs":%s,"transitioned":%s}],"operationKey":"%s","producer":"%s","requestDigest":"%s"}' \
		"${at}" "${status}" "${message}" "${latency_ms}" "${transitioned}" "$key" "$producer" "$digest")"
	reconcile_body="$(printf '{"operationId":"health.snapshot","operationKey":"%s","requestDigest":"%s"}' "$key" "$digest")"

	for attempt in 1 2; do
		http_status=""
		if http_status="$("${CURL_BIN}" -sS -o /dev/null -w '%{http_code}' -X POST \
			-H "Content-Type: application/json" \
			-H "Authorization: Bearer ${FLUNCLE_API_TOKEN}" \
			-d "${body}" --max-time 10 "${WATCH_WORKER_URL%/}/api/v1/admin/health" 2>/dev/null)"; then
			case "$http_status" in
			2??) return 0 ;;
			4??)
				log "onion record_health rejected the snapshot (best-effort, not replayed)"
				return 0
				;;
			esac
		fi

		if ! response="$("${CURL_BIN}" -sS -w $'\n%{http_code}' -X POST \
			-H "Content-Type: application/json" \
			-H "Authorization: Bearer ${FLUNCLE_API_TOKEN}" \
			-d "${reconcile_body}" --max-time 10 \
			"${WATCH_WORKER_URL%/}/api/v1/admin/operation-receipts/resolve" 2>/dev/null)"; then
			log "onion record_health reconciliation unavailable; snapshot was not replayed"
			return 0
		fi
		http_status="${response##*$'\n'}"
		response_body="${response%$'\n'*}"
		case "$http_status" in
		2??) ;;
		*)
			log "onion record_health reconciliation unavailable; snapshot was not replayed"
			return 0
			;;
		esac
		if printf '%s' "$response_body" | grep -Eq '"outcome"[[:space:]]*:[[:space:]]*"committed"'; then
			return 0
		fi
		if printf '%s' "$response_body" | grep -Eq '"outcome"[[:space:]]*:[[:space:]]*"safely-retryable"' && [ "$attempt" -lt 2 ]; then
			continue
		fi
		log "onion record_health reconciliation did not authorize replay"
		return 0
	done
}

ping_beacon
cross_ping
probe_and_post_onion

exit 0
