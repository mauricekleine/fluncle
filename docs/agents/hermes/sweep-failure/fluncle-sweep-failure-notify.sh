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
# oom-kill, …) and the process exit status. Best-effort; a missing value degrades to a
# placeholder rather than aborting the alert.
RESULT="$(systemctl show -p Result --value -- "$UNIT" 2>/dev/null || true)"
STATUS="$(systemctl show -p ExecMainStatus --value -- "$UNIT" 2>/dev/null || true)"

# Webhook from the LIVE container's env (no config file, no op, no host secret) — pin-watch's
# exact read. Container down ⇒ empty ⇒ skip.
WEBHOOK="$(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^DISCORD_ALERT_WEBHOOK=//p' | head -1 || true)"
[ -n "$WEBHOOK" ] || exit 0

MSG="⚠️ fluncle sweep failed on rave-02: ${UNIT} (result=${RESULT:-unknown}, exit=${STATUS:-?}). It died before writing its /status marker — inspect with journalctl -u ${UNIT}."

# Best-effort POST; never let a webhook hiccup fail the OnFailure unit.
curl -fsS -m 10 -H 'Content-Type: application/json' \
  -d "$(printf '{"content":%s}' "$(printf '%s' "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')")" \
  "$WEBHOOK" >/dev/null 2>&1 || true
