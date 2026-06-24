#!/usr/bin/env bash
# fluncle-rave-watchdog.sh — the rave-01 side of Fluncle's dead-man's-switch triad.
#
# Runs ON rave-01 (the public-edge box: the SSH terminal, the dig DNS server, the
# Tor onion services) every ~10m via a hardened systemd timer. rave-01 otherwise
# runs only Restart=always services — this is its sole periodic job. Two jobs per
# run, both best-effort, both exit-0 on a completed run:
#
#   1. BEACON — curl ${RAVE01_BEACON_URL}, rave-01's OWN external dead-man's switch.
#      An outside uptime service (healthchecks.io / BetterUptime / self-hosted)
#      alerts when these pings stop, catching rave-01 itself going dark. (The Hermes
#      box, "rave-02", has the symmetric beacon in fluncle-healthcheck.ts.)
#
#   2. CROSS-PING — read ${WATCH_STATUS_URL} (the public /api/status), pull the one
#      integer secondsSinceFreshestReport, and if it exceeds ${WATCH_STALE_MINUTES}
#      (default 30) × 60, the rave-02 prober has gone dark (its healthcheck cron
#      stopped POSTing snapshots) → Discord-ping ONCE on the flip into-stale and once
#      on recovery (a no-spam transition state file, same shape as the healthcheck
#      cron). If /api/status is unreachable, log + SKIP the freshness check this
#      round — that is the healthcheck cron's + the external beacons' job, not ours.
#
# WHY THIS EXISTS: if rave-02 goes dark, its own healthcheck cron can't alert (the
# prober is dead). rave-01's beacon + this cross-ping are the out-of-band catch. And
# if BOTH boxes are down, the two EXTERNAL beacon services are the only thing left to
# alert (no on-box job can run) — that systemic catch is the whole point of the triad.
#
# PUBLIC-SAFE BY CONSTRUCTION (this repo is open source): NO hostnames, IPs, ports,
# URLs, op:// paths, webhooks, or tailnet names live here. EVERY input is read from an
# operator-placed EnvironmentFile (the systemd unit's EnvironmentFile=, NOT in the
# repo). The exact values live in the ops runbook note in 1Password — see this dir's
# README. Required env (names only):
#
#   RAVE01_BEACON_URL    — rave-01's external dead-man's-switch beacon (silent ping).
#   WATCH_STATUS_URL     — the public /api/status URL (the cross-ping source).
#   WATCH_STALE_MINUTES  — staleness threshold in minutes (optional; default 30).
#   DISCORD_ALERT_WEBHOOK — the Discord webhook for the cross-ping transition alert.
#
# The transition state file lives under the systemd StateDirectory (persists across
# runs even with DynamicUser=yes): ${STATE_DIRECTORY:-…}/watchdog-state.json.
set -euo pipefail

log() { printf '[fluncle-rave-watchdog] %s\n' "$*" >&2; }

# --- Config (all from the operator EnvironmentFile; nothing hardcoded) -------------
RAVE01_BEACON_URL="${RAVE01_BEACON_URL:-}"
WATCH_STATUS_URL="${WATCH_STATUS_URL:-}"
WATCH_STALE_MINUTES="${WATCH_STALE_MINUTES:-30}"
DISCORD_ALERT_WEBHOOK="${DISCORD_ALERT_WEBHOOK:-}"

# State dir: systemd sets STATE_DIRECTORY for StateDirectory=fluncle-rave-watchdog.
# Fall back to a sensible path for a hand-run (e.g. WATCH_STATE_DIR for the dry-run).
STATE_DIR="${WATCH_STATE_DIR:-${STATE_DIRECTORY:-/var/lib/fluncle-rave-watchdog}}"
STATE_FILE="${STATE_DIR}/watchdog-state.json"

# Curl override for the stubbed dry-run (the README documents it). Defaults to curl.
CURL_BIN="${WATCH_CURL_BIN:-curl}"

# --- 1. rave-01's own beacon (best-effort; never blocks the cross-ping) ------------
ping_beacon() {
  if [ -z "${RAVE01_BEACON_URL}" ]; then
    return 0 # No beacon configured — skip silently (optional, like rave-02's).
  fi

  if ! "${CURL_BIN}" -sS -o /dev/null --max-time 10 "${RAVE01_BEACON_URL}"; then
    log "beacon ping failed (best-effort, ignored)"
  fi
}

