#!/usr/bin/env bash
# fluncle-secrets-sync.sh — materialize the box's secrets from 1Password (the single
# source). Reads OP_SERVICE_ACCOUNT_TOKEN from /etc/hermes-bootstrap.env, op-injects
# the gateway env-file + the shared sweep-secrets file (written into the mounted
# state dir the hermes container sees). Atomic (temp -> install) + sanity-checked, so
# an op outage can never leave a partial/empty secrets file. Run at boot + on a timer.
#
# ── WHY IT REPORTS A RUN (added 2026-07-29; RUN-01) ───────────────────────────
# This unit is the one every sweep depends on and it wrote no run record of any kind: a
# `journalctl` line nobody reads, and nothing on /status. A silent failure here does not
# break loudly — it leaves the box holding STALE credentials, and every sweep downstream
# keeps reporting its own cheerful `ok` until a token expires. So every pass now ends with a
# JSON summary line — `checked` (secret targets attempted), `produced` (files actually
# installed), `errors`, `queueDepth` (targets left unwritten) — and POSTs that line to the
# run ledger. `ok` is DERIVED from the exit code and the error count, never a literal.
set -euo pipefail

# Every path is overridable so the whole script can be driven end to end by its test against
# a scratch tree; the DEFAULTS are exactly the box's real paths, so a real run is unchanged.
BOOTSTRAP="${SECRETS_SYNC_BOOTSTRAP:-/etc/hermes-bootstrap.env}"
TPL_DIR="${SECRETS_SYNC_TPL_DIR:-/etc/hermes}"
GATEWAY_OUT="${SECRETS_SYNC_GATEWAY_OUT:-/etc/hermes.env}"
SWEEP_OUT="${SECRETS_SYNC_SWEEP_OUT:-/home/admin/.hermes/home/.fluncle-secrets.env}" # = /opt/data/home/.fluncle-secrets.env in-container

# What this run reports as. `RUN_EVENT_INTERVAL_MS` MIRRORS this unit's own timer
# (`OnUnitActiveSec=15min` in fluncle-secrets-sync.timer); run-events.test.ts parses that file
# and pins the pair in lockstep, so a cadence change cannot silently teach the ledger the
# wrong freshness budget.
RUN_EVENT_UNIT="fluncle-secrets-sync"
RUN_EVENT_INTERVAL_MS=900000

# The run's tally. `CHECKED` counts every secret target this run set out to write — the
# denominator, so a run that attempts nothing can never read as a clean sync.
CHECKED=0
PRODUCED=0
ERRORS=0
SUMMARY_EMITTED=0
STARTED_AT=""

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
# packages/contracts/src/orpc/, which a box script cannot import. Mirrored here: the endpoint
# path, the five body fields, and the Bearer auth. If any of them changes in the workspace,
# change it in all four copies (the drift test keeps them equal; only the workspace can tell
# you they are RIGHT).
#
# THE BODY CARRIES FACTS ONLY. There is no `ok` field, deliberately: the Worker derives it as
# `exit_code === 0 && (summary.errors ?? 0) === 0`. The nightly Sentry sweep exited 0 for
# eleven nights while printing `{"errors":2,"ok":true}` — a hardcoded literal sitting beside
# the number that contradicted it — so a self-reported `ok` is exactly the thing this ledger
# must not accept.
#
# BEST-EFFORT, ALWAYS: no token or an empty base URL ⇒ silently skipped; every curl failure is
# swallowed; the caller's exit code is never touched; the whole thing is hard-timeout bounded.
# It is deliberately SILENT rather than logging a failure — a chatty retry line would land in
# the marker's stderr tail and score against the strain detector. A dropped POST leaves a
# missing row, a missing row reads as a missed run, and the roster alarms on that. Absence
# being loud is why delivery need not be guaranteed.
RUN_EVENT_PATH='/api/v1/admin/runs/events'
# 5s, NOT cost-emit.ts's 15s. That budget was sized for a contended `insert into settings`
# measured at ~8.9s p95 on the PRIMARY database; this is one small insert into the separate
# `fluncle-telemetry` database, which exists precisely so it never queues behind the primary's
# single writer. 5s absorbs a cold isolate plus a slow tick and still sits two orders inside
# the shortest unit TimeoutStartSec on either box.
RUN_EVENT_TIMEOUT_SECS="${RUN_EVENT_TIMEOUT_SECS:-5}"

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
  base="${FLUNCLE_API_BASE_URL:-https://www.fluncle.com}"
  base="${base%/}"
  token="${FLUNCLE_API_TOKEN:-}"
  [ -n "$token" ] || return 0
  [ -n "$base" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  case "$exit_code" in '' | *[!0-9]*) exit_code=0 ;; esac
  body="$(printf '{"unit":"%s","started_at":"%s","ended_at":"%s","exit_code":%s,"summary_raw":"%s"}' \
    "$(_run_event_json_string "$unit")" \
    "$(_run_event_json_string "$started_at")" \
    "$(_run_event_json_string "$ended_at")" \
    "$exit_code" \
    "$(_run_event_json_string "$summary_raw")")"
  curl -s -o /dev/null --max-time "$RUN_EVENT_TIMEOUT_SECS" \
    -X POST -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${token}" \
    --data-binary "$body" "${base}${RUN_EVENT_PATH}" >/dev/null 2>&1 || true
  return 0
}

