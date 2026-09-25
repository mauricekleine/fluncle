#!/usr/bin/env bash

set -euo pipefail

CONTAINER="${PINWATCH_CONTAINER:-hermes}"
IMAGE_REPO="${PINWATCH_IMAGE_REPO:-fluncle-hermes}"
REPO_URL="${PINWATCH_REPO_URL:-https://github.com/mauricekleine/fluncle.git}"
REPO_DIR="${PINWATCH_REPO_DIR:-/opt/fluncle-build}"
DOCKERFILE="docs/agents/hermes/Dockerfile"
LOCK="${PINWATCH_LOCK:-/run/lock/fluncle-pin-watch.lock}"
LAST_BUILD_FILE="${PINWATCH_LAST_BUILD_FILE:-/opt/fluncle-pin-watch/last-build-at}"
REBUILD_INTERVAL_SECS=7200
KEEP_IMAGES="${PINWATCH_KEEP_IMAGES:-2}"
SWEEP_DRAIN_TIMEOUT="${PINWATCH_SWEEP_DRAIN_TIMEOUT:-300}"

RELEASE_STAGGER_SECS="${PINWATCH_RELEASE_STAGGER_SECS:-}"
RELEASE_STAGGER_PER_TIMER_SECS=9
RELEASE_STAGGER_MIN_SECS=60
RELEASE_STAGGER_MAX_SECS=900
RELEASE_STAGGER_CEILING_SECS=3600

RELEASE_HEAVY_TIMERS=(
	fluncle-artist-sweep.timer
	fluncle-capture.timer
	fluncle-cover-masters.timer
	fluncle-crawl.timer
	fluncle-label-releases.timer
	fluncle-projection-maintenance.timer
)

HERMES_CPUS="${PINWATCH_CPUS:-3}"
HERMES_MEMORY_GIB="${PINWATCH_MEMORY_GIB:-6}"

CONTAINER_SECURITY_ARGS=(
	--security-opt no-new-privileges
	--cap-drop ALL
)

MODE="--if-stale"
case "${1:-}" in
--force) MODE="--force" ;;
--dry-run) MODE="--dry-run" ;;
--fingerprint) MODE="--fingerprint" ;;
esac
case "${PINWATCH_FORCE_IMMEDIATE:-0}" in
0) ;;
1) if [ "$MODE" = "--if-stale" ]; then MODE="--force"; fi ;;
*)
	printf '[pin-watch] FATAL: PINWATCH_FORCE_IMMEDIATE must be 0 or 1\n' >&2
	exit 1
	;;
esac

log() { printf '[pin-watch] %s\n' "$*" >&2; }
die() {
	ERRORS=1
	log "FATAL: $*"
	exit 1
}

RUN_EVENT_UNIT="fluncle-pin-watch"

RUN_EVENT_INTERVAL_MS=3600000

CHECKED=0
DEPLOYED=0
ERRORS=0
DRIFT=0
SUMMARY_EMITTED=0
STARTED_AT=""
ENVTMP=""
QUIESCE_STARTED_AT=""
QUIESCE_ENDED_AT=""
QUIESCE_STARTED_EPOCH=0
QUIESCE_DURATION_SECONDS=0

container_env() {
	docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null |
		sed -n "s/^$1=//p" | head -1 || true
}

to_nanocpus() {
	local whole="${1%%.*}" frac=""
	case "$1" in *.*) frac="${1#*.}" ;; esac
	frac="${frac}000000000"
	printf '%d' "$((10#${whole:-0} * 1000000000 + 10#${frac:0:9}))"
}

from_nanocpus() { printf '%d.%03d' "$(($1 / 1000000000))" "$((($1 % 1000000000) / 1000000))"; }

validate_ceiling() {
	case "$HERMES_CPUS" in
	'' | *[!0-9.]* | *.*.* | .* | *.) die "PINWATCH_CPUS='$HERMES_CPUS' is not a CPU count (a positive number, e.g. 3 or 2.5)" ;;
	esac
	case "$HERMES_MEMORY_GIB" in
	'' | *[!0-9]*) die "PINWATCH_MEMORY_GIB='$HERMES_MEMORY_GIB' is not a whole number of GiB (e.g. 6)" ;;
	esac
	CEILING_NANOCPUS="$(to_nanocpus "$HERMES_CPUS")"
	CEILING_MEMORY_BYTES="$((10#$HERMES_MEMORY_GIB * 1073741824))"

	[ "$CEILING_NANOCPUS" -ge 1000000000 ] || die "PINWATCH_CPUS='$HERMES_CPUS' is below docker's 1 CPU floor"
	[ "$CEILING_MEMORY_BYTES" -ge 1073741824 ] || die "PINWATCH_MEMORY_GIB='$HERMES_MEMORY_GIB' is below the 1 GiB floor the container needs"
}

