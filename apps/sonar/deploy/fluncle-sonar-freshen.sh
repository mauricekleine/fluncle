#!/usr/bin/env bash
# fluncle-sonar-freshen — the rave-01 box's self-deploy for the sonar vector engine.
#
# Watches the rolling `sonar-latest` GitHub Release (published by
# .github/workflows/cli-release.yml after exact-SHA Quality validation for every merge that touches
# apps/sonar/**), and when it carries a commit the box has not deployed yet:
# downloads the static musl binary, VERIFIES its checksum, pre-smokes it in
# ISOLATION on a throwaway loopback port BEFORE the live one is touched, swaps it
# into the `sonar` systemd service, restarts, post-smokes, and auto-rolls-back to
# the prior binary on any failure. The box is never left broken.
#
# This is the sibling of apps/ssh/deploy/fluncle-ssh-freshen.sh (the public SSH
# terminal's self-deploy on the same box) and of docs/agents/hermes/pin-watch (the
# rave-02 Hermes self-deploy). It closes the gap where a merge to main did NOT
# reach the live sonar service until an operator cross-built on a Mac and scp'd it
# up by hand.
#
# THE ONE DELIBERATE DIVERGENCE FROM THE SSH SIBLING: sonar does NOT build on the
# box. The ssh freshen argues for an on-box `go build` because the Go toolchain is
# small and a build is ~10s; neither holds for Rust. A `cargo build --release` of
# sonar is ~7-14 min on this box's two shared vCPUs and needs a ~1.5GB toolchain on
# the deliberately-minimal public edge — which is simultaneously serving the SSH
# terminal, DNS, and sonar itself. So CI builds the artifact and the box only
# downloads + verifies + swaps. See apps/sonar/deploy/README.md for the full
# reasoning and the trust boundary that replaces "we built it ourselves".
#
# CREDENTIAL-FREE BY DESIGN: the repo is public, so the release assets are fetched
# by plain unauthenticated curl — no GitHub token on the box. The swap only
# REPLACES THE BINARY at /opt/sonar/sonar and restarts the service; the systemd
# unit and /etc/sonar.env (the service contract the operator established) are left
# untouched, so it reuses the env already on the box and reads nothing from `op`.
# The optional Discord-alert + /status-post inputs come from an operator-placed
# EnvironmentFile kept OUT of the repo; unset any of them and that best-effort
# visibility is simply skipped.
#
# Run by fluncle-sonar-freshen.timer (default: --if-changed, a no-op when current).
# Run once by hand with --force to clear accumulated debt and validate the recipe;
# run with --dry-run to download + verify + pre-smoke and STOP (the live service is
# never touched).
#
# ── WHY IT REPORTS A RUN (added 2026-07-29; RUN-01) ──────────────────────────
# This unit posted a /status row and a Discord line and nothing else — no record of a tick
# that RAN, only of one that had something to say. So the failure it cannot report is the one
# that matters: a release feed it never reached, tick after tick, while the box quietly stays
# behind. Every pass now ends with a JSON summary line and POSTs it to the run ledger.
# `checked` is the denominator (0 until the feed actually resolves a commit, so a blind tick
# is legible AS blind), `produced` counts a swap actually made, `queueDepth` a published build
# not yet on the box — the pair the ledger's `produced == 0 AND queueDepth > 0` alarm reads.
# `gateState` carries the third state that is neither ok nor down — a tick that skipped on the
# lock (`locked`), or an operator's `--dry-run` (`dry-run`) — so a tick that deliberately did not
# deploy never trips the alarm. It speaks the ledger's own CLOSED vocabulary (the six words of
# the `run_events.gate_state` enum); a word of this script's own invention is rejected at the
# edge and the row goes missing, which is the failure the ledger exists to end. The two words
# are not interchangeable: the Worker suppresses a gated run's work counters to `null` only for
# the gates that NEVER LOOKED, and `dry-run` is deliberately NOT one of them, so calling a dry
# run `paused` would erase the `checked:1` that proves it read the feed. Counters report `null`
# when this run never got to try and `0` when it tried and found nothing — the two are
# different facts and the ledger keeps them apart.
#
# Doctrine: apps/sonar/deploy/README.md.
set -euo pipefail

