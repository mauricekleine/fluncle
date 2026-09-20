#!/bin/bash
# watch-checks.sh — the ONE implementation of the CI watch loop (agent-orchestration skill).
#
#   scripts/watch-checks.sh <pr-number>   poll a PR's checks until settled
#   scripts/watch-checks.sh <sha>         watch the commit's Workers Build BY NAME until it completes
#
# Exits 0 when everything relevant is green, 1 on any real failure, 2 when polling
# exhausted without a verdict (treat as NOT green). The FINAL line is machine-readable.
# The target is normalized once so padded-SHA polls cannot read empty forever and a moving HEAD
# cannot expire mid-build. The caller DECIDES on the output — never chain a merge
# after this in one command.
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
  # ── PR mode ────────────────────────────────────────────────────────────────
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

# ── SHA mode: the Workers Build, by name, on the EXACT commit ────────────────
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
      # A ZERO-SECOND failure right after a neighbor's success is the coalesced-drop
      # signature (AGENTS.md External Effects) — still red HERE: the caller decides
      # whether to re-trigger with an empty commit. This script never guesses green.
      echo "FINAL: verdict=red sha=${full:0:8} workers=$line"
      exit 1
      ;;
  esac

  # No Workers Build materialized after a third of the budget: likely coalesced onto a
  # newer commit. Say so and keep waiting the remaining budget rather than lying.
  if [ "$i" -eq $((POLLS / 3)) ] && { [ -z "$line" ] || [ "$line" = "null|null" ]; }; then
    echo "note: no Workers Build on this sha yet — it may have coalesced onto a newer commit; check HEAD"
  fi
done
echo "FINAL: verdict=undetermined sha=${full:0:8} polls=$POLLS"
exit 2