preserve_live_ceiling() {
	local live_nanocpus live_memory
	live_nanocpus="$(docker inspect "$CONTAINER" --format '{{.HostConfig.NanoCpus}}' 2>/dev/null || true)"
	live_memory="$(docker inspect "$CONTAINER" --format '{{.HostConfig.Memory}}' 2>/dev/null || true)"
	case "$live_nanocpus" in '' | *[!0-9]*) live_nanocpus=0 ;; esac
	case "$live_memory" in '' | *[!0-9]*) live_memory=0 ;; esac
	if [ "$live_nanocpus" -gt "$CEILING_NANOCPUS" ]; then
		log "keeping the live CPU ceiling ($(from_nanocpus "$live_nanocpus")) — higher than the configured $(from_nanocpus "$CEILING_NANOCPUS")"
		CEILING_NANOCPUS="$live_nanocpus"
	fi
	if [ "$live_memory" -gt "$CEILING_MEMORY_BYTES" ]; then
		log "keeping the live memory ceiling ($((live_memory / 1073741824)) GiB) — higher than the configured $((CEILING_MEMORY_BYTES / 1073741824)) GiB"
		CEILING_MEMORY_BYTES="$live_memory"
	fi
	log "container ceiling: --cpus=$(from_nanocpus "$CEILING_NANOCPUS") --memory=${CEILING_MEMORY_BYTES}b (no swap)"
}

validate_release_stagger() {
	case "$RELEASE_STAGGER_SECS" in
	'') return 0 ;;
	*[!0-9]*) die "PINWATCH_RELEASE_STAGGER_SECS='$RELEASE_STAGGER_SECS' is not a whole number of seconds (0 disables the stagger)" ;;
	esac
	RELEASE_STAGGER_SECS="$((10#$RELEASE_STAGGER_SECS))"
	[ "$RELEASE_STAGGER_SECS" -le "$RELEASE_STAGGER_CEILING_SECS" ] ||
		die "PINWATCH_RELEASE_STAGGER_SECS='$RELEASE_STAGGER_SECS' is above the ${RELEASE_STAGGER_CEILING_SECS}s ceiling (the unit's TimeoutStartSec has to hold the rebuild AND the window)"
}

resolve_release_window() {
	local count="$1" window
	if [ -n "$RELEASE_STAGGER_SECS" ]; then
		printf '%d' "$RELEASE_STAGGER_SECS"
		return 0
	fi
	window=$((count * RELEASE_STAGGER_PER_TIMER_SECS))
	if [ "$window" -lt "$RELEASE_STAGGER_MIN_SECS" ]; then window="$RELEASE_STAGGER_MIN_SECS"; fi
	if [ "$window" -gt "$RELEASE_STAGGER_MAX_SECS" ]; then window="$RELEASE_STAGGER_MAX_SECS"; fi
	printf '%d' "$window"
}

validate_ceiling
validate_release_stagger

alert() {
	[ -n "${WEBHOOK:-}" ] || return 0
	curl -fsS -m 10 -H 'Content-Type: application/json' \
		-d "$(printf '{"content":%s}' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')")" \
		"$WEBHOOK" >/dev/null 2>&1 || true
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

rebuild_window_open() {
	[ "$MODE" = "--force" ] && return 0
	[ -f "$LAST_BUILD_FILE" ] || return 0
	local last_build_at now
	last_build_at="$(cat "$LAST_BUILD_FILE")"
	case "$last_build_at" in '' | *[!0-9]*) die "invalid last-build timestamp in $LAST_BUILD_FILE" ;; esac
	now="$(date -u +%s)"
	if [ "$now" -lt "$((last_build_at + REBUILD_INTERVAL_SECS))" ]; then
		log "drift deferred until epoch $((last_build_at + REBUILD_INTERVAL_SECS)); the next eligible tick builds latest main"
		return 1
	fi
	return 0
}