# ── config (overridable via the env) ──────────────────────────────────────────
# The rolling pre-release the CI workflow publishes. Public repo ⇒ the download
# host needs no credential; `.../releases/download/<tag>/<asset>` is a plain GET.
RELEASE_REPO="${SONARFRESHEN_RELEASE_REPO:-mauricekleine/fluncle}"
RELEASE_TAG="${SONARFRESHEN_RELEASE_TAG:-sonar-latest}"
ASSET_BASE="${SONARFRESHEN_ASSET_BASE:-https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}}"

STATE_DIR="${SONARFRESHEN_STATE_DIR:-/opt/sonar-freshen}"
SHA_FILE="${SONARFRESHEN_SHA_FILE:-$STATE_DIR/deployed-sha}"
BOOTSTRAP_READY_FILE="${SONARFRESHEN_BOOTSTRAP_READY_FILE:-$STATE_DIR/local-state-ready}"
ROLLBACK_INTENT_FILE="${SONARFRESHEN_ROLLBACK_INTENT_FILE:-$STATE_DIR/swap-in-progress}"
STATE_ROLLBACK_FILE="${SONARFRESHEN_STATE_ROLLBACK_FILE:-$STATE_DIR/local-state.rollback}"
LOCK="${SONARFRESHEN_LOCK:-/run/lock/fluncle-sonar-freshen.lock}"

# The live service contract (must match apps/sonar/deploy/sonar.service).
SERVICE="${SONARFRESHEN_SERVICE:-sonar}"
APP_DIR="${SONARFRESHEN_APP_DIR:-/opt/sonar}"
APP_BIN="${SONARFRESHEN_APP_BIN:-$APP_DIR/sonar}"
PREV_BIN="$APP_BIN.prev"
SERVICE_ENV="${SONARFRESHEN_SERVICE_ENV:-/etc/sonar.env}"

# How long to wait for an index load. sonar reads the WHOLE embedding corpus out of
# Turso and builds both in-memory indexes before it serves /health — ~30s at today's
# corpus and it grows with the archive, so this is deliberately generous. Applied to
# both the isolated pre-smoke and the post-swap wait.
BOOT_TIMEOUT_SECS="${SONARFRESHEN_BOOT_TIMEOUT_SECS:-180}"

# Optional alert/status inputs (operator EnvironmentFile; all best-effort, all optional).
WORKER_URL="${SONARFRESHEN_WORKER_URL:-https://www.fluncle.com}"
# The run ledger reads the Worker base from the name every other box script uses. Point it at
# the SAME Worker the /status post already targets, so an operator override moves both at once
# and the two can never disagree about which Worker this box is talking to. `-` NOT `:-`, for
# the reason spelled out in the mirrored block below: an EXPLICITLY EMPTY base has to survive
# to the emitter's guard as empty, or "post nowhere" silently becomes "post at production".
FLUNCLE_API_BASE_URL="${FLUNCLE_API_BASE_URL-$WORKER_URL}"

MODE="--if-changed"
case "${1:-}" in
  --force) MODE="--force" ;;     # redeploy regardless of the recorded SHA (the operator pilot)
  --dry-run) MODE="--dry-run" ;; # download + verify + pre-smoke, then STOP (never swap)
esac

