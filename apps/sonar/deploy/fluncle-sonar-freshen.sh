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
  emit_run_summary "$rc" || true
  _cleanup || true
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
  if [ -r "$SMOKE_STATE_PATH" ]; then
    SMOKE_STATE_READY=1
  else
    SMOKE_STATE_READY=0
    [ "$MODE" != "--dry-run" ] \
      || runtime_contract_fail "the configured durable state is not initialized; dry-run cannot perform the first guarded bootstrap"
  fi
}

# ── 1. what does the rolling release say was built? ───────────────────────────
# `sonar.commit` is the full commit SHA the published binary was built from — the
# artifact's identity, and the only thing that decides whether there is work to do.
# A missing/unreachable release is a NORMAL state (CI has not published yet, or
# GitHub is having a moment): log it, mark degraded, and leave the box alone.
mkdir -p "$STATE_DIR"
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
# ONE-TIME COMPATIBILITY BRIDGE: the predecessor remote-query runtime has no durable state to
# validate. Once the operator has installed the current unit + COMPLETE current environment,
# a real deploy (never --dry-run) may skip this isolated validation exactly while the configured
# state file is absent. The ordinary guarded swap then starts the candidate as the service user;
# Sonar performs its own bounded local bootstrap, and the existing post-smoke/rollback rail owns
# the verdict. This avoids the impossible demand that the old binary create the new binary's
# state, without teaching the updater to invent paths, copy credentials, or mutate the protocol
# itself. Every later deploy sees the state and returns to validate-only before swap.
presmoke_fail() {
  SF_ERRORS=$((SF_ERRORS + 1))
  alert "🛰️ sonar-freshen: PRE-SMOKE FAILED ($1) for ${NEW_SHA:0:12} on rave-01 — box untouched, staying on the current sonar binary"
  post_health degraded "a sonar update failed validation; the live engine is untouched on the current binary"
  die "pre-smoke failed: $1"
}

if [ "$SMOKE_STATE_READY" = "1" ]; then
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
  smoke_healthy() { curl -fsS -m 10 "http://127.0.0.1:$SMOKE_PORT/health" 2>/dev/null | grep -q '"ok":true'; }

  smoked=0
  for _ in $(seq 1 "$BOOT_TIMEOUT_SECS"); do
    if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
      # Include only the tail of the boot log: it is sonar's own tracing output (config
      # summary + counts), never a secret value.
      presmoke_fail "the new binary exited during boot ($(tr '\n' ' ' <"$SMOKE_LOG" | tail -c 200))"
    fi
    if smoke_healthy; then smoked=1; break; fi
    sleep 1
  done
  [ "$smoked" = "1" ] || presmoke_fail "the new binary did not serve a healthy /health within ${BOOT_TIMEOUT_SECS}s"
  cleanup_smoke
  _cleanup() { rm -rf "$WORK_DIR"; }
  log "pre-smoke passed"
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

# The live listener, read from the service env. Cloudflare proxies to this origin on
# 443 with an Origin Certificate, so TLS is normally on; a cert path in the env is what
# decides http vs https for the smoke below.
LIVE_PORT="$(env_value SONAR_PORT)"
LIVE_PORT="${LIVE_PORT:-443}"
LIVE_CURL=(curl -fsS -m 10)
LIVE_SCHEME="http"
if [ -n "$(env_value SONAR_TLS_CERT)" ]; then
  LIVE_SCHEME="https"
  # `-k` is CORRECT here, not a shortcut: the Origin Certificate's SAN is the public
  # hostname, so a loopback request legitimately mismatches the name. We are proving
  # the service answers, not validating Cloudflare's PKI. Do not "fix" this away.
  LIVE_CURL+=(-k)
fi
LIVE_CURL+=("$LIVE_SCHEME://127.0.0.1:$LIVE_PORT/health")
live_healthy() { "${LIVE_CURL[@]}" 2>/dev/null | grep -q '"ok":true'; }

if [ -f "$APP_BIN" ]; then
  cp -f "$APP_BIN" "$PREV_BIN" || {
    SF_ERRORS=$((SF_ERRORS + 1))
    die "could not snapshot the current binary to $PREV_BIN"
  }
fi
install -m 0755 "$NEW_BIN" "$APP_BIN.new"
mv -f "$APP_BIN.new" "$APP_BIN"

log "swapping $SERVICE to ${NEW_SHA:0:12} and restarting"
service_healthy() {
  systemctl restart "$SERVICE" || return 1
  # A restart validates and rebuilds the durable local corpus before /health answers,
  # so poll rather than sleeping a fixed beat.
  local i
  for ((i = 0; i < BOOT_TIMEOUT_SECS; i++)); do
    if ! systemctl is-active --quiet "$SERVICE"; then return 1; fi
    if live_healthy; then return 0; fi
    sleep 1
  done
  return 1
}

# ── 6. post-swap smoke (the `if` keeps set -e from bare-exiting) ──────────────
if service_healthy; then
  # The one place a swap is real: the backlog is cleared and the work is written.
  SF_PRODUCED=1
  SF_QUEUE=0
  log "post-swap smoke passed — deployed ${NEW_SHA:0:12}"
  printf '%s\n' "$NEW_SHA" >"$SHA_FILE"
  rm -f "$PREV_BIN"
  alert "🚀 sonar-freshen: deployed ${NEW_SHA:0:12} to sonar on rave-01 (CI artifact verified + swapped)"
  post_health ok "swapped sonar to the latest published build"
  exit 0
fi

# ── 7. ROLLBACK — the box is never left broken ────────────────────────────────
SF_ERRORS=$((SF_ERRORS + 1))
log "the new binary did not come up healthy — rolling back"
if [ -f "$PREV_BIN" ]; then
  install -m 0755 "$PREV_BIN" "$APP_BIN.rb"
  mv -f "$APP_BIN.rb" "$APP_BIN"
  if service_healthy; then
    rm -f "$PREV_BIN"
    alert "↩️ sonar-freshen: ${NEW_SHA:0:12} failed smoke on rave-01 — ROLLED BACK to the previous sonar binary (running). A human should look."
    post_health degraded "rolled back a failed sonar update; healthy on the previous binary"
    die "rolled back after a failed deploy"
  fi
fi
alert "🔴 sonar-freshen: ROLLBACK ALSO FAILED on rave-01 — sonar is DOWN. Operator needed NOW."
post_health down "the sonar engine is down after a failed update — operator needed"
die "rollback failed — sonar is down"