record_build_start() {
	local build_stamp_tmp
	build_stamp_tmp="$(mktemp "${LAST_BUILD_FILE}.XXXXXX")" || die "cannot reserve the last-build timestamp"
	printf '%s\n' "$(date -u +%s)" >"$build_stamp_tmp" || die "cannot write the last-build timestamp"
	mv -f "$build_stamp_tmp" "$LAST_BUILD_FILE" || die "cannot persist the last-build timestamp"
}

emit_run_summary() {
	local rc="${1:-0}" ended summary quiesce_started_json=null quiesce_ended_json=null
	if [ "$SUMMARY_EMITTED" = "1" ]; then return 0; fi
	SUMMARY_EMITTED=1
	case "$rc" in '' | *[!0-9]*) rc=0 ;; esac
	ended="$(run_event_now)"
	if [ -n "$QUIESCE_STARTED_AT" ]; then quiesce_started_json="\"$QUIESCE_STARTED_AT\""; fi
	if [ -n "$QUIESCE_ENDED_AT" ]; then quiesce_ended_json="\"$QUIESCE_ENDED_AT\""; fi
	summary="$(printf '{"checked":%d,"produced":%d,"errors":%d,"queue_depth":%d,"gateState":null,"expectedIntervalMs":%d,"quiesce_started_at":%s,"quiesce_ended_at":%s,"quiesce_duration_seconds":%d}' \
		"$CHECKED" "$DEPLOYED" "$ERRORS" "$DRIFT" "$RUN_EVENT_INTERVAL_MS" \
		"$quiesce_started_json" "$quiesce_ended_json" "$QUIESCE_DURATION_SECONDS")"
	printf '%s\n' "$summary"
	if [ -z "${FLUNCLE_API_TOKEN:-}" ]; then
		FLUNCLE_API_TOKEN="${APITOKEN:-$(container_env FLUNCLE_API_TOKEN)}"
	fi
	record_run_event "$RUN_EVENT_UNIT" "$STARTED_AT" "$ended" "$rc" "$summary" || true
	return 0
}

# shellcheck disable=SC2329  # invoked indirectly from the EXIT trap armed after the lock
pinwatch_on_exit() {
	local rc=$?
	cleanup_runtime_smoke
	restore_sweep_timers
	[ -n "$ENVTMP" ] && rm -f "$ENVTMP"
	emit_run_summary "$rc" || true
	return 0
}

BAKED_PATHS_FALLBACK=(
	docs/agents/hermes
	packages/skills
	apps/cli/assets/fonts
)
BAKED_PATHS=()

derive_baked_paths() {
	awk '
    toupper($1) == "COPY" {
      if ($0 ~ /--from=/) next
      n = 0
      for (i = 2; i <= NF; i++) if ($i !~ /^--/) tok[++n] = $i
      for (i = 1; i < n; i++) { sub(/\/+$/, "", tok[i]); print tok[i] }
    }
  ' "$REPO_DIR/$DOCKERFILE" | LC_ALL=C sort -u
}