log() { printf '[sonar-freshen] %s\n' "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

# ── the run ledger (RUN-01) ───────────────────────────────────────────────────
# `RUN_EVENT_INTERVAL_MS` MIRRORS this unit's own timer (`OnUnitActiveSec=1h` in
# fluncle-sonar-freshen.timer); run-events.test.ts parses that file and pins the pair.
RUN_EVENT_UNIT="fluncle-sonar-freshen"
RUN_EVENT_INTERVAL_MS=3600000

# `null` = this run never got that far; a NUMBER = it tried and this is what it found. The
# distinction is the whole point — `0` for "nothing published" and `0` for "never reached the
# feed" would be the same green row otherwise.
SF_CHECKED="null"
SF_PRODUCED="null"
SF_QUEUE="null"
SF_ERRORS=0
# `gateState` speaks the ledger's CLOSED enum — `active` / `disabled` / `dry-run` / `forced` /
# `locked` / `paused`, mirroring the `run_events.gate_state` column. A word outside that set is
# rejected by the Worker, and a rejected POST leaves no row at all. This script reaches for two
# of them: `locked` (the lock-held tick, which looked at nothing) and `dry-run` (which looked and
# then declined to write). Use the PRECISE one — the Worker nulls the work counters of the
# never-looked gates only, so the choice decides whether this tick's `checked` survives.
SF_GATE="null" # `"locked"` or `"dry-run"` once this tick has decided not to deploy
SF_SUMMARY_EMITTED=0
SF_STARTED_AT=""
ROLLBACK_ARMED=0
BOOTSTRAP_MARKER_CREATED=0
PRIOR_LIVE_SHA=""

# >>> BEGIN MIRRORED BLOCK: record_run_event — keep BYTE-IDENTICAL across all four copies >>>
# The run-ledger emitter. FOUR scripts carry this block verbatim, because they run on two
# different boxes with no shared bash library between them: the ~41 container sweeps get it by
# sourcing this file, and the three host units are each laid down as a lone file
# (install-host-timers.sh copies only the script an ExecStart names; the sonar freshen lives on
# another box entirely). `run-events.test.ts` compares the four copies byte for byte, so a
# silent drift fails the build — the same mirror-plus-drift-test posture cost-emit.ts already
# uses for the cost ledger.
#
# THE CONTRACT is owned by the agent-tier `record_run` oRPC op in
# packages/contracts/src/orpc/admin-telemetry.ts, which a box script cannot import. Mirrored
# here: the endpoint path, the five body fields, and the Bearer auth. If any of them changes in
# the workspace, change it in all four copies.
#
# THE DRIFT TEST IS NOT ENOUGH ON ITS OWN, and this cost a shipped bug: the four copies once
# agreed with EACH OTHER on `/api/v1/admin/runs/events` while the contract declared
# `/admin/telemetry/runs`, so every POST 404'd, the `|| true` swallowed it, the ledger stayed
# empty, and both test suites were green. Byte-equality is a closed loop. So run-events.test.ts
# now RESOLVES this path against the workspace's own surfaces (the contract op paths + the
# `apps/web/src/routes/api/**` file routes) — the assertion that crosses the boundary.
#
# THE BODY CARRIES FACTS ONLY. There is no `ok` field, deliberately: the Worker derives it as
# `exit_code === 0 && (summary.errors ?? 0) === 0`. The nightly Sentry sweep exited 0 for
# eleven nights while printing `{"errors":2,"ok":true}` — a hardcoded literal sitting beside
# the number that contradicted it — so a self-reported `ok` is exactly the thing this ledger
# must not accept.
#
# BEST-EFFORT, ALWAYS: the caller's exit code is never touched and the whole thing is
# hard-timeout bounded. Delivery failure is returned, not swallowed here: the caller decides
# how to surface it without turning a telemetry outage into a failed sweep. The reason is a
# public-safe enum-like string, never a URL, response body, or token.
RUN_EVENT_PATH='/api/v1/admin/telemetry/runs'
# 5s, NOT cost-emit.ts's 15s. That budget was sized for a contended `insert into settings`
# measured at ~8.9s p95 on the PRIMARY database; this is one small insert into the separate
# `fluncle-telemetry` database, which exists precisely so it never queues behind the primary's
# single writer. 5s absorbs a cold isolate plus a slow tick and still sits two orders inside
# the shortest unit TimeoutStartSec on either box.
RUN_EVENT_TIMEOUT_SECS="${RUN_EVENT_TIMEOUT_SECS:-5}"
RUN_EVENT_FAILURE_REASON=""

# Escape one line for a JSON string literal, in pure bash parameter expansion — NOT
# `sed -e 's/\t/\\t/'`, whose `\t` is a GNU extension that silently matches a literal `t` on
# the BSD sed the tests run under. Capped at 4000 chars so a runaway line cannot inflate the
# POST, and stripped of any remaining control character (raw ones are illegal in JSON).
_run_event_json_string() {
  local s="${1:0:4000}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  printf '%s' "$s" | tr -d '\000-\037'
}

# record_run_event <unit> <started_at> <ended_at> <exit_code> <summary_raw>
record_run_event() {
  local unit="$1" started_at="$2" ended_at="$3" exit_code="$4" summary_raw="$5"
  local base token body
  RUN_EVENT_FAILURE_REASON=""
  # `-` NOT `:-`, deliberately. With the colon an EMPTY base fell back to the production
  # URL, which made the guard two lines down unreachable and fired a real POST at
  # www.fluncle.com from every `bun run test:scripts` — in CI and in the deploy gate. An
  # empty base means THERE IS NO LEDGER HERE, and the guard is the line that says so.
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

# The box clock, in the one format every copy sends. DISTINCT from the Worker's own write
# time: a box row's `occurred_at` legitimately precedes its `created_at` under clock skew, and
# the ledger keeps both. Seconds precision on purpose — `date +%3N` is GNU-only.
run_event_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}
# <<< END MIRRORED BLOCK: record_run_event <<<

# Print the run's summary line and POST its envelope, exactly once, from whichever of this
# script's many exit paths got here — the `die`s included, which is where the interesting
# failures are. The summary LINE uses the fleet's camelCase counter names; the POST BODY uses
# the ledger contract's snake_case fields.
#
# THE LINE STATES NO `ok`. It has every fact needed to compute one and deliberately computes
# none: the verdict is `exit_code == 0 && errors == 0`, the Worker owns it, and a summary that
# grades itself is rejected at the edge. This script exits 0 on a dead release feed BY DESIGN,
# which is exactly the shape a self-reported `ok` would have painted green.
#
# It goes to STDOUT while every other line here goes to stderr, deliberately: the ledger reads
# the last non-empty STDOUT line, so the script's own chatter can never be mistaken for its
# verdict.
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

# ONE exit trap for the whole script: the summary always runs, and `_cleanup` is re-pointed as
# resources appear rather than each of them installing its own `trap … EXIT` (which would
# silently replace the summary).
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

# ── single-flight ─────────────────────────────────────────────────────────────
# A tick that finds the lock held is NEITHER ok nor down — it is gated, and its counters stay
# `null` because it never looked at anything. Reported, not silent: an unbroken run of
# lock-skips is itself a finding (a wedged predecessor holding the flock forever).
exec 9>"$LOCK"
flock -n 9 || {
  log "another run holds the lock; exiting"
  # This tick looked at nothing, so its counters stay `null` and the gate says it did not run.
  # `locked` is the ledger's word for exactly this tick, and it is one of the gates the Worker
  # treats as NEVER LOOKED — which is what makes the `null` counters above correct rather than
  # laundered.
  SF_GATE='"locked"'
  exit 0
}

# Past the gate: this tick is really going to look, so the counters become numbers. They stay
# 0 until something is actually found, which is what makes `checked:0` legible as "reached the
# end of the run without ever resolving a published commit" rather than "never ran".
SF_CHECKED=0
SF_PRODUCED=0
SF_QUEUE=0

command -v curl >/dev/null || {
  SF_ERRORS=$((SF_ERRORS + 1))
  die "curl not found"
}

# ── Discord alert (best-effort; webhook from the operator EnvironmentFile). Never throws. ──
alert() {
  [ -n "${DISCORD_ALERT_WEBHOOK:-}" ] || return 0
  curl -fsS -m 10 -H 'Content-Type: application/json' \
    -d "$(printf '{"content":%s}' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')")" \
    "${DISCORD_ALERT_WEBHOOK}" >/dev/null 2>&1 || true
}

