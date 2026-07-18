#!/usr/bin/env bash
# fluncle-sweep-failure-notify.sh — the rave-02 host OnFailure catch-all for the sweep timers.
#
# WHY THIS EXISTS. Every host-timer sweep self-reports its health by writing a /status marker
# (cron-output.sh) whose last stdout line the healthcheck prober parses (`.ok !== false`). That
# only fires if the sweep RUNS FAR ENOUGH to print a summary. A run that dies before that — an
# OOM kill, a missing binary, a crash before the sweep's top-level catch — writes no marker, so
# the prober reads the job as "fresh-ok / no news" and NO ONE is told. This script closes that
# gap: every sweep .service carries `OnFailure=fluncle-sweep-failure@%n.service`, and systemd
# runs this on any hard failure to post a MINIMAL Discord alert.
#
# A NOTIFICATION MUST MEAN REAL TROUBLE. The first night of the catch-all was noisy — an alert
# per failed unit per run: a db outage echoed as ~6 lines, container-swap SIGTERMs alerted, a
# self-healing render condemnation alerted, and a chronically-timing-out sweep alerted hourly.
# Two filters keep the signal honest (both documented in README.md):
#   1. SKIP SIGTERM. A sweep killed by SIGTERM is not trouble — pin-watch swaps the hermes
#      container mid-sweep and the next timer tick self-heals; a persistent gap still surfaces
#      via the healthcheck prober's freshness lag. Handled below in both systemd encodings.
#   2. PER-UNIT COOLDOWN. At most one alert per unit per cooldown window (default 6h). A broken
#      sweep says so once per ~6h instead of hourly, and an incident that fails many sweeps at
#      once posts at most one line PER UNIT.
#
# CREDENTIAL-FREE BY DESIGN (mirrors pin-watch's rebuild-hermes.sh): it runs on the HOST as
# root and reads DISCORD_ALERT_WEBHOOK straight from the LIVE container's env via
# `docker inspect` — the SAME webhook the healthcheck's Discord alerting uses — so there is no
# config file, nothing read from `op`, and no secret written to host disk. If the container is
# down (so the webhook can't be read), it exits cleanly: a whole-box outage is the
# healthcheck's external beacon's job, not this per-unit hook's.
#
# Deployed at /opt/fluncle-sweep-failure/ (install-host-timers.sh lays it down alongside the
# template unit). Public-safe: carries no hostname, IP, port, op:// path, or /opt literal
# beyond its own deployed path.
#
# MINIMAL CONTENT: the failed unit name + systemd's verdict + the process exit code. NEVER a
# journal excerpt — journald lines can carry sensitive material; the alert only points at
# `journalctl -u <unit>` so the operator reads it themselves.
set -euo pipefail

UNIT="${1:?usage: fluncle-sweep-failure-notify.sh <failed-unit-name>}"
CONTAINER="${SWEEP_FAILURE_CONTAINER:-hermes}"

# Host-only facts the container can't see: systemd's Result verdict (exit-code, timeout,
# oom-kill, …) plus how the process ended. ExecMainCode is the siginfo code — 1 = CLD_EXITED
# (ExecMainStatus is then the process EXIT code) and 2 = CLD_KILLED (ExecMainStatus is then the
# SIGNAL number). Best-effort; a missing value degrades to a placeholder rather than aborting.
RESULT="$(systemctl show -p Result --value -- "$UNIT" 2>/dev/null || true)"
STATUS="$(systemctl show -p ExecMainStatus --value -- "$UNIT" 2>/dev/null || true)"
CODE="$(systemctl show -p ExecMainCode --value -- "$UNIT" 2>/dev/null || true)"

# FILTER 1 — SKIP SIGTERM KILLS (not trouble; the next tick self-heals). SIGTERM arrives when
# pin-watch swaps the hermes container mid-sweep. Two encodings to catch:
#   • signaled death:  ExecMainCode=2 (CLD_KILLED), ExecMainStatus=15 (the signal number)
#   • shell-wrapped:   ExecMainCode=1 (CLD_EXITED), ExecMainStatus=143 (128+15, an exit code)
# NEVER skip a `Result=timeout` death: systemd delivers TimeoutStartSec kills via SIGTERM too,
# and a chronic timeout is exactly the trouble this notifier exists to surface.
if [ "$RESULT" != "timeout" ] && { { [ "$STATUS" = "15" ] && [ "$CODE" = "2" ]; } || [ "$STATUS" = "143" ]; }; then
  echo "fluncle-sweep-failure: ${UNIT} died on SIGTERM (result=${RESULT:-unknown}, code=${CODE:-?}, status=${STATUS:-?}) — likely a container swap; not posting, the next tick self-heals." >&2
  exit 0
fi

# Webhook from the LIVE container's env (no config file, no op, no host secret) — pin-watch's
# exact read. Container down ⇒ empty ⇒ skip.
WEBHOOK="$(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^DISCORD_ALERT_WEBHOOK=//p' | head -1 || true)"
[ -n "$WEBHOOK" ] || exit 0

# FILTER 2 — PER-UNIT COOLDOWN. A per-unit stamp file holds the epoch of the last POSTED alert.
# If the last alert is younger than the cooldown (default 6h), mute this repeat WITHOUT touching
# the stamp (so the next real post isn't pushed further out). Degrades gracefully: if the state
# dir is missing/unwritable we post every time rather than swallow an alert.
COOLDOWN="${SWEEP_FAILURE_COOLDOWN_SECS:-21600}"
case "$COOLDOWN" in '' | *[!0-9]*) COOLDOWN=21600 ;; esac
STATE_DIR="${SWEEP_FAILURE_STATE_DIR:-/opt/fluncle-sweep-failure/state}"
STAMP="${STATE_DIR}/${UNIT}.last"
NOW="$(date +%s)"
MUTED_SUFFIX=""
COOLDOWN_ACTIVE=0

if mkdir -p "$STATE_DIR" 2>/dev/null; then
  COOLDOWN_ACTIVE=1
  LAST="$(cat "$STAMP" 2>/dev/null || true)"
  case "$LAST" in '' | *[!0-9]*) LAST="" ;; esac
  if [ -n "$LAST" ]; then
    AGE=$((NOW - LAST))
    if [ "$AGE" -lt "$COOLDOWN" ]; then
      echo "fluncle-sweep-failure: ${UNIT} last alerted ${AGE}s ago (< ${COOLDOWN}s cooldown) — muting this repeat, keeping the earlier stamp." >&2
      exit 0
    fi
  fi
  # Past the window (or first alert): this line WILL post — tell the operator repeats are muted.
  MUTED_SUFFIX=" (muted for $((COOLDOWN / 3600))h)"
else
  echo "fluncle-sweep-failure: state dir ${STATE_DIR} missing/unwritable — posting without cooldown." >&2
fi

MSG="⚠️ fluncle sweep failed on rave-02: ${UNIT} (result=${RESULT:-unknown}, exit=${STATUS:-?}). It died before writing its /status marker — inspect with journalctl -u ${UNIT}.${MUTED_SUFFIX}"

# Best-effort POST; never let a webhook hiccup fail the OnFailure unit. Stamp the unit only when
# the POST actually went through, so a flaky webhook re-alerts next tick instead of going silent.
if curl -fsS -m 10 -H 'Content-Type: application/json' \
  -d "$(printf '{"content":%s}' "$(printf '%s' "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')")" \
  "$WEBHOOK" >/dev/null 2>&1; then
  [ "$COOLDOWN_ACTIVE" = "1" ] && printf '%s\n' "$NOW" >"$STAMP" 2>/dev/null || true
fi

exit 0