validate_baked_paths() {
	local p matched
	[ "${#BAKED_PATHS[@]}" -gt 0 ] || return 1
	for p in "${BAKED_PATHS[@]}"; do
		case "$p" in '' | -* | /* | *'$'* | *'"'* | *"'"* | *'['*) return 1 ;; esac
		matched="$(git -C "$REPO_DIR" ls-tree -r HEAD -- "$p")"
		[ -n "$matched" ] || return 1
	done
}

resolve_baked_paths() {

	local line
	BAKED_PATHS=()
	while IFS= read -r line; do
		[ -n "$line" ] && BAKED_PATHS+=("$line")
	done < <(derive_baked_paths)
	BAKED_PATHS+=("$DOCKERFILE")
	if validate_baked_paths; then
		log "baked paths (derived from the $DOCKERFILE COPY set): ${BAKED_PATHS[*]}"
		return 0
	fi
	BAKED_PATHS=("${BAKED_PATHS_FALLBACK[@]}")
	log "WARNING: could not derive the baked paths from $DOCKERFILE — using the coarse fallback: ${BAKED_PATHS[*]}"
	alert "⚠️ pin-watch: could not parse the COPY set in $DOCKERFILE — fingerprinting the coarse fallback paths instead. The box still rebuilds (it over-triggers), but the parser needs a look."
}

baked_fingerprint() {
	git -C "$REPO_DIR" ls-tree -r HEAD -- "${BAKED_PATHS[@]}" | LC_ALL=C sort | sha256sum | cut -d' ' -f1
}

if [ "$MODE" = "--fingerprint" ]; then
	command -v git >/dev/null || die "git not found"
	[ -d "$REPO_DIR/.git" ] || die "no git checkout at $REPO_DIR (set PINWATCH_REPO_DIR)"
	resolve_baked_paths
	printf 'paths: %s\n' "${BAKED_PATHS[*]}"
	printf 'fingerprint: %s\n' "$(baked_fingerprint)"
	exit 0
fi

STOPPED_TIMERS=()
RUNTIME_SMOKE_CONTAINER=""

cleanup_runtime_smoke() {
	[ -n "$RUNTIME_SMOKE_CONTAINER" ] || return 0
	docker rm -f "$RUNTIME_SMOKE_CONTAINER" >/dev/null 2>&1 || true
	RUNTIME_SMOKE_CONTAINER=""
}

REBAKE_LOCK=""

# shellcheck disable=SC2329  # invoked indirectly from the EXIT trap set in quiesce_sweeps
rearm_stalled_timer() {
	local timer="$1" service="${1%.timer}.service" mono real
	mono="$(systemctl show "$timer" -p NextElapseUSecMonotonic --value 2>/dev/null)"
	real="$(systemctl show "$timer" -p NextElapseUSecRealtime --value 2>/dev/null)"
	[ "$mono" = "infinity" ] && [ -z "$real" ] || return 1
	case "$(systemctl show "$service" -p ActiveState --value 2>/dev/null)" in
	active | activating | reloading | deactivating) return 1 ;;
	esac
	systemctl start --no-block "$service" >/dev/null 2>&1 || return 1
	log "re-armed ${timer} (restored with no next elapse; kicked ${service} once)"
}

# shellcheck disable=SC2329  # invoked indirectly from restore_sweep_timers
release_is_heavy() {
	local candidate
	for candidate in "${RELEASE_HEAVY_TIMERS[@]}"; do
		if [ "$1" = "$candidate" ]; then return 0; fi
	done
	return 1
}

# shellcheck disable=SC2329  # invoked indirectly from restore_sweep_timers
release_order() {
	local t gap slot filled
	local heavy=() light=() ordered=()

	while IFS= read -r t; do
		if [ -n "$t" ]; then
			if release_is_heavy "$t"; then heavy+=("$t"); else light+=("$t"); fi
		fi
	done < <(printf '%s\n' "${STOPPED_TIMERS[@]}" | LC_ALL=C sort)

	if [ "${#heavy[@]}" -eq 0 ]; then
		if [ "${#light[@]}" -gt 0 ]; then printf '%s\n' "${light[@]}"; fi
		return 0
	fi
	if [ "${#light[@]}" -eq 0 ]; then
		printf '%s\n' "${heavy[@]}"
		return 0
	fi

	gap=$((${#STOPPED_TIMERS[@]} / ${#heavy[@]}))
	if [ "$gap" -lt 2 ]; then gap=2; fi
	slot=0
	for t in "${heavy[@]}"; do
		ordered+=("$t")
		filled=0
		while [ "$filled" -lt "$((gap - 1))" ] && [ "$slot" -lt "${#light[@]}" ]; do
			ordered+=("${light[$slot]}")
			slot=$((slot + 1))
			filled=$((filled + 1))
		done
	done
	while [ "$slot" -lt "${#light[@]}" ]; do
		ordered+=("${light[$slot]}")
		slot=$((slot + 1))
	done
	printf '%s\n' "${ordered[@]}"
}

# shellcheck disable=SC2329  # invoked indirectly from the EXIT trap set in quiesce_sweeps
restore_sweep_timers() {
	local mode="${1:-immediate}"
	if [ -n "$REBAKE_LOCK" ]; then
		rm -f "$REBAKE_LOCK" 2>/dev/null || true
		REBAKE_LOCK=""
	fi
	[ "${#STOPPED_TIMERS[@]}" -gt 0 ] || return 0

	local t rearmed=0 count started=0 window=0 spacing=0
	local order=()
	count="${#STOPPED_TIMERS[@]}"
	while IFS= read -r t; do
		if [ -n "$t" ]; then order+=("$t"); fi
	done < <(release_order)

	if [ "$mode" = "staggered" ]; then
		window="$(resolve_release_window "$count")"
		if [ "$window" -le 0 ]; then
			mode="immediate"
			log "release stagger disabled (PINWATCH_RELEASE_STAGGER_SECS=0) — restoring ${count} sweep timer(s) at once"
		else
			spacing=$((window / count))
			if [ "$spacing" -lt 1 ]; then spacing=1; fi
			log "releasing ${count} sweep timer(s) over ~$((spacing * (count - 1)))s of a ${window}s window, ${spacing}s apart, in order: ${order[*]}"
		fi
	fi

	for t in "${order[@]}"; do
		if [ "$mode" = "staggered" ] && [ "$started" -gt 0 ]; then
			sleep "$spacing"
		fi
		started=$((started + 1))
		systemctl start "$t" >/dev/null 2>&1 || true

		if rearm_stalled_timer "$t"; then
			rearmed=$((rearmed + 1))
		fi
	done
	if [ "$rearmed" -gt 0 ]; then
		log "restored ${count} sweep timer(s); re-armed ${rearmed} that came back with no next elapse"
	else
		log "restored ${count} sweep timer(s)"
	fi
	STOPPED_TIMERS=()
	if [ -n "${QUIESCE_STARTED_AT:-}" ]; then
		QUIESCE_ENDED_AT="$(run_event_now)"
		QUIESCE_DURATION_SECONDS=$(($(date -u +%s) - QUIESCE_STARTED_EPOCH))
		log "quiesce ended at $QUIESCE_ENDED_AT after ${QUIESCE_DURATION_SECONDS}s"
	fi
}

quiesce_sweeps() {
	local t svc waited

	STOPPED_TIMERS=()
	while IFS= read -r t; do
		[ -n "$t" ] && STOPPED_TIMERS+=("$t")
	done < <(
		systemctl list-units --type=timer --state=active --no-legend --plain 'fluncle-*.timer' 2>/dev/null |
			awk '{print $1}' |
			grep -vxF 'fluncle-healthcheck.timer' |
			grep -vxF 'fluncle-pin-watch.timer' || true
	)
	[ "${#STOPPED_TIMERS[@]}" -gt 0 ] || {
		log "no active sweep timers to quiesce"
		return 0
	}

	local lock_src
	lock_src="$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/opt/data"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)"
	if [ -n "$lock_src" ] && [ -d "$lock_src" ]; then
		REBAKE_LOCK="${lock_src}/rebake.lock"
		date -u +%FT%TZ >"$REBAKE_LOCK" 2>/dev/null || REBAKE_LOCK=""
		[ -n "$REBAKE_LOCK" ] && log "rebake lock held: $REBAKE_LOCK"
	fi

	QUIESCE_STARTED_AT="$(run_event_now)"
	QUIESCE_STARTED_EPOCH="$(date -u +%s)"
	log "quiesce started at $QUIESCE_STARTED_AT for ${#STOPPED_TIMERS[@]} sweep timer(s)"
	for t in "${STOPPED_TIMERS[@]}"; do
		systemctl stop "$t" >/dev/null 2>&1 || true
	done
	log "quiesced ${#STOPPED_TIMERS[@]} sweep timer(s) for the rebuild: ${STOPPED_TIMERS[*]}"

	for t in "${STOPPED_TIMERS[@]}"; do
		svc="${t%.timer}.service"
		waited=0
		while systemctl is-active --quiet "$svc"; do
			if [ "$waited" -ge "$SWEEP_DRAIN_TIMEOUT" ]; then
				log "drain timeout (${SWEEP_DRAIN_TIMEOUT}s): $svc still active — proceeding with the rebuild"
				break
			fi
			sleep 3
			waited=$((waited + 3))
		done
	done
}

exec 9>"$LOCK"
flock -n 9 || {
	log "another run holds the lock; exiting"
	exit 0
}

STARTED_AT="$(run_event_now)"
trap 'pinwatch_on_exit' EXIT

trap 'exit 143' INT TERM

command -v docker >/dev/null || die "docker not found"
command -v git >/dev/null || die "git not found"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "container '$CONTAINER' not running — refusing to act (an operator must (re)provision it)"

WEBHOOK="$(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^DISCORD_ALERT_WEBHOOK=//p' | head -1 || true)"

WORKER_URL="${PINWATCH_WORKER_URL:-https://www.fluncle.com}"
APITOKEN="$(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^FLUNCLE_API_TOKEN=//p' | head -1 || true)"
post_health() {
	[ -n "$APITOKEN" ] || return 0
	local status="$1" esc at producer core digest key body reconcile_body response http_status response_body attempt
	esc="$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')"
	at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
	producer="hermes-pin-watch"
	core="$(printf '{"at":"%s","checks":[{"latencyMs":null,"message":"%s","service":"self-deploy","status":"%s","transitioned":false}],"producer":"%s"}' \
		"$at" "$esc" "$status" "$producer")"
	if command -v sha256sum >/dev/null 2>&1; then
		digest="$(printf '%s' "$core" | sha256sum | awk '{print $1}')"
	else
		digest="$(printf '%s' "$core" | shasum -a 256 | awk '{print $1}')"
	fi
	key="health.snapshot:${producer}:${at}"
	body="$(printf '{"at":"%s","checks":[{"service":"self-deploy","status":"%s","message":"%s","latencyMs":null,"transitioned":false}],"operationKey":"%s","producer":"%s","requestDigest":"%s"}' \
		"$at" "$status" "$esc" "$key" "$producer" "$digest")"
	reconcile_body="$(printf '{"operationId":"health.snapshot","operationKey":"%s","requestDigest":"%s"}' "$key" "$digest")"

	for attempt in 1 2; do
		http_status=""
		if http_status="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' \
			-H 'Content-Type: application/json' -H "Authorization: Bearer $APITOKEN" \
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
			-H 'Content-Type: application/json' -H "Authorization: Bearer $APITOKEN" \
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

if [ -d "$REPO_DIR/.git" ]; then
	git -C "$REPO_DIR" fetch --depth 1 origin main -q
else
	log "cloning the public repo into $REPO_DIR"
	rm -rf "$REPO_DIR"
	git clone --depth 1 "$REPO_URL" "$REPO_DIR" -q
fi
git -C "$REPO_DIR" checkout -q -B main origin/main
git -C "$REPO_DIR" reset --hard -q origin/main

pin_from_dockerfile() { sed -n "s/.*$1@\\([0-9][0-9.]*\\).*/\\1/p" "$REPO_DIR/$DOCKERFILE" | head -1; }

WANT_FLUNCLE="$(sed -n 's#.*releases/download/v\([0-9][0-9.]*\)/fluncle-.*#\1#p' "$REPO_DIR/$DOCKERFILE" | head -1)"
WANT_CLAUDE="$(pin_from_dockerfile '@anthropic-ai\/claude-code')"
[ -n "$WANT_FLUNCLE" ] && [ -n "$WANT_CLAUDE" ] || die "could not parse the Dockerfile pins (fluncle='$WANT_FLUNCLE' claude='$WANT_CLAUDE')"

HAVE_FLUNCLE="$(docker exec "$CONTAINER" fluncle version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
HAVE_CLAUDE="$(docker exec "$CONTAINER" claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
log "fluncle: have=$HAVE_FLUNCLE want=$WANT_FLUNCLE | claude-code: have=$HAVE_CLAUDE want=$WANT_CLAUDE"

resolve_baked_paths
WANT_FP="$(baked_fingerprint)"
HAVE_FP="$(docker exec "$CONTAINER" cat /opt/.hermes-baked-fp 2>/dev/null | tr -d '[:space:]' || true)"
log "baked-fp: have=${HAVE_FP:-<none>} want=$WANT_FP"

CHECKED=1

if [ "$MODE" = "--if-stale" ] &&
	[ "$HAVE_FLUNCLE" = "$WANT_FLUNCLE" ] && [ "$HAVE_CLAUDE" = "$WANT_CLAUDE" ] &&
	[ -n "$HAVE_FP" ] && [ "$HAVE_FP" = "$WANT_FP" ]; then
	log "pins + baked content current — no-op"
	post_health ok "tools + scripts current"
	exit 0
fi

DRIFT=1
if ! rebuild_window_open; then
	post_health ok "tool update deferred to the next rebuild window"
	exit 0
fi
log "pins or baked content drifted (or --force) — rebuilding"

OLD_IMAGE="$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')"
ENVTMP="$(mktemp -p "${XDG_RUNTIME_DIR:-/dev/shm}" pinwatch-env.XXXXXX)"
chmod 600 "$ENVTMP"
comm -23 \
	<(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sort) \
	<(docker inspect "$OLD_IMAGE" --format '{{range .Config.Env}}{{println .}}{{end}}' | sort) \
	>"$ENVTMP"
[ -s "$ENVTMP" ] || die "captured runtime env is empty — refusing to launch a secret-less container"

RESTART="$(docker inspect "$CONTAINER" --format '{{.HostConfig.RestartPolicy.Name}}')"
MOUNT_SRC="$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/opt/data"}}{{.Source}}{{end}}{{end}}')"
[ -n "$MOUNT_SRC" ] || die "could not find the /opt/data mount source on the running container"