# The box clock, in the one format every copy sends. DISTINCT from the Worker's own write
# time: a box row's `occurred_at` legitimately precedes its `created_at` under clock skew, and
# the ledger keeps both. Seconds precision on purpose — `date +%3N` is GNU-only.
run_event_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}
# <<< END MIRRORED BLOCK: record_run_event <<<

# The agent token this script POSTs with, read out of the sweep-secrets file it maintains —
# so it introduces NO new credential and nothing from `op` beyond what it already handles.
# Read ONCE, at emit time, which covers both cases without a second read: the file is only
# ever replaced by an atomic `install`, so a run that dies at `op inject` still finds LAST
# sync's token on disk and can report its own failure, and a run that got as far as installing
# finds the freshly-rotated one. Never echoed, never logged, never passed on a command line.
read_secret_token() {
  [ -r "$SWEEP_OUT" ] || return 0
  sed -n 's/^[[:space:]]*FLUNCLE_API_TOKEN=//p' "$SWEEP_OUT" 2>/dev/null | tail -1 \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" || true
}

# Print the run's summary line and POST its envelope, exactly once, whatever exit path got
# here — including the `set -e` aborts, which is where the interesting failures are. The
# summary LINE uses the fleet's camelCase counter names (every other sweep prints them that
# way); the POST BODY uses the ledger contract's snake_case fields.
emit_run_summary() {
  local rc="${1:-0}" ok="false" queue=0 ended summary
  if [ "$SUMMARY_EMITTED" = "1" ]; then return 0; fi
  SUMMARY_EMITTED=1
  case "$rc" in '' | *[!0-9]*) rc=0 ;; esac
  if [ "$rc" -eq 0 ] && [ "$ERRORS" -eq 0 ]; then ok="true"; fi
  queue=$((CHECKED - PRODUCED))
  [ "$queue" -ge 0 ] || queue=0
  ended="$(run_event_now)"
  summary="$(printf '{"ok":%s,"checked":%d,"produced":%d,"errors":%d,"queueDepth":%d,"gateState":null,"expectedIntervalMs":%d}' \
    "$ok" "$CHECKED" "$PRODUCED" "$ERRORS" "$queue" "$RUN_EVENT_INTERVAL_MS")"
  printf '%s\n' "$summary"
  if [ -z "${FLUNCLE_API_TOKEN:-}" ]; then
    FLUNCLE_API_TOKEN="$(read_secret_token)"
  fi
  record_run_event "$RUN_EVENT_UNIT" "$STARTED_AT" "$ended" "$rc" "$summary" || true
  return 0
}

# The temp files are created further down; `_cleanup` is re-pointed as they appear so there is
# only ever ONE exit trap and the summary can never be replaced by a later `trap … EXIT`.
_cleanup() { :; }
on_exit() {
  local rc=$?
  emit_run_summary "$rc" || true
  _cleanup || true
}
STARTED_AT="$(run_event_now)"
trap 'on_exit' EXIT

[ -r "$BOOTSTRAP" ] || {
  ERRORS=$((ERRORS + 1))
  echo "fluncle-secrets-sync: missing $BOOTSTRAP" >&2
  exit 1
}
set -a
# $BOOTSTRAP is a host-only file materialized at provision time — nothing for shellcheck to follow.
# shellcheck source=/dev/null
. "$BOOTSTRAP"
set +a
umask 077

