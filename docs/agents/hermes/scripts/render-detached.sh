#!/usr/bin/env bash

WORKSPACE="${FLUNCLE_WORKSPACE:-$HOME/fluncle}"
CLAUDE_JSON="${CLAUDE_CONFIG_FILE:-$HOME/.claude.json}"
DONE_MARKER="$HOME/conductor-run.done"
RUN_LOG="$HOME/conductor-run.log"

TRUST_GUARD_SECONDS="${TRUST_GUARD_SECONDS:-120}"

cd "$WORKSPACE" || exit 1

refuse() {
	printf 'EXIT=%s @ %s DURATION=0\n' "$1" "$(date -u +%FT%TZ)" >"$DONE_MARKER"
	printf 'render-detached: refused %s (%s)\n' "$1" "$2"
	exit 0
}

if [ ! -f "$WORKSPACE/node_modules/browserslist/package.json" ]; then
	refuse deps-missing "the workspace has no complete node_modules — the conductor's wake install did not land"
fi

if ! CLAUDE_JSON="$CLAUDE_JSON" WORKSPACE="$WORKSPACE" bun -e '
  const fs = require("node:fs");
  const path = process.env.CLAUDE_JSON;
  const workspace = process.env.WORKSPACE;
  let config = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed;
  } catch {}
  if (!config.projects || typeof config.projects !== "object" || Array.isArray(config.projects)) {
    config.projects = {};
  }
  const entry = config.projects[workspace];
  config.projects[workspace] = {
    ...(entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {}),
    hasTrustDialogAccepted: true,
  };
  fs.writeFileSync(`${path}.tmp`, JSON.stringify(config, null, 2));
  fs.renameSync(`${path}.tmp`, path);
' >/dev/null 2>&1; then
	refuse trust-unset "could not mark $WORKSPACE trusted in $CLAUDE_JSON — a headless run would have its allowlist ignored"
fi

rm -f "$DONE_MARKER" "$RUN_LOG"
PROMPT="packages/skills/fluncle-video/automation/render-queue.prompt.md"
setsid bash -c '
  cd "'"$WORKSPACE"'"
  set -a; . /dev/shm/fluncle.env; set +a
  export PATH="$HOME/.local/bin:$PATH"
  # Foreground-render rails: a full render must fit in ONE blocking Bash call
  # (the prompt forbids run_in_background — under -p the process exits with the
  # turn and a backgrounded render dies unshipped), so raise the Bash tool
  # timeout ceiling to 60 min. --max-turns bounds a wedged run (healthy renders
  # measure 76-98 turns) so a stall fails fast and the next hourly tick retries.
  export BASH_MAX_TIMEOUT_MS=3600000
  export BASH_DEFAULT_TIMEOUT_MS=900000
  # Harness-level guarantee behind the prompt rail: no background tasks at all
  # (headless kills backgrounded Bash ~5s after the final result, so a backgrounded
  # render dies unshipped). Documented: code.claude.com/docs/en/env-vars.md
  export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
  __effort="${RENDER_CLAUDE_EFFORT:-high}"
  case "$__effort" in
    low | medium | high | xhigh | max) ;;
    *)
      printf "render-detached: RENDER_CLAUDE_EFFORT=%s is not low|medium|high|xhigh|max; using high\n" "$__effort" \
        >> "'"$RUN_LOG"'"
      __effort=high
      ;;
  esac
  __start=$(date +%s)
  claude -p "$(cat '"$PROMPT"')" --model opus --effort "$__effort" \
    --dangerously-skip-permissions --max-turns 150 \
    >> "'"$RUN_LOG"'" 2>&1 &
  __claude=$!
  # THE SECOND FACE OF THE TRUST RAIL. Marking the workspace trusted is the fix; this is
  # the detector that keeps the fix honest. If the CLI still reports it is ignoring the
  # allowlist, the run is permission-starved and every minute it spends is wasted — kill
  # it now and name the reason, rather than paying out the full window. Bounded, and it
  # never outlives the render: the moment claude exits the watch ends with it.
  __waited=0
  while [ "$__waited" -lt '"$TRUST_GUARD_SECONDS"' ]; do
    kill -0 "$__claude" 2>/dev/null || break
    if head -c 4000 "'"$RUN_LOG"'" 2>/dev/null | grep -q "permissions.allow entries"; then
      kill "$__claude" 2>/dev/null
      wait "$__claude" 2>/dev/null
      printf "EXIT=%s @ %s DURATION=%s\n" "trust-denied" "$(date -u +%FT%TZ)" "$(( $(date +%s) - __start ))" \
        > "'"$DONE_MARKER"'"
      exit 0
    fi
    sleep 5
    __waited=$(( __waited + 5 ))
  done
  wait "$__claude"
  __rc=$?
  printf "EXIT=%s @ %s DURATION=%s\n" "$__rc" "$(date -u +%FT%TZ)" "$(( $(date +%s) - __start ))" \
    > "'"$DONE_MARKER"'"
' </dev/null >/dev/null 2>&1 &
echo "render-detached: launched (marker ~/conductor-run.done, log ~/conductor-run.log)"
