# shellcheck shell=bash
# cron-output.sh — the shared `/status` freshness-marker helper for the HOST-TIMER sweeps.
#
# WHY THIS EXISTS (the honest reason, worth reading before you touch it).
# Fluncle's automation sweeps used to run under the Hermes GATEWAY cron runner, which
# captured each run's stdout to a run file:
#     <data-root>/cron/output/<job-dir>/<ts>.md
# The `/status` prober (fluncle-healthcheck.ts, `probeCrons()` + `AUTOMATION_CRONS`) reads
# those files to decide whether each cron is fresh + healthy: it claims each dir by the
# newest file's `# Cron Job: <name>` header, parses that file's LAST non-empty line as JSON
# (`.ok !== false`), and requires the file mtime within ~3x the cron's cadence.
#
# Now each sweep runs from a repo-checked-in HOST systemd timer (`docker exec … bash
# <sweep>.sh`), whose stdout goes to JOURNALD — NOT to that output dir. So a migrated sweep
# reads as "no runs yet / ok" on /status and MASKS real failures. capture + embed were the
# first host timers and had exactly this blind spot (`cron.capture` was permanently cosmetic:
# the sweep just `exec`'d bun and never wrote a marker). This helper closes it: every
# host-timer sweep SELF-REPORTS the marker the prober already expects, so the prober stays
# HONEST and UNCHANGED.
#
# USAGE — source it (after SCRIPT_DIR is defined), then WRAP the sweep's payload so it can
# never `exec`-replace the shell before the marker is written:
#     . "${SCRIPT_DIR}/cron-output.sh"
#     emit_cron_output enrich -- "${BUN_BIN}" "${SCRIPT_DIR}/enrich-sweep.ts" "$@"
# The first arg is the BARE cron token (enrich, context-note, note, observation, backfill,
# social-capture, artist-sweep, render, newsletter, backup, studio-clip, …).
# It becomes the `fluncle-<token>` output dir + the `# Cron Job: fluncle-<token>` header the
# prober's `AUTOMATION_CRONS` entry matches on (use the SAME token the prober's `match` uses
# — e.g. `observation`, not `observe`; `context-note`, not `context`).
#
# What emit_cron_output does: runs <command>, capturing its stdout AND its stderr; writes the
# marker (the header, a blank line, the captured stdout so the LAST line of that region is the
# sweep's JSON summary, then the delimited stderr tail below); prunes the dir to the newest ~20
# markers; re-emits the captured stdout for journald; and PRESERVES the command's exit code
# (so a real failure still fails the systemd unit).
#
# ── THE STDERR TAIL (added 2026-07-29; the strain detector's fuel) ─────────────
# Every sweep's `log()` is `console.error` — the per-row errors, the retries, the gate
# rejections, all of it on STDERR. This wrapper used to capture STDOUT only, so the marker
# held the JSON summary and NOTHING ELSE, and every error a sweep reported while still
# ending `{"ok":true}` died in journald where nothing reads it. Measured over two days of
# real box output: 610 capture bot-challenges, and the same three entity slugs rejected ~90
# times EACH by the bio voice gate — a stuck loop nobody had seen, green on /status the whole
# time, because the prober only ever read `.ok` off the last stdout line.
#
# So the marker now carries a BOUNDED, DELIMITED, PREFIXED tail of stderr as well, which the
# prober's strain detector reads (fluncle-healthcheck.ts, `markerStrain`). Three properties,
# each load-bearing:
#   1. DELIMITED — the tail sits after CRON_OUTPUT_STDERR_DELIMITER, and the prober's summary
#      lookup (`findJsonSummary`) scans ONLY the region BEFORE it. A marker written by the old
#      wrapper carries no delimiter and reads exactly as it always did.
#   2. PREFIXED — every captured line is written as a markdown blockquote (`> `), so no stderr
#      line can start with `{` and be mistaken for the sweep's JSON summary. This is the belt
#      to the delimiter's braces: image and prober bake together, but a rebake IS a window, and
#      a stderr line that parsed as `{"ok":false}` would have faked a failure.
#   3. BOUNDED — the newest CRON_OUTPUT_STDERR_LINES lines only. A chatty sweep must not grow
#      the marker without limit; the detector counts, it does not transcribe.
#
# stderr still reaches journald in full: it is `tee`d through a FOREGROUND pipeline, so it
# streams live exactly as before AND the pipeline's completion guarantees the tail file is
# whole before the marker is written (no flush race — the tests depend on that determinism).
# The one shape this forbids is a sweep that leaves a LOCAL background child holding stderr
# open, which would hold the pipe open too; no sweep does (`setsid`/`nohup`/`&` appear only in
# render-detached.sh, which runs on the render box, not under this wrapper).
#
# ── THE RUN LEDGER (added 2026-07-29; RUN-01) ──────────────────────────────────
# The marker answers "is this sweep fresh and did its last line say ok". It does NOT answer
# "how much did it produce, out of how much backlog, over how many runs" — and that is the
# question seven days of a silently-broken Deezer rung went unanswered on, with
# `isrcRecoveredByDeezer: 0` printed in every tick summary and read by nobody. So every run
# through this wrapper now also POSTs its run record — unit, start, end, exit code, and the
# sweep's own summary LINE, verbatim — to the `run_events` ledger. The Worker owns the schema:
# it DERIVES `ok` (never trusts a caller's), normalizes the counters it recognises, and records
# the mandatory ones the summary did not carry as `missing_fields` — which is the upgrade queue
# that gets sweeps improved one at a time. Bash stays dumb, so no sweep needed changing for v1.
#
# An already-decided admission skip is the narrow exception: the admission runner knows the
# registry owner and therefore the marker token before it sources this file. It opts into the
# marker-only entrypoint below, which cannot run a payload and still writes the normal marker and
# ledger row while a live rebake lock holds. Ordinary sweeps never set that opt-in and keep the
# source-time skip below; inferring a token from their script filename would still be wrong for
# `verify-captures` / `reconcile-hub-counts` / `fluncle-live` / `clip-sweep` (job `studio-clip`).

