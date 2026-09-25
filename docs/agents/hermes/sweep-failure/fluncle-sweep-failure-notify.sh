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
if [ "$STATUS" = "75" ]; then
	case "$UNIT" in
	fluncle-audit.service | fluncle-audit-review.service | fluncle-backup.service | fluncle-cluster.service | fluncle-demand.service | fluncle-funnel-snapshot.service | fluncle-label-releases.service | fluncle-label-triage.service | fluncle-logbook.service | fluncle-newsletter.service | fluncle-reach.service | fluncle-reconcile-hub-counts.service | fluncle-sentry-triage.service | fluncle-social-metrics.service)
		DETAIL="The daily payload is incomplete or unconfirmed"
		;;
	esac
fi
MSG="⚠️ fluncle sweep failed on the Hermes host: ${UNIT} (result=${RESULT:-unknown}, exit=${STATUS:-?}). ${DETAIL} — inspect with journalctl -u ${UNIT}.${MUTED_SUFFIX}"

if curl -fsS -m 10 -H 'Content-Type: application/json' \
	-d "$(printf '{"content":%s}' "$(printf '%s' "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')")" \
	"$WEBHOOK" >/dev/null 2>&1; then
	[ "$COOLDOWN_ACTIVE" = "1" ] && printf '%s\n' "$NOW" >"$STAMP" 2>/dev/null || true
fi

exit 0