preserve_live_ceiling

log "pre-build prune: freeing space (keeping $OLD_IMAGE for rollback)"
docker images "$IMAGE_REPO" --format '{{.Repository}}:{{.Tag}}' |
	grep -vxF "$OLD_IMAGE" | xargs -r docker rmi >/dev/null 2>&1 || true
docker builder prune -f --keep-storage=3GB >/dev/null 2>&1 || true

quiesce_sweeps
record_build_start

SHA="$(git -C "$REPO_DIR" rev-parse --short HEAD)"
NEW_IMAGE="$IMAGE_REPO:v$(date -u +%Y.%m.%d)-$SHA"
log "building $NEW_IMAGE (repo root build context, -f $DOCKERFILE)"
docker build --build-arg FLUNCLE_BAKED_FP="$WANT_FP" -f "$REPO_DIR/$DOCKERFILE" -t "$NEW_IMAGE" "$REPO_DIR" >&2 || {
	alert "🛠️ pin-watch: BUILD FAILED for $NEW_IMAGE — box untouched, staying on $OLD_IMAGE"
	post_health degraded "a tool update failed to build; staying on the current tools"
	die "build failed"
}

presmoke_fail() {
	alert "🛠️ pin-watch: PRE-SMOKE FAILED ($1) for $NEW_IMAGE — box untouched, staying on $OLD_IMAGE"
	post_health degraded "a tool update failed validation; box untouched on the current tools"
	die "pre-smoke failed: $1"
}
verify_agent_role_boundary() {
	local response

	if response="$(docker run --rm "${CONTAINER_SECURITY_ARGS[@]}" --env-file "$ENVTMP" --entrypoint fluncle "$NEW_IMAGE" admin tracks publish 'https://open.spotify.com/track/0000000000000000pinwatch' --json 2>/dev/null)"; then
		presmoke_fail "publish-class command was NOT refused (role boundary regression)"
	fi
	printf '%s' "$response" | grep -Eq '"code"[[:space:]]*:[[:space:]]*"forbidden"' ||
		presmoke_fail "agent token did not receive the exact forbidden role-boundary response"
}
GOT_FLUNCLE="$(docker run --rm "${CONTAINER_SECURITY_ARGS[@]}" --entrypoint fluncle "$NEW_IMAGE" version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
[ "$GOT_FLUNCLE" = "$WANT_FLUNCLE" ] || presmoke_fail "fluncle version $GOT_FLUNCLE != $WANT_FLUNCLE"
GOT_CLAUDE="$(docker run --rm "${CONTAINER_SECURITY_ARGS[@]}" --entrypoint claude "$NEW_IMAGE" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
[ "$GOT_CLAUDE" = "$WANT_CLAUDE" ] || presmoke_fail "claude version $GOT_CLAUDE != $WANT_CLAUDE"

