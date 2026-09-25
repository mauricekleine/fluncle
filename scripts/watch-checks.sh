#!/bin/bash

set -u

REPO="${WATCH_REPO:-mauricekleine/fluncle}"
POLLS="${WATCH_POLLS:-40}"
SLEEP="${WATCH_SLEEP:-30}"
target="${1:-}"

if [ -z "$target" ]; then
	echo "usage: watch-checks.sh <pr-number|sha>" >&2
	exit 2
fi

if [[ "$target" =~ ^[0-9]{1,6}$ ]]; then

	for i in $(seq 1 "$POLLS"); do
		sleep "$SLEEP"
		state=$(gh api "repos/$REPO/pulls/$target" --jq '.mergeable_state' 2>/dev/null)
		checks=$(gh pr checks "$target" --repo "$REPO" 2>/dev/null)
		pend=$(echo "$checks" | grep -c pending)
		fail=$(echo "$checks" | grep -c fail)
		echo "poll $i: state=${state:-?} pending=$pend fail=$fail"

		if [ "$pend" = "0" ] && [ -n "$state" ]; then
			if [ "$fail" != "0" ]; then
				echo "FINAL: verdict=red pr=$target state=$state fail=$fail"
				exit 1
			fi
			case "$state" in
			clean | unstable | behind)
				echo "FINAL: verdict=green pr=$target state=$state"
				exit 0
				;;
			esac
		fi
	done
	echo "FINAL: verdict=undetermined pr=$target polls=$POLLS"
	exit 2
fi

full=$(git rev-parse "$target" 2>/dev/null)
if [ -z "$full" ]; then
	echo "FINAL: verdict=undetermined error=unresolvable-sha target=$target"
	exit 2
fi

for i in $(seq 1 "$POLLS"); do
	sleep "$SLEEP"
	line=$(gh api "repos/$REPO/commits/$full/check-runs" \
		--jq '[.check_runs[] | select(.name | test("Workers Build"))][0] | "\(.status)|\(.conclusion)"' 2>/dev/null)
	echo "poll $i: sha=${full:0:8} workers=[${line:-none-yet}]"

	case "$line" in
	"completed|success")
		echo "FINAL: verdict=green sha=${full:0:8}"
		exit 0
		;;
	"completed|"*)

		echo "FINAL: verdict=red sha=${full:0:8} workers=$line"
		exit 1
		;;
	esac

	if [ "$i" -eq $((POLLS / 3)) ] && { [ -z "$line" ] || [ "$line" = "null|null" ]; }; then
		echo "note: no Workers Build on this sha yet — it may have coalesced onto a newer commit; check HEAD"
	fi
done
echo "FINAL: verdict=undetermined sha=${full:0:8} polls=$POLLS"
exit 2