# Self-deploy health → the public /status board (the `self-deploy-sonar` row, beside
# `self-deploy-ssh` on the same box). Best-effort, never throws; the message is
# public-safe and deliberately vague (no host, no raw error). status ∈ ok|degraded|down.
# Needs the agent token + worker URL from the operator EnvironmentFile; unset → skipped.
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
        4??) log "record_health rejected the snapshot (best-effort, not replayed)"; return 0 ;;
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
      *) log "record_health reconciliation unavailable; snapshot was not replayed"; return 0 ;;
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

# Read one KEY=value out of the live service's EnvironmentFile WITHOUT sourcing it
# (never executes the file — it is systemd's format, not shell). Strips one layer of
# surrounding quotes. Values here are secrets: they are passed straight into the
# pre-smoke's environment and NEVER logged.
env_value() {
  [ -r "$SERVICE_ENV" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$SERVICE_ENV" 2>/dev/null | tail -1 \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# The local-replica runtime is an atomic contract: validate-only needs the durable state,
# while the post-swap service needs every replica + artifact-consumer input below. An older
# remote-query deployment has only TURSO_* + SONAR_SECRET, so letting it reach the download
# and pre-smoke would spend bandwidth before failing; letting a partially migrated contract
# reach the swap would be worse. Detect both states before the candidate binary is downloaded.
# Variable NAMES are public configuration; values are read only into the candidate's
# environment and are never logged.
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

# Rollback recovery must exist before the release feed is read: a hard kill or
# reboot cannot run EXIT, and the next tick must restore the snapshotted binary
# before an already-current no-op or a new snapshot can overwrite that evidence.
LIVE_PORT="$(env_value SONAR_PORT)"
LIVE_PORT="${LIVE_PORT:-443}"
LIVE_CURL=(curl -fsS -m 10)
LIVE_SCHEME="http"
if [ -n "$(env_value SONAR_TLS_CERT)" ]; then
  LIVE_SCHEME="https"
  # The origin certificate names the public host, not loopback. This probe proves
  # process health after restart; Cloudflare owns the public PKI check.
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
  if ! printf '%s\n' "$commit" >"$sha_tmp" \
    || ! durable_sync_file "$sha_tmp" \
    || ! mv -f "$sha_tmp" "$SHA_FILE" \
    || ! durable_sync_file "$SHA_FILE"; then
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
    "$NEW_SHA" "$BOOTSTRAP_READY" "$PRIOR_LIVE_SHA" "$state_ready" "$state_present" "$accepted" >"$intent_tmp" \
    || ! durable_sync_file "$intent_tmp" \
    || ! mv -f "$intent_tmp" "$ROLLBACK_INTENT_FILE" \
    || ! durable_sync_file "$ROLLBACK_INTENT_FILE"; then
    rm -f "$intent_tmp"
    return 1
  fi
}

snapshot_local_state() {
  local source="$SMOKE_STATE_PATH" suffix source_file backup_file state_present=0
  rm -f "$STATE_ROLLBACK_FILE" "${STATE_ROLLBACK_FILE}-wal" "${STATE_ROLLBACK_FILE}-shm" \
    || return 1
  durable_sync_dir "$STATE_DIR" || return 1
  if [ -e "$source" ]; then state_present=1; fi
  for suffix in '' '-wal' '-shm'; do
    source_file="${source}${suffix}"
    backup_file="${STATE_ROLLBACK_FILE}${suffix}"
    [ -e "$source_file" ] || continue
    # The freshener runs as root while sonar.service runs as User=sonar. Preserve
    # ownership and mode so a rollback never restores correct bytes the service cannot open.
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
  rm -f "$STATE_ROLLBACK_FILE" "${STATE_ROLLBACK_FILE}-wal" "${STATE_ROLLBACK_FILE}-shm" \
    || cleanup_failed=1
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
  if [ "$(intent_value accepted)" = "1" ] \
    && printf '%s' "$candidate" | grep -Eq '^[0-9a-f]{40}$' \
    && [ "$recorded" = "$candidate" ] \
    && live_healthy "$candidate"; then
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

# ── 1. what does the rolling release say was built? ───────────────────────────
# `sonar.commit` is the full commit SHA the published binary was built from — the
# artifact's identity, and the only thing that decides whether there is work to do.
# A missing/unreachable release is a NORMAL state (CI has not published yet, or
# GitHub is having a moment): log it, mark degraded, and leave the box alone.
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

# An unreachable or malformed feed exits 0 ON PURPOSE (leave the box alone), and that is
# exactly why it has to be COUNTED: a green exit code beside a nonzero error count must not
# read green anywhere. `checked` stays 0 — this run resolved no published commit — so seven
# days of a dead feed are legible as seven days of blindness rather than seven quiet successes.
if ! curl -fsSL --retry 3 --retry-delay 2 -m 60 -o "$WORK_DIR/sonar.commit" "$ASSET_BASE/sonar.commit"; then
  SF_ERRORS=$((SF_ERRORS + 1))
  log "could not fetch $ASSET_BASE/sonar.commit — leaving the live service alone"
  post_health degraded "the sonar release feed is unreachable; the live engine is untouched"
  exit 0
fi

NEW_SHA="$(tr -d '[:space:]' <"$WORK_DIR/sonar.commit")"
# Guard against an HTML error page or a truncated asset masquerading as a SHA.
if ! printf '%s' "$NEW_SHA" | grep -Eq '^[0-9a-f]{40}$'; then
  SF_ERRORS=$((SF_ERRORS + 1))
  log "the published sonar.commit is not a commit SHA — refusing to act on it"
  post_health degraded "the sonar release feed looks malformed; the live engine is untouched"
  exit 0
fi

# The feed resolved a real commit: this run genuinely checked the published build.
SF_CHECKED=1

OLD_SHA="$(cat "$SHA_FILE" 2>/dev/null || true)"
if ! printf '%s' "$OLD_SHA" | grep -Eq '^[0-9a-f]{40}$'; then OLD_SHA=''; fi

# ── 2. decide whether to deploy ───────────────────────────────────────────────
# Deploy when: --force; OR there is no recorded baseline (first run); OR the published
# artifact was built from a different commit than the one on the box. A merge that
# changed no sonar source publishes nothing, so this is a cheap no-op most ticks.
# --dry-run deliberately skips the already-current short-circuit: it never touches the
# live service, so "preview the current release" should stay useful on a current box.
if [ "$MODE" = "--force" ]; then
  # NO gate on a force. It is a real deploy that really swaps, and the ledger NULLS a gated
  # run's work counters — gating this would erase the `produced:1` that proves it happened.
  # It cannot raise a false alarm either: a forced swap ends `produced:1, queueDepth:0`.
  reason="forced"
elif [ "$MODE" = "--dry-run" ]; then
  # Gated: it verifies and pre-smokes and then deliberately leaves the build undeployed, so
  # `produced:0` beside `queueDepth:1` is the operator's choice rather than a stalled box.
  # `dry-run`, NOT `paused`: this tick DID look, and the Worker keeps a looking gate's counters
  # while nulling a never-looked one's. `paused` here would erase the `checked:1` below.
  reason="dry run"
  SF_GATE='"dry-run"'
elif [ -z "$OLD_SHA" ]; then
  reason="no baseline (first run)"
elif [ "$OLD_SHA" = "$NEW_SHA" ]; then
  # The overwhelmingly common tick: checked 1, produced 0, queue 0. Nothing to do is not the
  # same fact as nothing done, and the ledger's alarm conjunction leaves this one alone.
  log "${OLD_SHA:0:12} -> ${NEW_SHA:0:12} | already current — no-op"
  post_health ok "sonar current"
  exit 0
else
  reason="a newer sonar build is published"
fi
# There is work on the table from here down. Until the swap lands it is BACKLOG, so an
# abandoned deploy leaves `produced:0` beside `queueDepth:1` — the pair that alarms.
# A `--dry-run` carries a `gateState`, so a preview that leaves the backlog standing is never
# read as a stalled deploy.
SF_QUEUE=1
log "${OLD_SHA:-<none>} -> $NEW_SHA | $reason"

runtime_contract_fail() {
  SF_ERRORS=$((SF_ERRORS + 1))
  alert "🛰️ sonar-freshen: RUNTIME CONTRACT NOT READY for ${NEW_SHA:0:12} on rave-01 — box untouched, staying on the current sonar binary"
  post_health degraded "a sonar update is waiting for its local runtime contract; the live engine is untouched"
  die "$1"
}

# A release may be newer while the host still carries the predecessor's remote-query
# configuration. Refuse before fetching/executing the candidate; this is a provisioning
# boundary, not something a binary updater may silently invent or mutate. A COMPLETE current
# contract with no state file is different: the guarded swap below may perform Sonar's own
# first bootstrap under systemd and roll back the binary if that bootstrap does not go healthy.
require_local_runtime_contract

# ── 3. download + VERIFY (the trust boundary) ─────────────────────────────────
# The box did not build this binary, so the checksum IS the trust boundary that
# replaces "we compiled it ourselves". A mismatch means the artifact is corrupt or
# tampered with: fail LOUDLY and never, under any mode, put it near the live service.
download_fail() {
  SF_ERRORS=$((SF_ERRORS + 1))
  alert "🛰️ sonar-freshen: DOWNLOAD/VERIFY FAILED ($1) for ${NEW_SHA:0:12} on rave-01 — box untouched, staying on the current sonar binary"
  post_health degraded "a sonar update failed download or checksum verification; the live engine is untouched"
  die "download/verify failed: $1"
}

NEW_BIN="$WORK_DIR/sonar"
curl -fsSL --retry 3 --retry-delay 2 -m 600 -o "$NEW_BIN" "$ASSET_BASE/sonar" \
  || download_fail "could not download the binary"
curl -fsSL --retry 3 --retry-delay 2 -m 60 -o "$WORK_DIR/sonar.sha256" "$ASSET_BASE/sonar.sha256" \
  || download_fail "could not download the checksum"

# The checksum file is `<sha256>  sonar` (sha256sum's own format), so `-c` verifies
# the name AND the digest from inside the download dir. shasum is the fallback for a
# box without coreutils' sha256sum.
verify_checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$WORK_DIR" && sha256sum -c sonar.sha256 ) >/dev/null 2>&1
  elif command -v shasum >/dev/null 2>&1; then
    ( cd "$WORK_DIR" && shasum -a 256 -c sonar.sha256 ) >/dev/null 2>&1
  else
    return 2 # no verifier at all — treated as a hard failure below, never a skip
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

# ── 4. PRE-SMOKE the new binary in ISOLATION (live service untouched) ─────────
# Boot the new binary on a free high loopback port with TLS DISABLED (no cert/key in
# its env ⇒ sonar serves plain HTTP; see apps/sonar/src/config.rs) in validate-only
# mode against the durable local state, then poll /health. Validate-only performs no
# state mutation, replica open/sync, consumer registration, change read, checkpoint,
# or acknowledgement.
# This proves the binary runs on this CPU (a bad -C target-cpu would SIGILL here,
# with the live service untouched), validates the durable raw vectors, builds both
# in-memory indexes, and serves HTTP.
#
# MEMORY: for the duration of this smoke the box holds TWO full copies of the index —
# the live one and the smoke's. Headroom must exceed 2x the index (see the README).
# Validate-only starts no consumer loop; the process is reaped when the smoke resolves.
#
# ONE-TIME COMPATIBILITY BRIDGE: the predecessor remote-query runtime has no completed state to
# validate. Once the operator has installed the current unit + COMPLETE current environment, a
# real deploy (never --dry-run) may defer isolated validation to the guarded service swap. Sonar
# performs its own bounded local bootstrap, and the existing post-smoke/rollback rail owns the
# verdict. A failed bootstrap can leave a readable SQLite file before its manifest is complete,
# so FILE EXISTENCE IS NEVER READINESS. The freshener writes BOOTSTRAP_READY_FILE only after the
# post-swap service is healthy. Before that marker exists, a readable state gets one validate-only
# attempt: success proves a prior bootstrap completed despite a crash before the marker; failure
# is treated as retryable partial bootstrap and returns to the guarded swap. Once marked ready,
# any validation failure is an ordinary hard pre-smoke failure.
presmoke_fail() {
  SF_ERRORS=$((SF_ERRORS + 1))
  alert "🛰️ sonar-freshen: PRE-SMOKE FAILED ($1) for ${NEW_SHA:0:12} on rave-01 — box untouched, staying on the current sonar binary"
  post_health degraded "a sonar update failed validation; the live engine is untouched on the current binary"
  die "pre-smoke failed: $1"
}

if [ "$SMOKE_STATE_PRESENT" = "1" ]; then
  # Pick a free high loopback port (bash /dev/tcp probe; no external tool needed).
  port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
  SMOKE_PORT=""
  for p in 42480 42481 42482 42483 42484; do
    if port_free "$p"; then SMOKE_PORT="$p"; break; fi
  done
  [ -n "$SMOKE_PORT" ] || presmoke_fail "no free loopback port for the isolated boot"

  SMOKE_LOG="$WORK_DIR/boot.log"
  SONAR_STATE_PATH="$SMOKE_STATE_PATH" \
    SONAR_VALIDATE_ONLY=true \
    SONAR_SECRET="$SMOKE_SECRET" SONAR_BIND=127.0.0.1 SONAR_PORT="$SMOKE_PORT" \
    SONAR_TLS_CERT='' SONAR_TLS_KEY='' \
    "$NEW_BIN" >"$SMOKE_LOG" 2>&1 &
  SMOKE_PID=$!
  # Always reap the throwaway server — it holds a second full copy of the index in RAM.
  cleanup_smoke() { kill "$SMOKE_PID" >/dev/null 2>&1 || true; wait "$SMOKE_PID" 2>/dev/null || true; }
  _cleanup() { cleanup_smoke; rm -rf "$WORK_DIR"; }

  # sonar's /health serialises `"ok":true` with no spaces (serde), so one grep is the
  # whole assertion: the process is up AND its indexes are built AND it answers HTTP.
  smoke_healthy() {
    local body health_rc=0
    body="$(curl -fsS -m 10 "http://127.0.0.1:$SMOKE_PORT/health" 2>/dev/null)" || return 1
    printf '%s' "$body" | health_matches "$NEW_SHA" || health_rc=$?
    if [ "$health_rc" -eq 2 ]; then
      SMOKE_IDENTITY_MISMATCH=1
      return 1
    fi
    [ "$health_rc" -eq 0 ]
  }

  smoked=0
  SMOKE_IDENTITY_MISMATCH=0
  smoke_failure=""
  for _ in $(seq 1 "$BOOT_TIMEOUT_SECS"); do
    if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
      # Include only the tail of the boot log: it is sonar's own tracing output (config
      # summary + counts), never a secret value.
      smoke_failure="the new binary exited during boot ($(tr '\n' ' ' <"$SMOKE_LOG" | tail -c 200))"
      break
    fi
    if smoke_healthy; then smoked=1; break; fi
    if [ "$SMOKE_IDENTITY_MISMATCH" = "1" ]; then break; fi
    sleep 1
  done
  cleanup_smoke
  _cleanup() { rm -rf "$WORK_DIR"; }
  [ "$SMOKE_IDENTITY_MISMATCH" = "0" ] \
    || presmoke_fail "the downloaded binary reports a different baked commit than sonar.commit"
  if [ "$smoked" = "1" ]; then
    log "pre-smoke passed"
  else
    [ -n "$smoke_failure" ] \
      || smoke_failure="the new binary did not serve a healthy /health within ${BOOT_TIMEOUT_SECS}s"
    if [ "$BOOTSTRAP_READY" = "1" ]; then
      presmoke_fail "$smoke_failure"
    fi
    [ "$MODE" != "--dry-run" ] \
      || runtime_contract_fail "the unmarked durable state did not validate; dry-run cannot retry its bootstrap"
    log "unmarked durable state did not validate; retrying the incomplete bootstrap through the guarded service swap"
  fi
else
  log "durable state is not initialized; deferring the one-time bootstrap to the guarded service swap"
fi

if [ "$MODE" = "--dry-run" ]; then
  log "dry-run: ${NEW_SHA:0:12} downloaded, verified and pre-smoked; leaving the live service untouched"
  exit 0
fi

# ── 5. swap (the only moment the live service is touched) ─────────────────────
# Keep the current binary as the rollback target, then atomically replace the live
# binary (rename on the same filesystem) and restart. Replacing the on-disk file under
# the running process is safe on Linux (the old process holds its inode until restart).
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
  # Disarm before doing work so an error or signal inside rollback never recurses
  # through the same candidate restore.
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
# From this point until post-swap acceptance, every exit path—including TERM and
# set -e failures—must restore the snapshotted binary. The one process-wide EXIT
# trap owns rollback so later cleanup hooks cannot accidentally replace it.
ROLLBACK_ARMED=1
if ! systemctl stop "$SERVICE" || ! snapshot_local_state; then
  die "could not capture a durable local-state rollback snapshot"
fi
install -m 0755 "$NEW_BIN" "$APP_BIN.new"
durable_sync_file "$APP_BIN.new"
mv -f "$APP_BIN.new" "$APP_BIN"
durable_sync_file "$APP_BIN"

log "swapping $SERVICE to ${NEW_SHA:0:12} and restarting"

# ── 6. post-swap smoke (the `if` keeps set -e from bare-exiting) ──────────────
if service_healthy "$NEW_SHA" && mark_bootstrap_ready; then
  # Health plus the durable bootstrap marker is the acceptance boundary. Only
  # after the candidate identity is durable may EXIT stop restoring the prior generation.
  write_deployed_sha "$NEW_SHA" || die "could not persist the accepted sonar commit"
  mark_rollback_intent_accepted || die "could not persist the accepted sonar swap marker"
  ROLLBACK_ARMED=0
  # The one place a swap is real: the backlog is cleared and the work is written.
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

# ── 7. ROLLBACK — the box is never left broken ────────────────────────────────
die "the new binary did not satisfy the post-swap acceptance contract"