docker run --rm "${CONTAINER_SECURITY_ARGS[@]}" --entrypoint gh "$NEW_IMAGE" --version >/dev/null 2>&1 || presmoke_fail "gh --version failed (audit PR driver missing)"
verify_agent_role_boundary

RUNTIME_SMOKE_CONTAINER="pinwatch-runtime-smoke-$$"
docker run -d --name "$RUNTIME_SMOKE_CONTAINER" \
	"${CONTAINER_SECURITY_ARGS[@]}" \
	--tmpfs /opt/data:rw,noexec,nosuid,nodev,size=64m,uid=10000,gid=10000,mode=0700 \
	"$NEW_IMAGE" >/dev/null 2>&1 || presmoke_fail "runtime container did not start"
sleep 3
if [ "$(docker inspect "$RUNTIME_SMOKE_CONTAINER" --format '{{.State.Running}}' 2>/dev/null || true)" != "true" ] ||
	! docker exec -u hermes "$RUNTIME_SMOKE_CONTAINER" sh -c 'test -w "$HOME" && touch "$HOME/.pinwatch-probe"'; then
	cleanup_runtime_smoke
	presmoke_fail "runtime container did not reach a running, hermes-writable state"
fi
cleanup_runtime_smoke

# shellcheck disable=SC2016  # single-quoted on purpose: $(readlink)/import run in the CONTAINER's sh, not the host
timeout 120 docker run --rm "${CONTAINER_SECURITY_ARGS[@]}" --memory=3g --memory-swap=3g --entrypoint sh "$NEW_IMAGE" -c \
	'test -e "$(readlink -f /opt/muq-venv/bin/python)" && /opt/muq-venv/bin/python -c "import torch, muq, sklearn, scipy"' \
	>/dev/null 2>&1 || presmoke_fail "embed/cluster engine broken (interpreter/import)"
