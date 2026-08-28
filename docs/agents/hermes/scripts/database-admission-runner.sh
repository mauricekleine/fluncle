#!/usr/bin/env bash
# One client for every registry-classified recurring writer/heavy reader. The Worker owns queue
# truth and fencing; this process owns bounded waiting and the payload process group.
set -uo pipefail

ADMISSION_PATH='/api/v1/admin/database-admission'

owner="${1:-}"
shift || true
if [ "${1:-}" = "--" ]; then
  shift
fi
if [ -z "$owner" ] || [ "$#" -eq 0 ]; then
  echo 'usage: database-admission-runner.sh <registry-owner> -- <command> [args...]' >&2
  exit 2
fi
case "$owner" in *[!a-z0-9.-]* | '') echo "invalid database admission owner" >&2; exit 2 ;; esac

# Container sweeps normally load this themselves, but admission happens before their entrypoint.
# Host services instead receive the same token through their committed EnvironmentFile.
if [ -r "${HOME:-/nonexistent}/.fluncle-secrets.env" ]; then
  # shellcheck disable=SC1091
  . "${HOME}/.fluncle-secrets.env"
fi

ADMISSION_MAX_WAIT_SECS="${DATABASE_ADMISSION_MAX_WAIT_SECS:-120}"
ADMISSION_POLL_SECS="${DATABASE_ADMISSION_POLL_SECS:-5}"
ADMISSION_HTTP_TIMEOUT_SECS="${DATABASE_ADMISSION_HTTP_TIMEOUT_SECS:-10}"
ADMISSION_KILL_GRACE_SECS="${DATABASE_ADMISSION_KILL_GRACE_SECS:-10}"
ADMISSION_FAIL_CLOSED="${DATABASE_ADMISSION_FAIL_CLOSED:-false}"

bounded_uint() {
  local name="$1" value="$2" minimum="$3" maximum="$4"
  case "$value" in *[!0-9]* | '') echo "${name} must be an integer" >&2; exit 2 ;; esac
  if [ "$value" -lt "$minimum" ] || [ "$value" -gt "$maximum" ]; then
    echo "${name} must be between ${minimum} and ${maximum}" >&2
    exit 2
  fi
}
bounded_uint DATABASE_ADMISSION_MAX_WAIT_SECS "$ADMISSION_MAX_WAIT_SECS" 0 120
bounded_uint DATABASE_ADMISSION_POLL_SECS "$ADMISSION_POLL_SECS" 0 30
bounded_uint DATABASE_ADMISSION_HTTP_TIMEOUT_SECS "$ADMISSION_HTTP_TIMEOUT_SECS" 1 10
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
recovered=false
payload_pid=""

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
  local action="$1" token="${2:-}" request_timeout="${3:-$ADMISSION_HTTP_TIMEOUT_SECS}" body response
  ADMISSION_RESPONSE=""
  [ -n "$api_base" ] || return 1
  [ -n "$api_token" ] || return 1
  command -v curl >/dev/null 2>&1 || return 1
  body="{\"action\":\"${action}\",\"owner\":\"${owner}\",\"runId\":\"${run_id}\""
  if [ -n "$token" ]; then
    body="${body},\"fencingToken\":${token}"
  fi
  body="${body}}"
  response="$(curl -fsS --max-time "$request_timeout" \
    -X POST -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${api_token}" \
    --data-binary "$body" "${api_base}${ADMISSION_PATH}" 2>/dev/null)" || return 1
  ADMISSION_RESPONSE="$response"
  return 0
}

emit_admission_event() {
  local outcome="$1" hold_ms="$2"
  printf '{"event":"database.admission.runner","access_class":"%s","contender":"%s","enforced":%s,"heavy_read":%s,"hold_ms":%s,"operation_id":"%s","outcome":"%s","owner":"%s","queue_age_ms":%s,"recovered":%s,"run_id":"%s","wait_ms":%s,"yield_reason":"%s"}\n' \
    "$lane" "$contender_id" "$enforcement_mode" "$heavy_read" "$hold_ms" "$operation_id" \
    "$outcome" "$owner" "$queue_age_ms" "$recovered" "$run_id" "$wait_ms" "$yield_reason" >&2
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
  payload_is_running || return 0
  kill -TERM -- "-${payload_pid}" 2>/dev/null || kill -TERM "$payload_pid" 2>/dev/null || true
  local deadline=$((SECONDS + ADMISSION_KILL_GRACE_SECS))
  while payload_is_running && [ "$SECONDS" -lt "$deadline" ]; do
    sleep 0.1
  done
  if payload_is_running; then
    kill -KILL -- "-${payload_pid}" 2>/dev/null || kill -KILL "$payload_pid" 2>/dev/null || true
  fi
}

payload_is_running() {
  local running_pid
  [ -n "$payload_pid" ] || return 1
  for running_pid in $(jobs -pr); do
    [ "$running_pid" = "$payload_pid" ] && return 0
  done
  return 1
}