# Ownership flags for `install`. A real run is a root systemd oneshot and sets them; a
# non-root run (the test harness) cannot chown at all, and today that made the script
# unrunnable outside the box — which is why it had no test. Dropping the flags there changes
# nothing about the box, where `id -u` is 0.
HERMES_UID="${SECRETS_SYNC_HERMES_UID:-10000}"
HERMES_GID="${SECRETS_SYNC_HERMES_GID:-10000}"
if [ "$(id -u)" -eq 0 ]; then
  ROOT_OWN=(-o root -g root)
  HERMES_OWN=(-o "$HERMES_UID" -g "$HERMES_GID")
else
  ROOT_OWN=()
  HERMES_OWN=()
fi

# Two mandatory targets this run is committing to write. Counted BEFORE the work, so a run
# that dies part-way reports the shortfall as `queueDepth` instead of a tidy zero.
CHECKED=2

tg="$(mktemp)"
ts="$(mktemp)"
_cleanup() { rm -f "$tg" "$ts"; }
op inject -f -i "$TPL_DIR/hermes.env.tpl" -o "$tg"
op inject -f -i "$TPL_DIR/fluncle-secrets.env.tpl" -o "$ts"
grep -q OPENROUTER_API_KEY "$tg" || {
  ERRORS=$((ERRORS + 1))
  echo "gateway inject sanity fail" >&2
  exit 1
}
grep -q CLAUDE_CODE_OAUTH_TOKEN "$ts" || {
  ERRORS=$((ERRORS + 1))
  echo "sweep inject sanity fail" >&2
  exit 1
}
# The container's state mount ($SWEEP_DIR here = /opt/data/home in-container) does not exist
# until the hermes container has started at least once. On a FRESH box that ordering made this
# script half-succeed and exit 1 under `set -e`: the gateway env landed, the sweep env did not,
# and the sweeps ran credential-less until someone noticed. Create it first, owned by the
# in-container hermes uid — only when missing, so a live box's existing mode/ownership is never
# rewritten. The GSC key below lands in the same dir, so it is covered by this too.
SWEEP_DIR="$(dirname "$SWEEP_OUT")"
[ -d "$SWEEP_DIR" ] || install -d -m 700 ${HERMES_OWN[@]+"${HERMES_OWN[@]}"} "$SWEEP_DIR"
install -m 600 ${ROOT_OWN[@]+"${ROOT_OWN[@]}"} "$tg" "$GATEWAY_OUT"
PRODUCED=$((PRODUCED + 1))
install -m 600 ${HERMES_OWN[@]+"${HERMES_OWN[@]}"} "$ts" "$SWEEP_OUT"
PRODUCED=$((PRODUCED + 1))

# GSC service-account key → a standalone 0600 json file (its json can't be a clean shell env
# var, so it rides alongside the env file rather than inside it). The nightly audit's
# surfaces-seo day points GOOGLE_APPLICATION_CREDENTIALS here. The concrete op:// ref lives in
# the host bootstrap (FLUNCLE_GSC_OP_REF) — never in this public repo. Unset ⇒ skipped cleanly
# (the audit degrades to structural SEO checks, never invents metrics).
if [ -n "${FLUNCLE_GSC_OP_REF:-}" ]; then
  CHECKED=$((CHECKED + 1))
  GSC_OUT="${SECRETS_SYNC_GSC_OUT:-/home/admin/.hermes/home/.fluncle-gsc.json}" # = /opt/data/home/.fluncle-gsc.json in-container
  tj="$(mktemp)"
  _cleanup() { rm -f "$tg" "$ts" "$tj"; }
  if op read "$FLUNCLE_GSC_OP_REF" >"$tj" 2>/dev/null && grep -q '"private_key"' "$tj"; then
    install -m 600 ${HERMES_OWN[@]+"${HERMES_OWN[@]}"} "$tj" "$GSC_OUT"
    PRODUCED=$((PRODUCED + 1))
  else
    # Counted, not fatal: the audit degrades to structural SEO checks. Counting it is what
    # keeps a permanently-failing optional target from hiding behind a green `ok`.
    ERRORS=$((ERRORS + 1))
    echo "fluncle-secrets-sync: GSC key sync failed (audit surfaces-seo will degrade)" >&2
  fi
fi
echo "fluncle-secrets-sync: ok $(date -u +%FT%TZ)"