log "pre-smoke passed"

if [ "$MODE" = "--dry-run" ]; then
	log "dry-run: $NEW_IMAGE built and pre-smoke passed; leaving the live container untouched"

	restore_sweep_timers staggered
	exit 0
fi

run_container() {

	docker run -d --name "$CONTAINER" --restart "${RESTART:-unless-stopped}" \
		"${CONTAINER_SECURITY_ARGS[@]}" \
		--cpus="$(from_nanocpus "$CEILING_NANOCPUS")" \
		--memory="${CEILING_MEMORY_BYTES}b" --memory-swap="${CEILING_MEMORY_BYTES}b" \
		--shm-size=1g \
		-e TZ=Europe/Amsterdam \
		--log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
		-v "$MOUNT_SRC":/opt/data \
		--env-file "$ENVTMP" \
		"$1" gateway run >/dev/null
}

postsmoke_drilled=0
container_healthy() {
	if [ "${PINWATCH_TEST_FAIL_POSTSMOKE:-}" = "1" ] && [ "$postsmoke_drilled" = "0" ]; then
		postsmoke_drilled=1
		log "TEST: forcing this post-swap smoke to fail (rollback drill)"
		return 1
	fi
	sleep 6
	[ "$(docker inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null)" = "true" ] &&
		docker exec "$CONTAINER" fluncle version >/dev/null 2>&1
}