# ── THE REBAKE GUARD (runs at source time, before any sweep work) ──────────────
# A pin-watch rebuild+swap TERMs every in-flight `docker exec` when the container swaps —
# measured twice as an exit-143 sweep killed mid-tick (2026-07-26 12:27, 2026-07-27 04:34),
# both MANUALLY-started sweeps: the rebuild's quiesce stops the TIMERS, but nothing stops a
# `systemctl start fluncle-<job>.service` from walking into the build/swap window, and a
# look-before-you-start check just races the swap. So the rebuild holds a lock file in the
# /opt/data mount (rebuild-hermes.sh, quiesce_sweeps) and every sweep — sourced through this
# helper — SKIPS the tick cleanly while it is held. Sweeps are resumable by design, so a
# skipped tick costs one cadence, not data. STALENESS ESCAPE: a rebuild hard-killed past the
# EXIT trap could strand the lock; a lock older than 45 min (a rebuild runs ~10–20) is
# ignored and cleared, so the roster can never be wedged by a dead rebake.
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

# The prober computes the output dir as dirname(HOME)/cron/output (HOME=/opt/data/home ->
# /opt/data/cron/output). Mirror that exactly; HEALTHCHECK_CRON_OUTPUT_DIR overrides it for a
# local dry-run, matching the prober's own override of the same name.
_cron_output_dir() {
  printf '%s' "${HEALTHCHECK_CRON_OUTPUT_DIR:-$(dirname -- "${HOME:-/opt/data/home}")/cron/output}"
}

