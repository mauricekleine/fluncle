#!/usr/bin/env bash

set -euo pipefail

RELEASE_REPO="${SONARFRESHEN_RELEASE_REPO:-mauricekleine/fluncle}"
RELEASE_TAG="${SONARFRESHEN_RELEASE_TAG:-sonar-latest}"
ASSET_BASE="${SONARFRESHEN_ASSET_BASE:-https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}}"

STATE_DIR="${SONARFRESHEN_STATE_DIR:-/opt/sonar-freshen}"
SHA_FILE="${SONARFRESHEN_SHA_FILE:-$STATE_DIR/deployed-sha}"
BOOTSTRAP_READY_FILE="${SONARFRESHEN_BOOTSTRAP_READY_FILE:-$STATE_DIR/local-state-ready}"
ROLLBACK_INTENT_FILE="${SONARFRESHEN_ROLLBACK_INTENT_FILE:-$STATE_DIR/swap-in-progress}"
STATE_ROLLBACK_FILE="${SONARFRESHEN_STATE_ROLLBACK_FILE:-$STATE_DIR/local-state.rollback}"
LOCK="${SONARFRESHEN_LOCK:-/run/lock/fluncle-sonar-freshen.lock}"

SERVICE="${SONARFRESHEN_SERVICE:-sonar}"
APP_DIR="${SONARFRESHEN_APP_DIR:-/opt/sonar}"
APP_BIN="${SONARFRESHEN_APP_BIN:-$APP_DIR/sonar}"
PREV_BIN="$APP_BIN.prev"
SERVICE_ENV="${SONARFRESHEN_SERVICE_ENV:-/etc/sonar.env}"

BOOT_TIMEOUT_SECS="${SONARFRESHEN_BOOT_TIMEOUT_SECS:-1200}"

SMOKE_PORT_BASE="${SONARFRESHEN_SMOKE_PORT_BASE:-42480}"
case "$SMOKE_PORT_BASE" in
'' | *[!0-9]*) SMOKE_PORT_BASE=42480 ;;
esac

WORKER_URL="${SONARFRESHEN_WORKER_URL:-https://www.fluncle.com}"

FLUNCLE_API_BASE_URL="${FLUNCLE_API_BASE_URL-$WORKER_URL}"

MODE="--if-changed"
case "${1:-}" in
--force) MODE="--force" ;;
--dry-run) MODE="--dry-run" ;;
esac

log() { printf '[sonar-freshen] %s\n' "$*" >&2; }
die() {
	log "FATAL: $*"
	exit 1
}

RUN_EVENT_UNIT="fluncle-sonar-freshen"
RUN_EVENT_INTERVAL_MS=3600000

SF_CHECKED="null"
SF_PRODUCED="null"
SF_QUEUE="null"
SF_ERRORS=0

SF_GATE="null"
SF_SUMMARY_EMITTED=0
SF_STARTED_AT=""
ROLLBACK_ARMED=0
BOOTSTRAP_MARKER_CREATED=0
PRIOR_LIVE_SHA=""

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
	if [ "$SF_SUMMARY_EMITTED" = "1" ]; then return 0; fi
	SF_SUMMARY_EMITTED=1
	case "$rc" in '' | *[!0-9]*) rc=0 ;; esac
	ended="$(run_event_now)"
	summary="$(printf '{"checked":%s,"produced":%s,"errors":%d,"queueDepth":%s,"gateState":%s,"expectedIntervalMs":%d}' \
		"$SF_CHECKED" "$SF_PRODUCED" "$SF_ERRORS" "$SF_QUEUE" "$SF_GATE" "$RUN_EVENT_INTERVAL_MS")"
	printf '%s\n' "$summary"
	record_run_event "$RUN_EVENT_UNIT" "$SF_STARTED_AT" "$ended" "$rc" "$summary" || true
	return 0
}

_cleanup() { :; }
on_exit() {
	local rc=$?
	if [ "$ROLLBACK_ARMED" = "1" ]; then
		if ! rollback_unaccepted_swap; then rc=1; fi
	fi
	emit_run_summary "$rc" || true
	_cleanup || true
	return "$rc"
}
SF_STARTED_AT="$(run_event_now)"
trap 'on_exit' EXIT