# --- Discord transition alert (exact shape used by the on-box sweeps) ---------------
ping_discord() {
  local content="$1"

  if [ -z "${DISCORD_ALERT_WEBHOOK}" ]; then
    log "no DISCORD_ALERT_WEBHOOK — skipping the cross-ping alert"
    return 0
  fi

  if ! "${CURL_BIN}" -sS -X POST -H "Content-Type: application/json" \
    -d "{\"content\":\"${content}\"}" --max-time 10 "${DISCORD_ALERT_WEBHOOK}"; then
    log "discord alert POST failed (best-effort, ignored)"
  fi
}

# --- State: the no-spam transition memory (a one-key JSON: stale=true|false) --------
# Read the prior stale-flag. Anything but a stored `true` (missing file, parse miss,
# fresh) reads as not-stale, so the FIRST run after a state loss re-baselines quietly.
read_prev_stale() {
  if [ -f "${STATE_FILE}" ] && grep -q '"stale"[[:space:]]*:[[:space:]]*true' "${STATE_FILE}" 2>/dev/null; then
    printf 'true'
  else
    printf 'false'
  fi
}

write_stale() {
  local stale="$1"
  mkdir -p "${STATE_DIR}"
  printf '{ "stale": %s }\n' "${stale}" >"${STATE_FILE}"
}

# --- Parse the single integer secondsSinceFreshestReport from /api/status ----------
# Prefer a no-jq parse (grep/sed on that one field). python3 is an accepted fallback
# when present, but we never hard-depend on jq. Prints the integer, or nothing on a
# miss (null / field absent / unparseable).
extract_seconds() {
  local body="$1"

  # Primary: grep the field + its integer value (handles null → no match → empty).
  local value
  value="$(printf '%s' "${body}" \
    | grep -o '"secondsSinceFreshestReport"[[:space:]]*:[[:space:]]*[0-9][0-9]*' \
    | grep -o '[0-9][0-9]*$' \
    | head -n1)"

  if [ -n "${value}" ]; then
    printf '%s' "${value}"
    return 0
  fi

  # Fallback: python3 if available (still no jq dependency).
  if command -v python3 >/dev/null 2>&1; then
    value="$(printf '%s' "${body}" | python3 -c '
import json, sys
try:
    v = json.load(sys.stdin).get("secondsSinceFreshestReport")
    if isinstance(v, int):
        print(v)
except Exception:
    pass
' 2>/dev/null)"

    if [ -n "${value}" ]; then
      printf '%s' "${value}"
      return 0
    fi
  fi

  return 0 # No parseable integer — caller treats empty as "could not read".
}

# --- 2. The cross-ping: is the rave-02 prober dark? --------------------------------
cross_ping() {
  if [ -z "${WATCH_STATUS_URL}" ]; then
    log "no WATCH_STATUS_URL — skipping the cross-ping this round"
    return 0
  fi

  # Fetch /api/status. Unreachable web ⇒ log + SKIP the freshness check (NOT an alert:
  # web-down is the healthcheck cron's job + the external beacons cover a systemic
  # outage). We leave the prior stale-flag untouched so the next reachable round decides.
  local body
  if ! body="$("${CURL_BIN}" -sS --max-time 10 "${WATCH_STATUS_URL}")"; then
    log "/api/status unreachable — skipping the freshness check this round"
    return 0
  fi

  local seconds
  seconds="$(extract_seconds "${body}")"

  if [ -z "${seconds}" ]; then
    # Reachable but no parseable secondsSinceFreshestReport (e.g. an empty store
    # reporting null) — treat as "cannot judge", skip without touching state.
    log "could not read secondsSinceFreshestReport — skipping the freshness check this round"
    return 0
  fi

  local threshold=$((WATCH_STALE_MINUTES * 60))
  local prev_stale
  prev_stale="$(read_prev_stale)"

  if [ "${seconds}" -gt "${threshold}" ]; then
    # The rave-02 prober is dark. Alert ONLY on the flip into-stale (no spam).
    if [ "${prev_stale}" != "true" ]; then
      local minutes=$((seconds / 60))
      ping_discord "Fluncle cross-ping: 🔴 rave-02 prober dark — last health report ${minutes}m ago"
      write_stale "true"
    fi
  else
    # Fresh. Alert ONLY on recovery (the flip out of stale).
    if [ "${prev_stale}" = "true" ]; then
      ping_discord "Fluncle cross-ping: 🟢 rave-02 prober recovered"
    fi
    write_stale "false"
  fi
}

# --- Run (each step best-effort; a completed run always exits 0) -------------------
ping_beacon
cross_ping

exit 0