log "swapping $CONTAINER: $OLD_IMAGE -> $NEW_IMAGE"
docker stop "$CONTAINER" >/dev/null 2>&1 || true
docker rm "$CONTAINER" >/dev/null 2>&1 || true

if run_container "$NEW_IMAGE" && container_healthy; then
	log "post-swap smoke passed — deployed $NEW_IMAGE"

	DEPLOYED=1
	DRIFT=0

	CHANGES=""
	[ "$HAVE_FLUNCLE" != "$WANT_FLUNCLE" ] && CHANGES="fluncle $HAVE_FLUNCLE→$WANT_FLUNCLE"
	[ "$HAVE_CLAUDE" != "$WANT_CLAUDE" ] && CHANGES="${CHANGES:+$CHANGES, }claude-code $HAVE_CLAUDE→$WANT_CLAUDE"
	alert "🚀 pin-watch: rave-02 updated${CHANGES:+ — $CHANGES}."
	post_health ok "rebuilt to the latest tools"

	docker images "$IMAGE_REPO" --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' |
		sort -rk2 | awk 'NR>'"$KEEP_IMAGES"' {print $1}' | xargs -r docker rmi >/dev/null 2>&1 || true

	docker builder prune -f --keep-storage=3GB >/dev/null 2>&1 || true

	restore_sweep_timers staggered
	exit 0
fi

log "new image did not come up healthy — rolling back to $OLD_IMAGE"
docker stop "$CONTAINER" >/dev/null 2>&1 || true
docker rm "$CONTAINER" >/dev/null 2>&1 || true
if run_container "$OLD_IMAGE" && container_healthy; then
	alert "↩️ pin-watch: $NEW_IMAGE failed smoke on rave-02 — ROLLED BACK to $OLD_IMAGE (running). A human should look."
	post_health degraded "rolled back a failed update; healthy on the previous tools"
	die "rolled back to $OLD_IMAGE after a failed deploy"
fi
alert "🔴 pin-watch: ROLLBACK ALSO FAILED on rave-02 — Hermes is DOWN. Operator needed NOW."
post_health down "agent box down after a failed update — operator needed"
die "rollback failed — box is down"
