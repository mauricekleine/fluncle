#!/usr/bin/env bash
# fluncle-rave-watchdog.sh — the rave-01 side of Fluncle's dead-man's-switch triad.
#
# Runs ON rave-01 (the public-edge box: the SSH terminal, the dig DNS server, the
# Tor onion services) every ~10m via a hardened systemd timer. rave-01 otherwise
# runs only Restart=always services — this is its sole periodic job. Three jobs per
# run, each best-effort; the run always exits 0:
#
#   1. BEACON — curl ${RAVE01_BEACON_URL}, rave-01's OWN external dead-man's switch.
#      An outside uptime service (healthchecks.io / BetterUptime / self-hosted)
#      alerts when these pings stop, catching rave-01 itself going dark. (The Hermes
#      box, "rave-02", has the symmetric beacon in fluncle-healthcheck.ts.)
#
#   2. CROSS-PING — read ${WATCH_STATUS_URL} (the public /api/v1/status), pull the one
#      integer secondsSinceProberReport, and if it exceeds ${WATCH_STALE_MINUTES}
#      (default 30) × 60, the rave-02 prober has gone dark (its healthcheck cron
#      stopped POSTing snapshots) → Discord-ping ONCE on the flip into-stale and once
#      on recovery (a no-spam transition state file, same shape as the healthcheck
#      cron). If /api/v1/status is unreachable, log + SKIP the freshness check this
#      round — that is the healthcheck cron's + the external beacons' job, not ours.
#      (It reads secondsSinceProberReport — the `hermes` service's staleness, posted
#      ONLY by rave-02's cron — so job 3's own onion post below can never mask it.)
#
#   3. ONION PROBE — reach the Tor onion through rave-01's LOCAL Tor SOCKS proxy
#      (rave-01 hosts the onion, so it has Tor; rave-02 does not), and POST an `onion`
#      service check to record_health so /status shows it. ANY HTTP response =
#      reachable; a timeout = down. Discord-ping on a transition, no-spam.
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
#   WATCH_STATUS_URL     — the public /api/v1/status URL (the cross-ping source).
#   WATCH_STALE_MINUTES  — staleness threshold in minutes (optional; default 30).
#   DISCORD_ALERT_WEBHOOK — the Discord webhook for the transition alerts.
#   WATCH_ONION_URL      — the onion health URL (job 3; unset skips the onion probe).
#   WATCH_WORKER_URL     — the Worker origin for the onion record_health POST.
#   FLUNCLE_API_TOKEN    — the agent-scoped token authorizing the onion POST.
#   WATCH_TOR_SOCKS / WATCH_ONION_TIMEOUT — the Tor SOCKS proxy + timeout (optional).
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

# Job 3 — the onion probe: reach the Tor onion through rave-01's LOCAL Tor SOCKS proxy
# (rave-01 hosts the onion, so it has Tor; rave-02 does not) and POST an `onion`
# service check to record_health so it shows on /status. All optional — unset any of
# the four below and the onion job is skipped silently.
WATCH_ONION_URL="${WATCH_ONION_URL:-}"               # the onion health URL (http://<addr>.onion/api/v1/health)
WATCH_TOR_SOCKS="${WATCH_TOR_SOCKS:-127.0.0.1:9050}" # rave-01's Tor SOCKS proxy (tor default)
WATCH_ONION_TIMEOUT="${WATCH_ONION_TIMEOUT:-30}"     # seconds per attempt — Tor is slow, give it room
WATCH_ONION_ATTEMPTS="${WATCH_ONION_ATTEMPTS:-3}"    # retries before declaring down (filters flaky Tor circuits)
WATCH_ONION_RETRY_SLEEP="${WATCH_ONION_RETRY_SLEEP:-5}" # seconds between retry attempts
WATCH_WORKER_URL="${WATCH_WORKER_URL:-}"             # the Worker origin for the record_health POST
FLUNCLE_API_TOKEN="${FLUNCLE_API_TOKEN:-}"           # the agent-scoped token (POST authorization)

# State dir: systemd sets STATE_DIRECTORY for StateDirectory=fluncle-rave-watchdog.
# Fall back to a sensible path for a hand-run (e.g. WATCH_STATE_DIR for the dry-run).
STATE_DIR="${WATCH_STATE_DIR:-${STATE_DIRECTORY:-/var/lib/fluncle-rave-watchdog}}"
STATE_FILE="${STATE_DIR}/watchdog-state.json"
ONION_STATE_FILE="${STATE_DIR}/onion-state.json"

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

