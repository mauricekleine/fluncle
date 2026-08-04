#!/usr/bin/env bash
# fluncle-timer-watchdog — the rave-02 host guard against a systemd timer that reports
# `active` but will never fire again.
#
# ── THE FAILURE IT CATCHES (observed 2026-07-28: seven sweeps dead 13h, zero alerts) ──
# Every sweep timer on this box fires ONCE on `OnBootSec` and then rides
# `OnUnitActiveSec=<period>`, which systemd measures from the SERVICE's last activation.
# Stop such a timer before its one-shot boot fire and start it again afterwards and it can
# be left with no reference point at all: `NextElapse` becomes `infinity` and the sweep
# never runs again.
#
# `Persistent=true` is what makes it permanent, opposite to the intuition: it writes a
# stamp file, and on a fresh start systemd reads that stamp as the last trigger and so
# treats the one-shot `OnBootSec` as already satisfied, declining to re-fire it.
# `OnUnitActiveSec` then waits on a service activation that only the timer could produce.
# Reproduced all three ways on the box 2026-07-29 — see the README table.
#
# It happened when an unattended kernel-upgrade reboot (12:19 UTC) landed inside the
# pin-watch rebake quiesce window (timers stopped 12:29, restored 12:35): every timer
# whose boot fire was due in that gap came back active-but-dead. `systemctl is-active`
# said active, the last service result said success, and all 43 timers looked healthy —
# the damage was visible ONLY in `NextElapse`, which nothing read. rebuild-hermes.sh now
# re-arms on the restore path (prevention); this is the independent net (detection), and
# it catches the same stranding from ANY cause — an installer re-run shortly after boot,
# a manual `systemctl stop`, a crash mid-quiesce.
#
# Runs on `OnCalendar`, deliberately: a calendar timer always carries a realtime next
# elapse, so the watchdog cannot itself fall into the hole it is watching for.
#
# ── WHY IT REPORTS A `checked` COUNT (added 2026-07-29; RUN-01) ────────────────
# This unit wrote no run record of any kind, which made it invisible in exactly the way it
# exists to prevent. A watchdog is a DETECTOR: it legitimately re-arms nothing for months, so
# `produced == 0` says nothing about its health. Only the DENOMINATOR does. A watchdog that
# enumerates ZERO timers and reports a clean pass is the precise shape of a real past
# incident on the other box — 897 consecutive runs, zero checks, green the whole way. So
# every pass now ends with a JSON summary line carrying `checked` (timers examined) beside
# `produced` (re-arms), `errors`, and `queue_depth` (stranded timers found), and POSTs that
# line to the run ledger. The line states NO `ok`: the Worker derives the verdict from the exit
# code and the error count, and a summary that grades itself is rejected outright — a sweep
# printing `{"errors":2,"ok":true}` for eleven nights is the bug this ledger exists to end.
set -uo pipefail

SELF_TIMER="fluncle-timer-watchdog.timer"
CONTAINER="${HERMES_CONTAINER:-hermes}"
# Seconds between the first sighting and the confirming re-check. A timer parks at
# `infinity` for the instant its service is being reaped, so acting on a single sample
# would occasionally kick a perfectly healthy sweep.
RECHECK_DELAY="${TIMER_WATCHDOG_RECHECK_DELAY:-5}"

# What this run reports as. `RUN_EVENT_UNIT` is the systemd unit stem (fluncle-timer-watchdog
# .service); `RUN_EVENT_INTERVAL_MS` MIRRORS this unit's own timer — `OnCalendar=*:0/15`, so
# 15 minutes — and run-events.test.ts parses the .timer file and pins the pair in lockstep, so
# a cadence change that forgets this constant fails a build instead of quietly teaching the
# ledger the wrong freshness budget.
RUN_EVENT_UNIT="fluncle-timer-watchdog"
RUN_EVENT_INTERVAL_MS=900000