exec 9>"$LOCK"
flock -n 9 || {
	log "another run holds the lock; exiting"

	SF_GATE='"locked"'
	exit 0
}

SF_CHECKED=0
SF_PRODUCED=0
SF_QUEUE=0

command -v curl >/dev/null || {
	SF_ERRORS=$((SF_ERRORS + 1))
	die "curl not found"
}

alert() {
	[ -n "${DISCORD_ALERT_WEBHOOK:-}" ] || return 0
	curl -fsS -m 10 -H 'Content-Type: application/json' \
		-d "$(printf '{"content":%s}' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')")" \
		"${DISCORD_ALERT_WEBHOOK}" >/dev/null 2>&1 || true
}

post_health() {
	[ -n "${FLUNCLE_API_TOKEN:-}" ] || return 0
	local status="$1" esc at producer core digest key body reconcile_body response http_status response_body attempt
	esc="$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')"
	at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
	producer="sonar-freshen"
	core="$(printf '{"at":"%s","checks":[{"latencyMs":null,"message":"%s","service":"self-deploy-sonar","status":"%s","transitioned":false}],"producer":"%s"}' \
		"$at" "$esc" "$status" "$producer")"
	if command -v sha256sum >/dev/null 2>&1; then
		digest="$(printf '%s' "$core" | sha256sum | awk '{print $1}')"
	else
		digest="$(printf '%s' "$core" | shasum -a 256 | awk '{print $1}')"
	fi
	key="health.snapshot:${producer}:${at}"
	body="$(printf '{"at":"%s","checks":[{"service":"self-deploy-sonar","status":"%s","message":"%s","latencyMs":null,"transitioned":false}],"operationKey":"%s","producer":"%s","requestDigest":"%s"}' \
		"$at" "$status" "$esc" "$key" "$producer" "$digest")"
	reconcile_body="$(printf '{"operationId":"health.snapshot","operationKey":"%s","requestDigest":"%s"}' "$key" "$digest")"

	for attempt in 1 2; do
		http_status=""
		if http_status="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' \
			-H 'Content-Type: application/json' -H "Authorization: Bearer ${FLUNCLE_API_TOKEN}" \
			-d "$body" "${WORKER_URL%/}/api/v1/admin/health" 2>/dev/null)"; then
			case "$http_status" in
			2??) return 0 ;;
			4??)
				log "record_health rejected the snapshot (best-effort, not replayed)"
				return 0
				;;
			esac
		fi

		if ! response="$(curl -sS -m 10 -w $'\n%{http_code}' \
			-H 'Content-Type: application/json' -H "Authorization: Bearer ${FLUNCLE_API_TOKEN}" \
			-d "$reconcile_body" "${WORKER_URL%/}/api/v1/admin/operation-receipts/resolve" 2>/dev/null)"; then
			log "record_health reconciliation unavailable; snapshot was not replayed"
			return 0
		fi
		http_status="${response##*$'\n'}"
		response_body="${response%$'\n'*}"
		case "$http_status" in
		2??) ;;
		*)
			log "record_health reconciliation unavailable; snapshot was not replayed"
			return 0
			;;
		esac
		if printf '%s' "$response_body" | grep -Eq '"outcome"[[:space:]]*:[[:space:]]*"committed"'; then
			return 0
		fi
		if printf '%s' "$response_body" | grep -Eq '"outcome"[[:space:]]*:[[:space:]]*"safely-retryable"' && [ "$attempt" -lt 2 ]; then
			continue
		fi
		log "record_health reconciliation did not authorize replay"
		return 0
	done
}

