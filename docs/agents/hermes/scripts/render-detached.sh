#!/usr/bin/env bash
# render-detached.sh — runs ON the render box, deployed there by
# provision-rave-03.sh. The conductor's SSH triggers this and returns in seconds;
# the actual ~85-min render is DETACHED here (setsid) so it survives the short SSH
# AND a Hermes container restart — the render is decoupled from the conductor.
#
# It runs the real render-queue prompt: claude -p films + ships EXACTLY ONE queued
# finding (the prompt's hard rails enforce one-per-run, swangle, beat-pull gate,
# and NEVER posting to social — shipping only sets video_url / uploads to R2). On
# exit it writes ~/conductor-run.done (EXIT=<code> @ <iso> DURATION=<sec>); the
# conductor polls for that marker, parks the box, and emits the render's self-seconds
# cost from DURATION (COST-01). DURATION is the render's OWN wall-clock, measured on
# THIS box's single clock — not the conductor's wake→detect delta (which folds in ~an
# hour of idle-wait). Creds come from /dev/shm/fluncle.env, injected by the conductor
# on each wake (tmpfs does not survive a stop/resume snapshot).
#
# THE LAUNCHER REFUSES RATHER THAN STARVING A RENDER. Two preconditions are checked
# BEFORE `claude -p` is spawned, because each of them costs a whole render window when
# it is discovered from the inside:
#
#   - THE WORKSPACE'S MODULES. A checkout advanced without an install dies on a missing
#     module at the first build step, and the agent — the only thing awake — improvises a
#     full-workspace install beside its own session, which is how a render's process group
#     gets OOM-killed with no marker and no trace. The conductor installs at wake; this is
#     the rail behind that, and the agent never installs.
#   - THE TRUST SETTING. Claude Code ignores `.claude/settings.json` permissions.allow
#     entries in an untrusted workspace ("Ignoring N permissions.allow entries … this
#     workspace has not been trusted"), and a headless `claude -p` with its allowlist
#     ignored gets its tool calls denied — it burns a window doing nothing. The launcher
#     sets `projects["<workspace>"].hasTrustDialogAccepted = true` in ~/.claude.json
#     idempotently (the key is per-project, so it targets the render workspace's exact
#     path and leaves every other entry alone) and refuses to launch if it cannot.
#
# A refusal prints `render-detached: refused <reason>` INSTEAD of the launch line and
# writes the done-marker with that reason, so the conductor parks the box and pages
# instead of waiting out an empty window. Both channels exist because either one may be
# what a given tick reads.
#
# The render is PINNED to `--model opus` — never the CLI default. A bare `claude -p`
# on this box measures as `claude-sonnet-5`, and video authoring is held to the Opus
# bar everywhere (AGENTS.md): the shaders-and-aliveness quality the finding asks for
# (`videoModel: anthropic/claude-opus-5`) is not something Sonnet has delivered. Pin
# the model here so a shifting CLI default never silently re-tiers the render. `opus`
# stays a FLOATING alias — it resolves to the current Opus tier (today Opus 5), and
# pinning it to a version id would defeat the point.
WORKSPACE="${FLUNCLE_WORKSPACE:-$HOME/fluncle}"
CLAUDE_JSON="${CLAUDE_CONFIG_FILE:-$HOME/.claude.json}"
DONE_MARKER="$HOME/conductor-run.done"
RUN_LOG="$HOME/conductor-run.log"
# How long the launcher watches its own log for the ignored-allowlist warning before it
# accepts that the run is properly permissioned. The warning is one of the CLI's first
# lines; a render that is still silent after this is simply a render that is working.
TRUST_GUARD_SECONDS="${TRUST_GUARD_SECONDS:-120}"

cd "$WORKSPACE" || exit 1

# Refuse: name the reason on stdout (what the conductor's trigger reads) AND in the
# done-marker (what a later poll reads), then leave without spawning anything.
refuse() {
  printf 'EXIT=%s @ %s DURATION=0\n' "$1" "$(date -u +%FT%TZ)" >"$DONE_MARKER"
  printf 'render-detached: refused %s (%s)\n' "$1" "$2"
  exit 0
}

# --- precondition: the workspace's modules ---
# `browserslist` is a transitive dependency of the render's webpack bundling step, so its
# absence is the cheapest honest proof that the tree is incomplete.
if [ ! -d "$WORKSPACE/node_modules" ] || [ ! -d "$WORKSPACE/node_modules/browserslist" ]; then
  refuse deps-missing "the workspace has no complete node_modules — the conductor's wake install did not land"
fi

# --- precondition: the trust setting the headless allowlist depends on ---
# Read-modify-write through bun (present on the box) so every other project entry and
# every unrelated key survives; the temp+rename keeps a killed write from truncating the
# file. Environment, never argv — the path is the only input and it stays out of the
# process table.
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
  # (headless kills backgrounded Bash ~5s after the final result — the 07-19
  # dead-render class). Documented: code.claude.com/docs/en/env-vars.md
  export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
  __start=$(date +%s)
  claude -p "$(cat '"$PROMPT"')" --model opus --dangerously-skip-permissions \
    --max-turns 150 \
    > "'"$RUN_LOG"'" 2>&1 &
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
