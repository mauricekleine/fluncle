#!/usr/bin/env bash
# render-detached.sh — runs ON the render box (rave-03), deployed there by
# provision-rave-03.sh. The conductor's SSH triggers this and returns in seconds;
# the actual ~85-min render is DETACHED here (setsid) so it survives the short SSH
# AND a Hermes container restart — the render is decoupled from the conductor.
#
# It runs the real render-queue prompt: claude -p films + ships EXACTLY ONE queued
# finding (the prompt's hard rails enforce one-per-run, swangle, beat-pull gate,
# and NEVER posting to social — shipping only sets video_url / uploads to R2). On
# exit it writes ~/conductor-run.done (with the exit code); the conductor polls for
# that marker, then parks the box. Creds come from /dev/shm/fluncle.env, injected
# by the conductor on each wake (tmpfs does not survive a stop/resume snapshot).
cd "$HOME/fluncle" || exit 1
rm -f "$HOME/conductor-run.done" "$HOME/conductor-run.log"
PROMPT="packages/skills/fluncle-video/automation/render-queue.prompt.md"
setsid bash -c '
  cd "$HOME/fluncle"
  set -a; . /dev/shm/fluncle.env; set +a
  export PATH="$HOME/.local/bin:$PATH"
  claude -p "$(cat '"$PROMPT"')" --dangerously-skip-permissions \
    > "$HOME/conductor-run.log" 2>&1
  printf "EXIT=%s @ %s\n" "$?" "$(date -u +%FT%TZ)" > "$HOME/conductor-run.done"
' </dev/null >/dev/null 2>&1 &
echo "render-detached: launched (marker ~/conductor-run.done, log ~/conductor-run.log)"