env_value() {
	[ -r "$SERVICE_ENV" ] || return 0
	sed -n "s/^[[:space:]]*$1=//p" "$SERVICE_ENV" 2>/dev/null | tail -1 |
		sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

require_local_runtime_contract() {
	local key value missing=()
	local required=(
		TURSO_DATABASE_URL
		TURSO_AUTH_TOKEN
		FLUNCLE_API_BASE_URL
		FLUNCLE_API_TOKEN
		SONAR_CONSUMER_ID
		SONAR_REPLICA_PATH
		SONAR_STATE_PATH
		SONAR_SECRET
	)

	[ -r "$SERVICE_ENV" ] || runtime_contract_fail "the live service EnvironmentFile is unreadable"

	for key in "${required[@]}"; do
		value="$(env_value "$key")"
		[ -n "$value" ] || missing+=("$key")
	done

	if [ "${#missing[@]}" -gt 0 ]; then
		if [ -n "$(env_value SONAR_REFRESH_SECS)" ] && [ -z "$(env_value SONAR_STATE_PATH)" ]; then
			runtime_contract_fail "the live service still has the legacy remote-query runtime contract; provision the current local-replica environment and durable state before retrying"
		fi
		runtime_contract_fail "the live service local-replica contract is incomplete (missing: ${missing[*]})"
	fi

	SMOKE_STATE_PATH="$(env_value SONAR_STATE_PATH)"
	SMOKE_SECRET="$(env_value SONAR_SECRET)"
	SMOKE_STATE_PRESENT=0
	[ -r "$SMOKE_STATE_PATH" ] && SMOKE_STATE_PRESENT=1
	BOOTSTRAP_READY=0
	[ -f "$BOOTSTRAP_READY_FILE" ] && BOOTSTRAP_READY=1

	if [ "$BOOTSTRAP_READY" = "1" ] && [ "$SMOKE_STATE_PRESENT" != "1" ]; then
		runtime_contract_fail "the completed-bootstrap marker exists but its durable state is unreadable"
	fi
	if [ "$SMOKE_STATE_PRESENT" != "1" ] && [ "$MODE" = "--dry-run" ]; then
		runtime_contract_fail "the configured durable state is not initialized; dry-run cannot perform the first guarded bootstrap"
	fi
}

LIVE_PORT="$(env_value SONAR_PORT)"
LIVE_PORT="${LIVE_PORT:-443}"
LIVE_CURL=(curl -fsS -m 10)
LIVE_SCHEME="http"
if [ -n "$(env_value SONAR_TLS_CERT)" ]; then
	LIVE_SCHEME="https"

	LIVE_CURL+=(-k)
fi
LIVE_CURL+=("$LIVE_SCHEME://127.0.0.1:$LIVE_PORT/health")
health_matches() {
	local expected_commit="${1:-}"
	python3 -c 'import json,sys
expected=sys.argv[1]
try:
    body=json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
if not isinstance(body,dict) or body.get("ok") is not True:
    raise SystemExit(1)
raise SystemExit(0 if not expected or body.get("commit") == expected else 2)' "$expected_commit"
}
live_healthy() {
	local expected_commit="${1:-}" body
	body="$("${LIVE_CURL[@]}" 2>/dev/null)" || return 1
	printf '%s' "$body" | health_matches "$expected_commit"
}

live_commit() {
	local body
	body="$("${LIVE_CURL[@]}" 2>/dev/null)" || return 1
	printf '%s' "$body" | python3 -c 'import json,re,sys
try:
    body=json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
commit=body.get("commit") if isinstance(body,dict) and body.get("ok") is True else None
if not isinstance(commit,str) or re.fullmatch(r"[0-9a-f]{40}",commit) is None:
    raise SystemExit(1)
print(commit)'
}

durable_sync_file() {
	sync -f "$1" && sync -f "$(dirname "$1")"
}

durable_sync_dir() { sync -f "$1"; }

write_deployed_sha() {
	local commit="$1" sha_tmp="${SHA_FILE}.tmp.$$"
	printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$' || return 1
	if ! printf '%s\n' "$commit" >"$sha_tmp" ||
		! durable_sync_file "$sha_tmp" ||
		! mv -f "$sha_tmp" "$SHA_FILE" ||
		! durable_sync_file "$SHA_FILE"; then
		rm -f "$sha_tmp" || true
		return 1
	fi
}

intent_value() {
	sed -n "s/^$1=//p" "$ROLLBACK_INTENT_FILE" 2>/dev/null | head -n 1
}

write_rollback_intent() {
	local state_ready="$1" state_present="$2" accepted="$3" intent_tmp="${ROLLBACK_INTENT_FILE}.tmp.$$"
	if ! printf 'candidate=%s\nbootstrap_ready=%s\nprior_commit=%s\nstate_ready=%s\nstate_present=%s\naccepted=%s\n' \
		"$NEW_SHA" "$BOOTSTRAP_READY" "$PRIOR_LIVE_SHA" "$state_ready" "$state_present" "$accepted" >"$intent_tmp" ||
		! durable_sync_file "$intent_tmp" ||
		! mv -f "$intent_tmp" "$ROLLBACK_INTENT_FILE" ||
		! durable_sync_file "$ROLLBACK_INTENT_FILE"; then
		rm -f "$intent_tmp"
		return 1
	fi
}

snapshot_local_state() {
	local source="$SMOKE_STATE_PATH" suffix source_file backup_file state_present=0
	rm -f "$STATE_ROLLBACK_FILE" "${STATE_ROLLBACK_FILE}-wal" "${STATE_ROLLBACK_FILE}-shm" ||
		return 1
	durable_sync_dir "$STATE_DIR" || return 1
	if [ -e "$source" ]; then state_present=1; fi
	for suffix in '' '-wal' '-shm'; do
		source_file="${source}${suffix}"
		backup_file="${STATE_ROLLBACK_FILE}${suffix}"
		[ -e "$source_file" ] || continue

		cp -pf "$source_file" "$backup_file" || return 1
		durable_sync_file "$backup_file" || return 1
	done
	write_rollback_intent 1 "$state_present" 0
}

mark_rollback_intent_accepted() {
	write_rollback_intent "$(intent_value state_ready)" "$(intent_value state_present)" 1
}

restore_local_state() {
	[ "$(intent_value state_ready)" = "1" ] || return 0
	local target suffix source_file target_file
	target="$(env_value SONAR_STATE_PATH)"
	[ -n "$target" ] || return 1
	rm -f "$target" "${target}-wal" "${target}-shm" || return 1
	if [ "$(intent_value state_present)" = "1" ]; then
		for suffix in '' '-wal' '-shm'; do
			source_file="${STATE_ROLLBACK_FILE}${suffix}"
			target_file="${target}${suffix}"
			[ -e "$source_file" ] || continue
			cp -pf "$source_file" "$target_file" || return 1
			durable_sync_file "$target_file" || return 1
		done
	fi
	durable_sync_dir "$(dirname "$target")"
}

clear_rollback_intent() {
	rm -f "$ROLLBACK_INTENT_FILE" || return 1
	durable_sync_dir "$STATE_DIR"
}

cleanup_rollback_artifacts() {
	local cleanup_failed=0
	rm -f "$PREV_BIN" || cleanup_failed=1
	durable_sync_dir "$APP_DIR" || cleanup_failed=1
	rm -f "$STATE_ROLLBACK_FILE" "${STATE_ROLLBACK_FILE}-wal" "${STATE_ROLLBACK_FILE}-shm" ||
		cleanup_failed=1
	durable_sync_dir "$STATE_DIR" || cleanup_failed=1
	[ "$cleanup_failed" = "0" ]
}

cleanup_accepted_swap() {
	if ! clear_rollback_intent; then return 1; fi
	if ! cleanup_rollback_artifacts; then
		log "accepted sonar is healthy, but stale rollback files need cleanup"
	fi
	return 0
}

service_healthy() {
	local expected_commit="${1:-}"
	systemctl restart "$SERVICE" || return 1
	local i
	for ((i = 0; i < BOOT_TIMEOUT_SECS; i++)); do
		if ! systemctl is-active --quiet "$SERVICE"; then return 1; fi
		if live_healthy "$expected_commit"; then return 0; fi
		sleep 1
	done
	return 1
}

restore_previous_binary() {
	[ -f "$PREV_BIN" ] || return 1
	systemctl stop "$SERVICE" || return 1
	restore_local_state || return 1
	install -m 0755 "$PREV_BIN" "$APP_BIN.rb" || return 1
	durable_sync_file "$APP_BIN.rb" || return 1
	mv -f "$APP_BIN.rb" "$APP_BIN" || return 1
	durable_sync_file "$APP_BIN" || return 1
	local prior_commit
	prior_commit="$(intent_value prior_commit)"
	service_healthy "$prior_commit" || return 1
	if [ -n "$prior_commit" ]; then
		write_deployed_sha "$prior_commit" || return 1
	else
		rm -f "$SHA_FILE" || return 1
		durable_sync_dir "$STATE_DIR" || return 1
	fi
	if grep -qx 'bootstrap_ready=0' "$ROLLBACK_INTENT_FILE" 2>/dev/null; then
		if ! rm -f "$BOOTSTRAP_READY_FILE" || ! durable_sync_dir "$STATE_DIR"; then
			log "rollback is healthy and durable, but bootstrap-marker cleanup is pending"
			return 0
		fi
	fi
	clear_rollback_intent || return 1
	if ! cleanup_rollback_artifacts; then
		log "rollback is healthy and durable, but stale rollback files need cleanup"
	fi
	return 0
}

recover_interrupted_swap() {
	[ -f "$ROLLBACK_INTENT_FILE" ] || return 0
	local candidate recorded
	candidate="$(intent_value candidate)"
	recorded="$(cat "$SHA_FILE" 2>/dev/null || true)"
	if [ "$(intent_value accepted)" = "1" ] &&
		printf '%s' "$candidate" | grep -Eq '^[0-9a-f]{40}$' &&
		[ "$recorded" = "$candidate" ] &&
		live_healthy "$candidate"; then
		log "finishing cleanup for an accepted sonar swap"
		if ! cleanup_accepted_swap; then
			SF_ERRORS=$((SF_ERRORS + 1))
			die "accepted sonar is healthy, but its rollback intent could not be cleared"
		fi
		return 0
	fi
	SF_ERRORS=$((SF_ERRORS + 1))
	log "recovering an interrupted unaccepted swap before checking the release"
	if ! command -v systemctl >/dev/null || ! restore_previous_binary; then
		alert "🔴 sonar-freshen: interrupted-swap recovery failed — sonar may be DOWN. Operator needed NOW."
		post_health down "sonar interrupted-swap recovery failed — operator needed"
		die "could not restore the previous binary from interrupted-swap intent"
	fi
	post_health degraded "recovered an interrupted sonar update; healthy on the previous binary"
	log "interrupted-swap recovery restored the previous healthy sonar binary"
}

mkdir -p "$STATE_DIR"
command -v python3 >/dev/null 2>&1 || die "python3 not found — cannot validate sonar health identity"
command -v sync >/dev/null 2>&1 || die "sync not found — cannot make sonar rollback state durable"
recover_interrupted_swap
if [ -f "$ROLLBACK_INTENT_FILE" ]; then
	log "rollback cleanup remains pending; deferring the release check"
	exit 1
fi
if ! cleanup_rollback_artifacts; then
	log "stale rollback files remain after cleanup; the live service is untouched"
fi
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sonar-freshen.XXXXXX")"
_cleanup() { rm -rf "$WORK_DIR"; }

if ! curl -fsSL --retry 3 --retry-delay 2 -m 60 -o "$WORK_DIR/sonar.commit" "$ASSET_BASE/sonar.commit"; then
	SF_ERRORS=$((SF_ERRORS + 1))
	log "could not fetch $ASSET_BASE/sonar.commit — leaving the live service alone"
	post_health degraded "the sonar release feed is unreachable; the live engine is untouched"
	exit 0
fi

NEW_SHA="$(tr -d '[:space:]' <"$WORK_DIR/sonar.commit")"

if ! printf '%s' "$NEW_SHA" | grep -Eq '^[0-9a-f]{40}$'; then
	SF_ERRORS=$((SF_ERRORS + 1))
	log "the published sonar.commit is not a commit SHA — refusing to act on it"
	post_health degraded "the sonar release feed looks malformed; the live engine is untouched"
	exit 0
fi

SF_CHECKED=1

OLD_SHA="$(cat "$SHA_FILE" 2>/dev/null || true)"
if ! printf '%s' "$OLD_SHA" | grep -Eq '^[0-9a-f]{40}$'; then OLD_SHA=''; fi

if [ "$MODE" = "--force" ]; then

	reason="forced"
elif [ "$MODE" = "--dry-run" ]; then

	reason="dry run"
	SF_GATE='"dry-run"'
elif [ -z "$OLD_SHA" ]; then
	reason="no baseline (first run)"
elif [ "$OLD_SHA" = "$NEW_SHA" ]; then

	log "${OLD_SHA:0:12} -> ${NEW_SHA:0:12} | already current — no-op"
	post_health ok "sonar current"
	exit 0
else
	reason="a newer sonar build is published"
fi

SF_QUEUE=1
log "${OLD_SHA:-<none>} -> $NEW_SHA | $reason"

runtime_contract_fail() {
	SF_ERRORS=$((SF_ERRORS + 1))
	alert "🛰️ sonar-freshen: RUNTIME CONTRACT NOT READY for ${NEW_SHA:0:12} on rave-01 — box untouched, staying on the current sonar binary"
	post_health degraded "a sonar update is waiting for its local runtime contract; the live engine is untouched"
	die "$1"
}

require_local_runtime_contract

download_fail() {
	SF_ERRORS=$((SF_ERRORS + 1))
	alert "🛰️ sonar-freshen: DOWNLOAD/VERIFY FAILED ($1) for ${NEW_SHA:0:12} on rave-01 — box untouched, staying on the current sonar binary"
	post_health degraded "a sonar update failed download or checksum verification; the live engine is untouched"
	die "download/verify failed: $1"
}

NEW_BIN="$WORK_DIR/sonar"
curl -fsSL --retry 3 --retry-delay 2 -m 600 -o "$NEW_BIN" "$ASSET_BASE/sonar" ||
	download_fail "could not download the binary"
curl -fsSL --retry 3 --retry-delay 2 -m 60 -o "$WORK_DIR/sonar.sha256" "$ASSET_BASE/sonar.sha256" ||
	download_fail "could not download the checksum"

verify_checksum() {
	if command -v sha256sum >/dev/null 2>&1; then
		(cd "$WORK_DIR" && sha256sum -c sonar.sha256) >/dev/null 2>&1
	elif command -v shasum >/dev/null 2>&1; then
		(cd "$WORK_DIR" && shasum -a 256 -c sonar.sha256) >/dev/null 2>&1
	else
		return 2
	fi
}
verify_rc=0
verify_checksum || verify_rc=$?
if [ "$verify_rc" -eq 2 ]; then
	download_fail "no sha256sum/shasum available to verify the artifact"
elif [ "$verify_rc" -ne 0 ]; then
	download_fail "CHECKSUM MISMATCH — the downloaded binary is not the published one"
fi
chmod +x "$NEW_BIN"
[ -x "$NEW_BIN" ] || download_fail "the downloaded artifact is not executable"
log "checksum verified for ${NEW_SHA:0:12}"

presmoke_fail() {
	SF_ERRORS=$((SF_ERRORS + 1))
	alert "🛰️ sonar-freshen: PRE-SMOKE FAILED ($1) for ${NEW_SHA:0:12} on rave-01 — box untouched, staying on the current sonar binary"
	post_health degraded "a sonar update failed validation; the live engine is untouched on the current binary"
	die "pre-smoke failed: $1"
}

if [ "$SMOKE_STATE_PRESENT" = "1" ]; then

	port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
	SMOKE_LOG="$WORK_DIR/boot.log"

	SMOKE_PID=""
	cleanup_smoke() {
		[ -z "$SMOKE_PID" ] || kill "$SMOKE_PID" >/dev/null 2>&1 || true
		[ -z "$SMOKE_PID" ] || wait "$SMOKE_PID" 2>/dev/null || true
		SMOKE_PID=""
	}
	_cleanup() {
		cleanup_smoke
		rm -rf "$WORK_DIR"
	}

	smoke_healthy() {
		local body health_rc=0 remaining timeout
		remaining=$((SMOKE_DEADLINE - SECONDS))
		[ "$remaining" -gt 0 ] || return 1
		timeout="$remaining"
		[ "$timeout" -le 10 ] || timeout=10
		body="$(curl -fsS -m "$timeout" "http://127.0.0.1:$SMOKE_PORT/health" 2>/dev/null)" || return 1
		printf '%s' "$body" | health_matches "$NEW_SHA" || health_rc=$?
		if [ "$health_rc" -eq 2 ]; then
			SMOKE_IDENTITY_MISMATCH=1
			return 1
		fi
		[ "$health_rc" -eq 0 ]
	}

	smoked=0
	SMOKE_IDENTITY_MISMATCH=0
	SMOKE_BIND_COLLISIONS=0
	SMOKE_FREE_CANDIDATES=0
	SMOKE_INFRA_FAILURE=0
	smoke_failure=""
	SMOKE_DEADLINE=$((SECONDS + BOOT_TIMEOUT_SECS))
	for offset in 0 1 2 3 4; do
		p=$((SMOKE_PORT_BASE + offset))
		[ "$SECONDS" -lt "$SMOKE_DEADLINE" ] || break
		port_free "$p" || continue
		SMOKE_FREE_CANDIDATES=$((SMOKE_FREE_CANDIDATES + 1))
		SMOKE_PORT="$p"
		: >"$SMOKE_LOG"
		SONAR_STATE_PATH="$SMOKE_STATE_PATH" SONAR_VALIDATE_ONLY=true SONAR_SECRET="$SMOKE_SECRET" SONAR_BIND=127.0.0.1 SONAR_PORT="$SMOKE_PORT" SONAR_TLS_CERT='' SONAR_TLS_KEY='' "$NEW_BIN" >"$SMOKE_LOG" 2>&1 &
		SMOKE_PID=$!
		SMOKE_IDENTITY_MISMATCH=0
		while [ "$SECONDS" -lt "$SMOKE_DEADLINE" ]; do
			if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
				wait "$SMOKE_PID" 2>/dev/null || true
				SMOKE_PID=""
				if grep -Eqi 'address already in use|EADDRINUSE' "$SMOKE_LOG"; then
					SMOKE_BIND_COLLISIONS=$((SMOKE_BIND_COLLISIONS + 1))
					SMOKE_IDENTITY_MISMATCH=0
					log "isolated smoke port $SMOKE_PORT was claimed during boot; trying the next candidate"
					break
				fi
				smoke_failure="the new binary exited during boot ($(tr '\n' ' ' <"$SMOKE_LOG" | tail -c 200))"
				break 2
			fi
			if smoke_healthy; then
				smoked=1
				break 2
			fi
			if [ "$SMOKE_IDENTITY_MISMATCH" = "1" ]; then
				sleep 1
				kill -0 "$SMOKE_PID" 2>/dev/null && break 2
				continue
			fi
			sleep 1
		done
		cleanup_smoke
	done
	cleanup_smoke
	_cleanup() { rm -rf "$WORK_DIR"; }
	if [ "$smoked" != "1" ] && [ -z "$smoke_failure" ] && [ "$SMOKE_BIND_COLLISIONS" -gt 0 ] && [ "$SMOKE_BIND_COLLISIONS" -eq "$SMOKE_FREE_CANDIDATES" ]; then
		if [ "$SECONDS" -ge "$SMOKE_DEADLINE" ]; then smoke_failure="the isolated boot budget expired after confirmed port collisions"; else smoke_failure="every available isolated smoke port was claimed during boot"; fi
		SMOKE_INFRA_FAILURE=1
	elif [ "$smoked" != "1" ] && [ -z "$smoke_failure" ] && [ "$SMOKE_FREE_CANDIDATES" -eq 0 ]; then
		smoke_failure="no free loopback port for the isolated boot"
		SMOKE_INFRA_FAILURE=1
	fi
	[ "$SMOKE_IDENTITY_MISMATCH" = "0" ] ||
		presmoke_fail "the downloaded binary reports a different baked commit than sonar.commit"
	if [ "$smoked" = "1" ]; then
		log "pre-smoke passed"
	else
		[ -n "$smoke_failure" ] ||
			smoke_failure="the new binary did not serve a healthy /health within ${BOOT_TIMEOUT_SECS}s"
		if [ "$SMOKE_INFRA_FAILURE" = "1" ]; then presmoke_fail "$smoke_failure"; fi
		if [ "$BOOTSTRAP_READY" = "1" ]; then
			presmoke_fail "$smoke_failure"
		fi
		[ "$MODE" != "--dry-run" ] ||
			runtime_contract_fail "the unmarked durable state did not validate; dry-run cannot retry its bootstrap"
		log "unmarked durable state did not validate; retrying the incomplete bootstrap through the guarded service swap"
	fi
else
	log "durable state is not initialized; deferring the one-time bootstrap to the guarded service swap"
fi

if [ "$MODE" = "--dry-run" ]; then
	log "dry-run: ${NEW_SHA:0:12} downloaded, verified and pre-smoked; leaving the live service untouched"
	exit 0
fi

command -v systemctl >/dev/null || {
	SF_ERRORS=$((SF_ERRORS + 1))
	die "systemctl not found — cannot manage $SERVICE"
}

mark_bootstrap_ready() {
	local marker_tmp="${BOOTSTRAP_READY_FILE}.tmp.$$"
	if ! printf '%s\n' "$NEW_SHA" >"$marker_tmp" || ! mv -f "$marker_tmp" "$BOOTSTRAP_READY_FILE"; then
		rm -f "$marker_tmp"
		log "could not record the completed local-state bootstrap marker"
		return 1
	fi
	if [ "$BOOTSTRAP_READY" = "0" ]; then BOOTSTRAP_MARKER_CREATED=1; fi
	return 0
}

rollback_unaccepted_swap() {

	ROLLBACK_ARMED=0
	SF_ERRORS=$((SF_ERRORS + 1))
	log "the candidate did not complete acceptance — rolling back"
	if restore_previous_binary; then
		BOOTSTRAP_MARKER_CREATED=0
		alert "↩️ sonar-freshen: candidate failed acceptance — ROLLED BACK to the previous sonar binary (running). A human should look."
		post_health degraded "rolled back an unaccepted sonar update; healthy on the previous binary"
		log "rollback restored the previous healthy sonar binary"
		return 0
	fi
	alert "🔴 sonar-freshen: ROLLBACK ALSO FAILED — sonar is DOWN. Operator needed NOW."
	post_health down "the sonar engine is down after a failed update — operator needed"
	log "FATAL: rollback failed — sonar is down"
	return 1
}

if [ -f "$APP_BIN" ]; then
	PRIOR_LIVE_SHA="$(live_commit 2>/dev/null || true)"
	if ! printf '%s' "$PRIOR_LIVE_SHA" | grep -Eq '^[0-9a-f]{40}$'; then
		PRIOR_LIVE_SHA="$OLD_SHA"
	fi
	cp -f "$APP_BIN" "$PREV_BIN" || {
		SF_ERRORS=$((SF_ERRORS + 1))
		die "could not snapshot the current binary to $PREV_BIN"
	}
	durable_sync_file "$PREV_BIN" || {
		SF_ERRORS=$((SF_ERRORS + 1))
		die "could not make the rollback binary durable"
	}
fi
if ! write_rollback_intent 0 0 0; then
	SF_ERRORS=$((SF_ERRORS + 1))
	die "could not persist rollback intent before swapping the candidate"
fi

ROLLBACK_ARMED=1
if ! systemctl stop "$SERVICE" || ! snapshot_local_state; then
	die "could not capture a durable local-state rollback snapshot"
fi
install -m 0755 "$NEW_BIN" "$APP_BIN.new"
durable_sync_file "$APP_BIN.new"
mv -f "$APP_BIN.new" "$APP_BIN"
durable_sync_file "$APP_BIN"

log "swapping $SERVICE to ${NEW_SHA:0:12} and restarting"

if service_healthy "$NEW_SHA" && mark_bootstrap_ready; then

	write_deployed_sha "$NEW_SHA" || die "could not persist the accepted sonar commit"
	mark_rollback_intent_accepted || die "could not persist the accepted sonar swap marker"
	ROLLBACK_ARMED=0

	SF_PRODUCED=1
	SF_QUEUE=0
	log "post-swap smoke passed — deployed ${NEW_SHA:0:12}"
	if ! cleanup_accepted_swap; then
		log "accepted sonar is healthy, but stale rollback files need cleanup"
	fi
	alert "🚀 sonar-freshen: deployed ${NEW_SHA:0:12} to sonar on rave-01 (CI artifact verified + swapped)"
	post_health ok "swapped sonar to the latest published build"
	exit 0
fi

die "the new binary did not satisfy the post-swap acceptance contract"