# --- Parse the single integer secondsSinceProberReport from /api/v1/status ----------
# Prefer a no-jq parse (grep/sed on that one field). python3 is an accepted fallback
# when present, but we never hard-depend on jq. Prints the integer, or nothing on a
# miss (null / field absent / unparseable).
extract_seconds() {
  local body="$1"

  # Primary: grep the field + its integer value (handles null → no match → empty).
  local value
  value="$(printf '%s' "${body}" \
    | grep -o '"secondsSinceProberReport"[[:space:]]*:[[:space:]]*[0-9][0-9]*' \
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
    v = json.load(sys.stdin).get("secondsSinceProberReport")
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

  # Fetch /api/v1/status. Unreachable web ⇒ log + SKIP the freshness check (NOT an alert:
  # web-down is the healthcheck cron's job + the external beacons cover a systemic
  # outage). We leave the prior stale-flag untouched so the next reachable round decides.
  local body
  if ! body="$("${CURL_BIN}" -sS --max-time 10 "${WATCH_STATUS_URL}")"; then
    log "/api/v1/status unreachable — skipping the freshness check this round"
    return 0
  fi

  local seconds
  seconds="$(extract_seconds "${body}")"

  if [ -z "${seconds}" ]; then
    # Reachable but no parseable secondsSinceProberReport (e.g. an empty store
    # reporting null) — treat as "cannot judge", skip without touching state.
    log "could not read secondsSinceProberReport — skipping the freshness check this round"
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

# --- Onion transition memory (a one-key JSON: down=true|false), separate from the
# cross-ping state so the two never clobber each other's file. -----------------------
read_prev_onion_down() {
  if [ -f "${ONION_STATE_FILE}" ] && grep -q '"down"[[:space:]]*:[[:space:]]*true' "${ONION_STATE_FILE}" 2>/dev/null; then
    printf 'true'
  else
    printf 'false'
  fi
}

write_onion_down() {
  mkdir -p "${STATE_DIR}"
  printf '{ "down": %s }\n' "$1" >"${ONION_STATE_FILE}"
}

# --- 3. The onion probe: reach the Tor onion via the LOCAL SOCKS proxy + POST it -----
# rave-01 hosts the onion and runs Tor, so it is the only box that can route a .onion
# request. ANY HTTP response (curl http_code != 000) = reachable — the onion service
# is published AND the Tor circuit + onionspray + the Worker all answered; a timeout /
# refusal (http_code 000) on EVERY retry = down (transient Tor circuit flakiness is
# retried away over fresh circuits, so only a real outage trips it). The onion PATH's
# health, independent of the
# Worker's own (that is the `web` row). Posts an `onion` check to record_health
# (agent-tier) so /status shows it, and Discord-pings on a transition, no-spam.
probe_and_post_onion() {
  if [ -z "${WATCH_ONION_URL}" ] || [ -z "${WATCH_WORKER_URL}" ] || [ -z "${FLUNCLE_API_TOKEN}" ]; then
    log "onion probe not fully configured (URL / worker URL / token) — skipping"
    return 0
  fi

  # Probe through Tor, retrying over ISOLATED circuits before declaring down. A single
  # probe through a slow/dead Tor circuit yields code 000 (timeout / refused) even when the
  # onion service is up — that flapped DOWN→recovered a few times a day. So retry up to
  # WATCH_ONION_ATTEMPTS times, each with a DISTINCT SOCKS username (`onion-probe-N:x`) so
  # Tor's IsolateSOCKSAuth builds a FRESH circuit per attempt (a plain retry could reuse the
  # same bad circuit), and only treat the onion as down if EVERY attempt fails. The first
  # reachable response (http_code != 000) wins. -o /dev/null; capture "<http_code> <time>".
  local out code time_total attempt
  code="000"
  time_total="0"
  for attempt in $(seq 1 "${WATCH_ONION_ATTEMPTS}"); do
    out="$("${CURL_BIN}" -x "socks5h://onion-probe-${attempt}:x@${WATCH_TOR_SOCKS}" -s -o /dev/null \
      -w '%{http_code} %{time_total}' --max-time "${WATCH_ONION_TIMEOUT}" \
      "${WATCH_ONION_URL}" 2>/dev/null || true)"
    code="${out%% *}"
    time_total="${out##* }"
    [ -z "${code}" ] && code="000"
    [ "${code}" != "000" ] && break
    [ "${attempt}" -lt "${WATCH_ONION_ATTEMPTS}" ] && sleep "${WATCH_ONION_RETRY_SLEEP}"
  done

  local status message latency_ms
  if [ "${code}" = "000" ]; then
    status="down"
    message="unreachable over Tor (${WATCH_ONION_ATTEMPTS} attempts)"
    latency_ms="null"
  else
    status="ok"
    latency_ms="$(awk -v t="${time_total:-0}" 'BEGIN { printf "%d", t * 1000 }')"
    message="reachable (HTTP ${code} in ${time_total}s)"
  fi

  # Transition (no-spam): Discord-ping only on the flip down / recovery; `transitioned`
  # also drives the status_events ledger via record_health.
  local prev_down now_down transitioned="false"
  prev_down="$(read_prev_onion_down)"
  now_down="false"
  [ "${status}" = "down" ] && now_down="true"
  if [ "${now_down}" != "${prev_down}" ]; then
    transitioned="true"
    if [ "${now_down}" = "true" ]; then
      ping_discord "Fluncle status: 🔴 DOWN: onion — the Tor mirror is unreachable"
    else
      ping_discord "Fluncle status: 🟢 recovered: onion"
    fi
  fi
  write_onion_down "${now_down}"

  # POST the single `onion` check to record_health (same shape as the healthcheck
  # cron's snapshot). Best-effort: a failed POST is logged, never fatal.
  local at body
  at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  body="$(printf '{"at":"%s","checks":[{"service":"onion","status":"%s","message":"%s","latencyMs":%s,"transitioned":%s}]}' \
    "${at}" "${status}" "${message}" "${latency_ms}" "${transitioned}")"
  if ! "${CURL_BIN}" -sS -o /dev/null -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${FLUNCLE_API_TOKEN}" \
    -d "${body}" --max-time 10 "${WATCH_WORKER_URL%/}/api/v1/admin/health"; then
    log "onion record_health POST failed (best-effort, ignored)"
  fi
}

# --- Run (each step best-effort; a completed run always exits 0) -------------------
ping_beacon
cross_ping
probe_and_post_onion

exit 0
