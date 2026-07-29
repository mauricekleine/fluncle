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
if [ -f "$_REBAKE_LOCK" ]; then
  if [ -n "$(find "$_REBAKE_LOCK" -mmin +45 2>/dev/null)" ]; then
    echo "stale rebake lock (>45 min) at ${_REBAKE_LOCK} — clearing and proceeding" >&2
    rm -f "$_REBAKE_LOCK" 2>/dev/null || true
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

emit_cron_output() {
  local job="$1"
  shift
  if [ "${1:-}" = "--" ]; then
    shift
  fi

  local base marker tmp tmp_err tmp_rc rc=0
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
  { set +e; "$@" >"$tmp"; printf '%s' "$?" >"$tmp_rc"; } 2>&1 | tee "$tmp_err" >&2

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
  rm -f "$tmp" "$tmp_err" "$tmp_rc" 2>/dev/null || true

  # Keep the dir bounded: newest ~20 markers, drop the older tail. Best-effort.
  # shellcheck disable=SC2012
  { ls -1t "${base}"/*.md 2>/dev/null | tail -n +21 | while IFS= read -r old; do
    rm -f "$old" 2>/dev/null || true
  done; } || true

  return "$rc"
}
