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
# The render is PINNED to `--model opus` — never the CLI default. The default is
# whatever the box token resolves to (currently Fable), and video authoring is held
# to the Opus bar everywhere (AGENTS.md): the shaders-and-aliveness quality the finding
# asks for (`videoModel: claude-opus-4-8`), and Fable's per-token cost is not worth it
# for an ~85-min render. Pin the model here so a shifting CLI default never silently
# re-tiers the render.
cd "$HOME/fluncle" || exit 1
rm -f "$HOME/conductor-run.done" "$HOME/conductor-run.log"
PROMPT="packages/skills/fluncle-video/automation/render-queue.prompt.md"
setsid bash -c '
  cd "$HOME/fluncle"
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
    > "$HOME/conductor-run.log" 2>&1
  __rc=$?
  printf "EXIT=%s @ %s DURATION=%s\n" "$__rc" "$(date -u +%FT%TZ)" "$(( $(date +%s) - __start ))" \
    > "$HOME/conductor-run.done"
' </dev/null >/dev/null 2>&1 &
echo "render-detached: launched (marker ~/conductor-run.done, log ~/conductor-run.log)"
