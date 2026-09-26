#!/usr/bin/env bash

set -euo pipefail

UNIT="${1:?usage: fluncle-sweep-failure-notify.sh <failed-unit-name>}"
CONTAINER="${SWEEP_FAILURE_CONTAINER:-hermes}"

RESULT="$(systemctl show -p Result --value -- "$UNIT" 2>/dev/null || true)"
STATUS="$(systemctl show -p ExecMainStatus --value -- "$UNIT" 2>/dev/null || true)"
CODE="$(systemctl show -p ExecMainCode --value -- "$UNIT" 2>/dev/null || true)"

if [ "$RESULT" != "timeout" ] && { { [ "$STATUS" = "15" ] && [ "$CODE" = "2" ]; } || [ "$STATUS" = "143" ]; }; then
	echo "fluncle-sweep-failure: ${UNIT} died on SIGTERM (result=${RESULT:-unknown}, code=${CODE:-?}, status=${STATUS:-?}) — likely a container swap; not posting, the next tick self-heals." >&2
	exit 0
fi

retry_final_slot() {
	case "$1" in
	fluncle-audit.service) echo "Europe/Amsterdam 03:10" ;;
	fluncle-audit-review.service) echo "Europe/Amsterdam 06:20" ;;
	fluncle-backup.service) echo "Europe/Amsterdam 05:20" ;;
	fluncle-cluster.service) echo "Europe/Amsterdam 04:30" ;;
	fluncle-demand.service) echo "Europe/Amsterdam 05:50" ;;
	fluncle-funnel-snapshot.service) echo "UTC 23:57" ;;
	fluncle-label-releases.service) echo "Europe/Amsterdam 08:20" ;;
	fluncle-label-triage.service) echo "Europe/Amsterdam 07:50" ;;
	fluncle-logbook.service) echo "Europe/Amsterdam 01:50" ;;
	fluncle-newsletter.service) echo "Europe/Amsterdam 16:15 Fri" ;;
	fluncle-reach.service) echo "Europe/Amsterdam 05:10" ;;
	fluncle-reconcile-hub-counts.service) echo "Europe/Amsterdam 05:25" ;;
	fluncle-sentry-triage.service) echo "Europe/Amsterdam 05:40" ;;
	fluncle-social-metrics.service) echo "UTC 23:30" ;;
	esac
}

RETRY_SLOT="$(retry_final_slot "$UNIT")"
if [ -n "$RETRY_SLOT" ] && [ "$STATUS" != "75" ]; then
	read -r SLOT_TZ SLOT_FINAL SLOT_WEEKDAY <<<"$RETRY_SLOT"
	LOCAL_TIME="$(TZ="$SLOT_TZ" date +%H%M)"
	LOCAL_WEEKDAY="$(TZ="$SLOT_TZ" date +%a)"
	if { [ -z "${SLOT_WEEKDAY:-}" ] || [ "$LOCAL_WEEKDAY" = "$SLOT_WEEKDAY" ]; } && [[ "$LOCAL_TIME" < "${SLOT_FINAL/:/}" ]]; then
		echo "fluncle-sweep-failure: ${UNIT} failed before its ${SLOT_FINAL} ${SLOT_TZ} final slot (result=${RESULT:-unknown}, status=${STATUS:-?}) — the retry slot decides; not posting." >&2
		exit 0
	fi
fi

WEBHOOK="$(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^DISCORD_ALERT_WEBHOOK=//p' | head -1 || true)"
[ -n "$WEBHOOK" ] || exit 0

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

	MUTED_SUFFIX=" (muted for $((COOLDOWN / 3600))h)"
else
	echo "fluncle-sweep-failure: state dir ${STATE_DIR} missing/unwritable — posting without cooldown." >&2
fi

DETAIL="It died before writing its /status marker"
if [ "$STATUS" = "75" ] && [ -n "$RETRY_SLOT" ]; then
	DETAIL="The daily payload is incomplete or unconfirmed"
fi
MSG="⚠️ fluncle sweep failed on the Hermes host: ${UNIT} (result=${RESULT:-unknown}, exit=${STATUS:-?}). ${DETAIL} — inspect with journalctl -u ${UNIT}.${MUTED_SUFFIX}"

if curl -fsS -m 10 -H 'Content-Type: application/json' \
	-d "$(printf '{"content":%s}' "$(printf '%s' "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')")" \
	"$WEBHOOK" >/dev/null 2>&1; then
	[ "$COOLDOWN_ACTIVE" = "1" ] && printf '%s\n' "$NOW" >"$STAMP" 2>/dev/null || true
fi

exit 0
