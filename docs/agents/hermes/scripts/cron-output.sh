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
# social-capture, artist-sweep, artist-follow, render, newsletter, backup, studio-clip, …).
# It becomes the `fluncle-<token>` output dir + the `# Cron Job: fluncle-<token>` header the
# prober's `AUTOMATION_CRONS` entry matches on (use the SAME token the prober's `match` uses
# — e.g. `observation`, not `observe`; `context-note`, not `context`).
#
# What emit_cron_output does: runs <command>, capturing its stdout while letting stderr
# stream straight to journald; writes the marker (the header, a blank line, then the captured
# stdout so the LAST line is the sweep's JSON summary); prunes the dir to the newest ~20
# markers; re-emits the captured stdout for journald; and PRESERVES the command's exit code
# (so a real failure still fails the systemd unit).

# The prober computes the output dir as dirname(HOME)/cron/output (HOME=/opt/data/home ->
# /opt/data/cron/output). Mirror that exactly; HEALTHCHECK_CRON_OUTPUT_DIR overrides it for a
# local dry-run, matching the prober's own override of the same name.
_cron_output_dir() {
  printf '%s' "${HEALTHCHECK_CRON_OUTPUT_DIR:-$(dirname -- "${HOME:-/opt/data/home}")/cron/output}"
}

emit_cron_output() {
  local job="$1"
  shift
  if [ "${1:-}" = "--" ]; then
    shift
  fi

  local base marker tmp rc=0
  base="$(_cron_output_dir)/fluncle-${job}"
  mkdir -p "$base" 2>/dev/null || true
  tmp="$(mktemp 2>/dev/null || printf '/tmp/cron-%s.%s' "$job" "$$")"

  # Run the payload, capturing stdout to the temp file while preserving its exit code.
  # `|| rc=$?` keeps this safe under the caller's `set -e` (the RHS of || is a tested
  # context). stderr is left untouched so diagnostics keep streaming live to journald.
  "$@" >"$tmp" || rc=$?

  # Write the marker the prober reads: the `# Cron Job: fluncle-<job>` header, a blank line,
  # then the captured stdout (its last non-empty line is the sweep's JSON summary line).
  marker="${base}/$(date -u +%Y-%m-%dT%H%M%SZ)-$$.md"
  {
    printf '# Cron Job: fluncle-%s\n\n' "$job"
    cat "$tmp"
  } >"$marker" 2>/dev/null || true

  # Re-emit the captured stdout so `journalctl -u fluncle-<job>` still shows the summary.
  cat "$tmp" 2>/dev/null || true
  rm -f "$tmp" 2>/dev/null || true

  # Keep the dir bounded: newest ~20 markers, drop the older tail. Best-effort.
  # shellcheck disable=SC2012
  { ls -1t "${base}"/*.md 2>/dev/null | tail -n +21 | while IFS= read -r old; do
    rm -f "$old" 2>/dev/null || true
  done; } || true

  return "$rc"
}
