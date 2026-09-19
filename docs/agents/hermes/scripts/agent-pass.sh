# shellcheck shell=bash
# agent-pass.sh — run ONE `claude -p` pass under a wall budget and report why it ended.
#
# WHY THIS EXISTS. A host sweep unit's `TimeoutStartSec` is not a budget for the work: the unit
# runs `docker exec`, and systemd's timeout kills the HOST-SIDE CLIENT only. The container-side
# bash keeps running, finishes minutes later, and writes its ordinary marker + ledger row. So a
# sweep that blew its unit timeout landed in the run ledger as a healthy night — the unit read
# `Result=timeout` on the host while the ledger read `ok:true`, and the ledger is what anyone
# looks at. The budget therefore has to live INSIDE the container, in the script, which is what
# this helper is: the script bounds its own agent pass, always exits on its own terms, and always
# gets to write an honest summary line.
#
# The ordering invariant that makes that true, and which the unit files restate:
#
#     AGENT_PASS_BUDGET_SECS  +  grace  +  the driver's own setup/ship time  <  TimeoutStartSec
#
# Break it and the host kill races the script again.
#
# IT ALSO SEES OOM. The heavy children a coding agent spawns (a whole-repo type-aware lint, a
# whole-repo typecheck, a bundler) are killed by the cgroup, not by the agent: the agent survives,
# reports "that check did not run", and exits 0. Nothing downstream could tell. The kernel counts
# those kills in the cgroup's own `memory.events`, which IS readable from inside the container, so
# this helper samples the counter either side of the pass and hands the delta back as a fact.
#
# The counter is CONTAINER-WIDE, not per-process: a neighbour sweep's OOM inside the same cgroup
# is attributed to whatever pass was running. That is deliberate. On one shared memory cap a
# neighbour's kill and the agent's own kill are the same capacity problem, and the operator needs
# to see the night it happened — not a per-process attribution that would report zero while the
# box was over its limit.
#
# USAGE — source it (after SCRIPT_DIR is defined), then wrap the one judgment call:
#     . "${SCRIPT_DIR}/agent-pass.sh"
#     agent_pass_run "$(command -v claude)" -p "${prompt}" --model opus --dangerously-skip-permissions
# Afterwards read: AGENT_PASS_STATUS, AGENT_PASS_REASON (empty when clean), AGENT_PASS_OOM_KILLS,
# AGENT_PASS_SECONDS.

# The wall budget for one agent pass. 80 minutes: the measured healthy nights on the box run
# 23–55 minutes, and the two nights that were killed had reached ~65 minutes and were still
# working. A budget under the observed honest spread converts slow-but-fine nights into failures,
# which is the opposite of the point — this one bounds the pathological case and nothing else.
AGENT_PASS_BUDGET_SECS="${AGENT_PASS_BUDGET_SECS:-4800}"
# SIGKILL follows this long after the SIGTERM, for an agent that ignores the polite signal.
AGENT_PASS_KILL_GRACE_SECS="${AGENT_PASS_KILL_GRACE_SECS:-60}"
# cgroup v2's per-cgroup event counters. Overridable so the tests can drive a fixture file.
AGENT_PASS_CGROUP_EVENTS="${AGENT_PASS_CGROUP_EVENTS:-/sys/fs/cgroup/memory.events}"

AGENT_PASS_STATUS=0
AGENT_PASS_REASON=""
AGENT_PASS_OOM_KILLS=0
AGENT_PASS_SECONDS=0

# The cumulative `oom_kill` counter for this cgroup, or empty when it cannot be read (off-box, a
# cgroup v1 host, a sandboxed test). Empty is NOT zero: a missing counter means "unknown", and
# every caller below keeps the delta at 0 rather than inventing one.
agent_pass_oom_counter() {
  [ -r "${AGENT_PASS_CGROUP_EVENTS}" ] || return 0
  local value
  value="$(sed -n 's/^oom_kill \([0-9][0-9]*\)$/\1/p' "${AGENT_PASS_CGROUP_EVENTS}" 2>/dev/null | head -n 1)"
  printf '%s' "${value}"
}

# agent_pass_run <command> [args…] — run it bounded, leaving the four AGENT_PASS_* facts behind.
# Never returns nonzero itself: the caller reads the status and decides. stdout/stderr pass
# through untouched, so the agent's chatter still reaches journald exactly as before.
agent_pass_run() {
  local before after started ended
  before="$(agent_pass_oom_counter)"
  started="$(date -u +%s)"

  AGENT_PASS_REASON=""
  AGENT_PASS_OOM_KILLS=0
  set +e
  timeout -k "${AGENT_PASS_KILL_GRACE_SECS}" "${AGENT_PASS_BUDGET_SECS}" "$@"
  AGENT_PASS_STATUS=$?
  set -e

  ended="$(date -u +%s)"
  AGENT_PASS_SECONDS=$((ended - started))
  after="$(agent_pass_oom_counter)"
  if [ -n "${before}" ] && [ -n "${after}" ] && [ "${after}" -gt "${before}" ]; then
    AGENT_PASS_OOM_KILLS=$((after - before))
  fi

  # Most specific reason first. `timeout` reports 124 for the budget and 137 for the SIGKILL that
  # follows the grace period; either way the pass did not choose its own ending.
  if [ "${AGENT_PASS_STATUS}" = "124" ] || [ "${AGENT_PASS_STATUS}" = "137" ]; then
    AGENT_PASS_REASON="budget-exceeded"
  elif [ "${AGENT_PASS_OOM_KILLS}" != "0" ]; then
    # The agent itself may have exited 0 here. A pass whose children were killed by the cgroup
    # did not do the work it reported doing, so it is a failure regardless of its exit code.
    AGENT_PASS_REASON="oom-killed"
  elif [ "${AGENT_PASS_STATUS}" != "0" ]; then
    AGENT_PASS_REASON="nonzero-exit"
  fi
  return 0
}