# Invoked indirectly by the trap below.
# shellcheck disable=SC2329
on_signal() {
  stop_payload
  if [ -n "$fencing_token" ]; then
    admission_post release "$fencing_token" || true
  else
    admission_post cancel || true
  fi
  emit_admission_event cancelled "$(( (SECONDS - started_seconds) * 1000 ))"
  exit 143
}
trap on_signal TERM INT HUP

# The local gate is armed on every unit before the database flag opens. Until then, coordinator
# failure and shadow responses preserve compatibility. Once locally armed or remotely enforced,
# inability to prove ownership always yields without starting or continuing the payload.
while :; do
  if ! admission_post acquire "" "$(acquisition_request_timeout)"; then
    if [ "$enforced" -eq 0 ] && [ "$ADMISSION_FAIL_CLOSED" != "true" ]; then
      emit_admission_event shadow-unavailable 0
      exec "$@"
    fi
    admission_post cancel || true
    yield_reason="coordinator-unavailable"
    emit_admission_event acquisition-unavailable 0
    exit 0
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
      emit_admission_event enforcement-not-active 0
      exit 0
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
      admission_post cancel || true
      emit_admission_event invalid-grant 0
      exit 0
    fi
    if [ "$(current_time_ms)" -ge "$acquisition_deadline_ms" ]; then
      admission_post release "$fencing_token" || true
      yield_reason="queue"
      emit_admission_event wait-expired 0
      exit 0
    fi
    break
  fi

  remaining_ms=$((acquisition_deadline_ms - $(current_time_ms)))
  if [ "$remaining_ms" -le 0 ]; then
    admission_post cancel || true
    emit_admission_event wait-expired 0
    exit 0
  fi
  poll_ms=$((ADMISSION_POLL_SECS * 1000))
  [ "$poll_ms" -lt "$remaining_ms" ] || poll_ms="$remaining_ms"
  if [ "$poll_ms" -gt 0 ]; then
    sleep "$(duration_ms_as_seconds "$poll_ms")"
  fi
done

# `setsid` makes every descendant one killable process group. `setpriv --pdeathsig` gives the
# group leader a kernel-delivered TERM if this heartbeat owner dies abruptly; its trap fans that
# signal across the group. An enforced grant is useless without both containment primitives.
if ! command -v setsid >/dev/null 2>&1 || ! command -v setpriv >/dev/null 2>&1; then
  admission_post release "$fencing_token" || true
  yield_reason="containment-unavailable"
  emit_admission_event containment-unavailable 0
  exit 0
fi
owner_pid="$$"
# Expanded by the child bash, not this admission-owner shell.
# shellcheck disable=SC2016
setsid setpriv --pdeathsig TERM bash -c '
  set -uo pipefail
  expected_parent="$1"
  kill_grace="$2"
  shift 2
  [ "$PPID" = "$expected_parent" ] || exit 75
  supervisor_pid="$$"
  on_parent_loss() {
    trap "" TERM INT HUP
    kill -TERM -- "-$$" 2>/dev/null || true
    sleep "$kill_grace"
    kill -KILL -- "-$$" 2>/dev/null || true
  }
  trap on_parent_loss TERM INT HUP
  FLUNCLE_ADMISSION_RUNNER_PID="$expected_parent" "$@" &
  child_pid="$!"
  (
    while kill -0 "$child_pid" 2>/dev/null; do
      if ! kill -0 "$expected_parent" 2>/dev/null; then
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
' database-admission-payload "$owner_pid" "$ADMISSION_KILL_GRACE_SECS" "$@" &
payload_pid="$!"
payload_started_seconds="$SECONDS"
heartbeat_seconds=$(( (heartbeat_after_ms + 999) / 1000 ))
[ "$heartbeat_seconds" -gt 0 ] || heartbeat_seconds=1
next_heartbeat=$((SECONDS + heartbeat_seconds))
fence_lost=0

while payload_is_running; do
  if [ "$SECONDS" -ge "$next_heartbeat" ]; then
    if ! admission_post heartbeat "$fencing_token"; then
      fence_lost=1
      yield_reason="partition"
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
    next_heartbeat=$((SECONDS + heartbeat_seconds))
  fi
  sleep 1
done

if [ "$fence_lost" -eq 1 ]; then
  stop_payload
fi

set +e
wait "$payload_pid" 2>/dev/null
payload_rc="$?"
set -e
hold_ms="$(( (SECONDS - payload_started_seconds) * 1000 ))"

if [ "$enforced" -eq 1 ]; then
  admission_post release "$fencing_token" || true
fi
if [ "$fence_lost" -eq 1 ]; then
  emit_admission_event fenced "$hold_ms"
  exit 75
fi
emit_admission_event released "$hold_ms"
exit "$payload_rc"