# The run's tally. `CHECKED` is the denominator that separates health from blindness;
# `REARMED` is work actually done; `STRANDED` is the backlog this pass was asked to clear
# (so `produced == 0 AND queue_depth > 0` is a real alarm, while an empty worklist is not).
CHECKED=0
REARMED=0
ERRORS=0
STRANDED=0
SUMMARY_EMITTED=0
STARTED_AT=""

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

# Read one KEY out of the LIVE container's env — the credential-free read pin-watch and the
# sweep-failure notifier already use, so this script still holds no config file and nothing
# from `op`. Container down ⇒ empty ⇒ the caller degrades.
container_env() {
  docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | sed -n "s/^$1=//p" | head -1 || true
}

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

# Print the run's summary line and POST its run record, exactly once, whatever exit path got
# here. Runs from an EXIT trap so a `return 1` deep in the script cannot skip it — the shape
# that leaves a ledger row missing is the shape that reads as a missed run.
#
# The summary line uses the ledger's canonical counter names. The POST payload has its own
# snake_case contract fields; `summary_raw` carries this line unchanged.
#
# THE LINE CARRIES NO `ok`. This unit was written fresh with the ledger, so it never inherits
# the fleet's habit of grading itself: the verdict is `exit_code == 0 && errors == 0` and the
# Worker computes it from the two facts below. A self-reported one is rejected at the edge.
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

# No armed trigger: monotonic elapse `infinity` AND no realtime elapse at all. A calendar
# timer always reports a realtime elapse, so this stays false for a healthy one.
has_no_next_elapse() {
  local mono real
  mono="$(systemctl show "$1" -p NextElapseUSecMonotonic --value 2>/dev/null)"
  real="$(systemctl show "$1" -p NextElapseUSecRealtime --value 2>/dev/null)"
  [ "$mono" = "infinity" ] && [ -z "$real" ]
}

# A oneshot service mid-tick legitimately parks its own timer at `infinity` until it
# finishes. That is a BUSY timer, not a stranded one — never kick it.
service_busy() {
  case "$(systemctl show "$1" -p ActiveState --value 2>/dev/null)" in
    active | activating | reloading | deactivating) return 0 ;;
  esac
  return 1
}

# Every fluncle sweep timer, PLUS pin-watch (outside the fluncle-* glob and the one whose
# stranding would silently stop the box self-deploying). Exclude ourselves.
list_timers() {
  {
    systemctl list-units --type=timer --state=active --no-legend --plain 'fluncle-*.timer' 2>/dev/null | awk '{print $1}'
    systemctl list-units --type=timer --state=active --no-legend --plain 'pin-watch.timer' 2>/dev/null | awk '{print $1}'
  } | grep -vxF "$SELF_TIMER" | sort -u
}

suspects=()
while IFS= read -r timer; do
  [ -n "$timer" ] || continue
  # The denominator, counted BEFORE any filter: this is how many timers the pass actually
  # looked at. A pass that enumerates nothing must never be able to report a clean sweep.
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

# Confirm before acting: re-sample after a beat and drop anything that has since re-armed
# or started running on its own.
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

# The backlog this pass is asked to clear. Reported as `queue_depth` so the ledger's alarm
# conjunction (`produced == 0 AND queue_depth > 0`) fires on a watchdog that finds stranded
# timers and re-arms none of them, while an empty worklist stays silent forever.
STRANDED="${#stranded[@]}"

# Re-arm by activating the service ONCE: that gives `OnUnitActiveSec` the reference point
# it is missing, and the normal cadence resumes from this moment. `--no-block` so a long
# sweep (anchor runs ~15 min) does not hold the watchdog open.
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

# Alert regardless of the self-heal: a stranded timer means something stopped it outside
# the paths that know to restore it, and that cause deserves eyes even once the sweep is
# running again. This attempt deliberately happens BEFORE the all-rearms-failed exit below:
# that exit is the most important discovery this detector can make. The webhook is read off
# the live container's env — never stored here.
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
