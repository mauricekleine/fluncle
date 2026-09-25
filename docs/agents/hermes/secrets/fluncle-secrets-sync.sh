#!/usr/bin/env bash

set -euo pipefail

BOOTSTRAP="${SECRETS_SYNC_BOOTSTRAP:-/etc/hermes-bootstrap.env}"
TPL_DIR="${SECRETS_SYNC_TPL_DIR:-/etc/hermes}"
GATEWAY_OUT="${SECRETS_SYNC_GATEWAY_OUT:-/etc/hermes.env}"
SWEEP_OUT="${SECRETS_SYNC_SWEEP_OUT:-$(getent passwd admin | cut -d: -f6)/.hermes/home/.fluncle-secrets.env}"
CONTAINER="${HERMES_CONTAINER:-hermes}"

RUN_EVENT_UNIT="fluncle-secrets-sync"
RUN_EVENT_INTERVAL_MS=900000

CHECKED=0
PRODUCED=0
ERRORS=0
SUMMARY_EMITTED=0
STARTED_AT=""

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
	local rc="${1:-0}" queue=0 ended summary
	if [ "$SUMMARY_EMITTED" = "1" ]; then return 0; fi
	SUMMARY_EMITTED=1
	case "$rc" in '' | *[!0-9]*) rc=0 ;; esac
	queue=$((CHECKED - PRODUCED))
	[ "$queue" -ge 0 ] || queue=0
	ended="$(run_event_now)"
	summary="$(printf '{"checked":%d,"produced":%d,"errors":%d,"queue_depth":%d,"gateState":null,"expectedIntervalMs":%d}' \
		"$CHECKED" "$PRODUCED" "$ERRORS" "$queue" "$RUN_EVENT_INTERVAL_MS")"
	if [ -z "${FLUNCLE_API_TOKEN:-}" ]; then
		FLUNCLE_API_TOKEN="$(container_env FLUNCLE_API_TOKEN)"
	fi
	if ! record_run_event "$RUN_EVENT_UNIT" "$STARTED_AT" "$ended" "$rc" "$summary"; then
		printf 'fluncle-secrets-sync: run-ledger receipt did not land (%s)\n' \
			"${RUN_EVENT_FAILURE_REASON:-unknown}" >&2
		summary="${summary%?},\"runLedgerReceipt\":false}"
	fi
	printf '%s\n' "$summary"
	return 0
}

_cleanup() { :; }
on_exit() {
	local rc=$?
	if [ "$CHECKED" -eq 0 ] && [ "$rc" -eq 0 ]; then
		ERRORS=$((ERRORS + 1))
		echo "fluncle-secrets-sync: checked zero secret targets" >&2
		rc=1
	fi
	emit_run_summary "$rc" || true
	_cleanup || true
	trap - EXIT
	exit "$rc"
}
STARTED_AT="$(run_event_now)"
trap 'on_exit' EXIT

[ -r "$BOOTSTRAP" ] || {
	ERRORS=$((ERRORS + 1))
	echo "fluncle-secrets-sync: missing $BOOTSTRAP" >&2
	exit 1
}
set -a

# shellcheck source=/dev/null
. "$BOOTSTRAP"
set +a
umask 077

HERMES_UID="${SECRETS_SYNC_HERMES_UID:-10000}"
HERMES_GID="${SECRETS_SYNC_HERMES_GID:-10000}"
if [ "$(id -u)" -eq 0 ]; then
	ROOT_OWN=(-o root -g root)
	HERMES_OWN=(-o "$HERMES_UID" -g "$HERMES_GID")
else
	ROOT_OWN=()
	HERMES_OWN=()
fi

CHECKED=2

tg="$(mktemp)"
ts="$(mktemp)"
_cleanup() { rm -f "$tg" "$ts"; }
op inject -f -i "$TPL_DIR/hermes.env.tpl" -o "$tg"
op inject -f -i "$TPL_DIR/fluncle-secrets.env.tpl" -o "$ts"
grep -q FLUNCLE_API_TOKEN "$tg" || {
	ERRORS=$((ERRORS + 1))
	echo "container env inject sanity fail" >&2
	exit 1
}
grep -q CLAUDE_CODE_OAUTH_TOKEN "$ts" || {
	ERRORS=$((ERRORS + 1))
	echo "sweep inject sanity fail" >&2
	exit 1
}

SWEEP_DIR="$(dirname "$SWEEP_OUT")"
[ -d "$SWEEP_DIR" ] || install -d -m 700 ${HERMES_OWN[@]+"${HERMES_OWN[@]}"} "$SWEEP_DIR"
install -m 600 ${ROOT_OWN[@]+"${ROOT_OWN[@]}"} "$tg" "$GATEWAY_OUT"
PRODUCED=$((PRODUCED + 1))
install -m 600 ${HERMES_OWN[@]+"${HERMES_OWN[@]}"} "$ts" "$SWEEP_OUT"
PRODUCED=$((PRODUCED + 1))

if [ -n "${FLUNCLE_GSC_OP_REF:-}" ]; then
	CHECKED=$((CHECKED + 1))
	GSC_OUT="${SECRETS_SYNC_GSC_OUT:-$SWEEP_DIR/.fluncle-gsc.json}"
	tj="$(mktemp)"
	_cleanup() { rm -f "$tg" "$ts" "$tj"; }
	if op read "$FLUNCLE_GSC_OP_REF" >"$tj" 2>/dev/null && grep -q '"private_key"' "$tj"; then
		install -m 600 ${HERMES_OWN[@]+"${HERMES_OWN[@]}"} "$tj" "$GSC_OUT"
		PRODUCED=$((PRODUCED + 1))
	else

		ERRORS=$((ERRORS + 1))
		echo "fluncle-secrets-sync: GSC key sync failed (audit surfaces-seo will degrade)" >&2
	fi
fi
echo "fluncle-secrets-sync: ok $(date -u +%FT%TZ)"