# The line that separates the captured stdout from the captured stderr tail inside a marker.
# MIRRORED in fluncle-healthcheck.ts as STDERR_DELIMITER — change one, change the other (the
# prober's `splitMarker` matches on this exact string, and a test pins the pair in lockstep).
# A markdown comment so the marker still reads cleanly as the `.md` it is named.
CRON_OUTPUT_STDERR_DELIMITER='<!-- fluncle-cron-output: stderr tail -->'
# How many of the NEWEST stderr lines the tail keeps. The detector is a rate signal over ~20
# retained markers, so a couple of hundred lines per tick is plenty; journald keeps the rest.
CRON_OUTPUT_STDERR_LINES="${CRON_OUTPUT_STDERR_LINES:-200}"

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

  # The opt-in that lets an already-decided admission skip report during a rebake must never
  # become a way to start a payload while the rebake lock is held.
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

  # Run the payload: stdout captured to $tmp, stderr through `tee` so it BOTH keeps streaming
  # live to journald and lands in $tmp_err for the marker's tail. The pipeline is FOREGROUND,
  # so bash waits for `tee` to exit before the next line runs — the tail is complete, never a
  # flush race.
  #
  # Two subtleties. The exit code travels through $tmp_rc because a pipeline's own `$?` is
  # `tee`'s, not the payload's. And `set +e` is set INSIDE the group (a pipeline element runs
  # in its own subshell, so it is local) because a caller running under `set -e` would
  # otherwise abandon the subshell the moment the payload failed — skipping the very line that
  # records the exit code, and silently turning every failed sweep into rc=0.
  started_at="$(run_event_now)"
  if [ "$admission_skip" = true ]; then
    printf '%s\n' "$summary" >"$tmp"
    : >"$tmp_err"
    printf '0' >"$tmp_rc"
  else
    { set +e; "$@" >"$tmp"; printf '%s' "$?" >"$tmp_rc"; } 2>&1 | tee "$tmp_err" >&2
  fi
  ended_at="$(run_event_now)"

  rc="$(cat "$tmp_rc" 2>/dev/null || printf 0)"
  case "$rc" in '' | *[!0-9]*) rc=0 ;; esac

  # Write the marker the prober reads: the `# Cron Job: fluncle-<job>` header, a blank line,
  # then the captured stdout (the last non-empty line of THAT region is the sweep's JSON
  # summary line), then — only when the sweep actually said something on stderr — the
  # delimiter and the bounded, blockquoted tail the strain detector counts.
  marker="${base}/$(date -u +%Y-%m-%dT%H%M%SZ)-$$.md"
  {
    printf '# Cron Job: fluncle-%s\n\n' "$job"
    cat "$tmp"

    if [ -s "$tmp_err" ]; then
      printf '%s\n' "$CRON_OUTPUT_STDERR_DELIMITER"
      tail -n "$CRON_OUTPUT_STDERR_LINES" "$tmp_err" | sed 's/^/> /'
    fi
  } >"$marker" 2>/dev/null || true

  # Re-emit the captured stdout so `journalctl -u fluncle-<job>` still shows the summary.
  # (stderr needs no re-emit — `tee` already streamed it live.)
  cat "$tmp" 2>/dev/null || true

  # The ledger row. `summary_raw` is the LAST NON-EMPTY line of the captured STDOUT region —
  # the same line the /status prober treats as the sweep's summary, read from the same bytes,
  # so the two consumers can never disagree about which line a sweep meant. stderr is
  # structurally excluded (it never reaches $tmp), so a chatty log line cannot pose as the
  # summary here any more than it can in the marker.
  summary_raw="$(grep -v '^[[:space:]]*$' "$tmp" 2>/dev/null | tail -n 1 || true)"
  rm -f "$tmp" "$tmp_err" "$tmp_rc" 2>/dev/null || true
  record_run_event "fluncle-${job}" "$started_at" "$ended_at" "$rc" "$summary_raw" || true

  # Keep the dir bounded: newest ~20 markers, drop the older tail. Best-effort.
  # shellcheck disable=SC2012
  { ls -1t "${base}"/*.md 2>/dev/null | tail -n +21 | while IFS= read -r old; do
    rm -f "$old" 2>/dev/null || true
  done; } || true

  return "$rc"
}

# The only rebake-bypass caller is the admission runner after it has decided that no payload may
# start. It supplies a fixed summary; this entrypoint has no command argument by construction.
emit_admission_skip_output() {
  local job="$1" summary="$2"
  if [ "${CRON_OUTPUT_REBAKE_MARKER_ONLY:-false}" != "true" ]; then
    echo 'admission skip marker mode is not enabled' >&2
    return 2
  fi
  emit_cron_output --admission-skip "$job" "$summary"
}
