# shellcheck shell=bash

_REBAKE_LOCK="$(dirname -- "${HOME:-/opt/data/home}")/rebake.lock"
_CRON_OUTPUT_REBAKE_ACTIVE=false
if [ -f "$_REBAKE_LOCK" ]; then
	if [ -n "$(find "$_REBAKE_LOCK" -mmin +45 2>/dev/null)" ]; then
		echo "stale rebake lock (>45 min) at ${_REBAKE_LOCK} — clearing and proceeding" >&2
		rm -f "$_REBAKE_LOCK" 2>/dev/null || true
	elif [ "${CRON_OUTPUT_REBAKE_MARKER_ONLY:-false}" = "true" ]; then
		_CRON_OUTPUT_REBAKE_ACTIVE=true
	else
		echo "rebake in progress (${_REBAKE_LOCK}) — skipping this tick; the next schedule reruns it"
		exit 0
	fi
fi

_cron_output_dir() {
	printf '%s' "${HEALTHCHECK_CRON_OUTPUT_DIR:-$(dirname -- "${HOME:-/opt/data/home}")/cron/output}"
}

CRON_OUTPUT_STDERR_DELIMITER='<!-- fluncle-cron-output: stderr tail -->'

CRON_OUTPUT_STDERR_LINES="${CRON_OUTPUT_STDERR_LINES:-200}"

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

emit_cron_output() {
	local admission_skip=false job summary=""
	if [ "${1:-}" = "--admission-skip" ]; then
		admission_skip=true
		shift
		job="${1:-}"
		summary="${2:-}"
		shift 2
		if [ -z "$job" ] || [ -z "$summary" ] || [ "$#" -ne 0 ]; then
			echo 'usage: emit_cron_output --admission-skip <job> <summary>' >&2
			return 2
		fi
	else
		job="$1"
		shift
		if [ "${1:-}" = "--" ]; then
			shift
		fi
	fi

	if [ "$_CRON_OUTPUT_REBAKE_ACTIVE" = true ] && [ "$admission_skip" != true ]; then
		return 0
	fi

	local base marker tmp tmp_err tmp_rc rc=0
	local started_at ended_at summary_raw
	base="$(_cron_output_dir)/fluncle-${job}"
	mkdir -p "$base" 2>/dev/null || true
	tmp="$(mktemp 2>/dev/null || printf '/tmp/cron-%s.%s.out' "$job" "$$")"
	tmp_err="$(mktemp 2>/dev/null || printf '/tmp/cron-%s.%s.err' "$job" "$$")"
	tmp_rc="$(mktemp 2>/dev/null || printf '/tmp/cron-%s.%s.rc' "$job" "$$")"

	started_at="$(run_event_now)"
	if [ "$admission_skip" = true ]; then
		printf '%s\n' "$summary" >"$tmp"
		: >"$tmp_err"
		printf '0' >"$tmp_rc"
	else
		{
			set +e
			"$@" >"$tmp"
			printf '%s' "$?" >"$tmp_rc"
		} 2>&1 | tee "$tmp_err" >&2
	fi
	ended_at="$(run_event_now)"

	rc="$(cat "$tmp_rc" 2>/dev/null || printf 0)"
	case "$rc" in '' | *[!0-9]*) rc=0 ;; esac

	marker="${base}/$(date -u +%Y-%m-%dT%H%M%SZ)-$$.md"
	{
		printf '# Cron Job: fluncle-%s\n\n' "$job"
		cat "$tmp"

		if [ -s "$tmp_err" ]; then
			printf '%s\n' "$CRON_OUTPUT_STDERR_DELIMITER"
			tail -n "$CRON_OUTPUT_STDERR_LINES" "$tmp_err" | sed 's/^/> /'
		fi
	} >"$marker" 2>/dev/null || true

	cat "$tmp" 2>/dev/null || true

	summary_raw="$(grep -v '^[[:space:]]*$' "$tmp" 2>/dev/null | tail -n 1 || true)"
	rm -f "$tmp" "$tmp_err" "$tmp_rc" 2>/dev/null || true
	record_run_event "fluncle-${job}" "$started_at" "$ended_at" "$rc" "$summary_raw" || true

	# shellcheck disable=SC2012
	{ ls -1t "${base}"/*.md 2>/dev/null | tail -n +21 | while IFS= read -r old; do
		rm -f "$old" 2>/dev/null || true
	done; } || true

	return "$rc"
}

emit_admission_skip_output() {
	local job="$1" summary="$2"
	if [ "${CRON_OUTPUT_REBAKE_MARKER_ONLY:-false}" != "true" ]; then
		echo 'admission skip marker mode is not enabled' >&2
		return 2
	fi
	emit_cron_output --admission-skip "$job" "$summary"
}
