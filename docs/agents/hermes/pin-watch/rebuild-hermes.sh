#!/usr/bin/env bash
# fluncle-pin-watch — the rave-02 box's self-deploy.
#
# Watches main's baked CLI pins (the `fluncle` + Claude Code versions in
# docs/agents/hermes/Dockerfile) against what the running Hermes container has;
# when main is ahead, rebuilds the image and swaps the container — with a
# pre-smoke gate (the new image is fully smoke-tested in throwaway containers
# BEFORE the live one is touched) and an auto-rollback rail (on any failure the
# previous image is restored). The box is never left broken.
#
# CREDENTIAL-FREE BY DESIGN: the repo is public (clone needs no key), and the new
# container REUSES the running container's runtime env (captured via
# `docker inspect`, the doctrine's "keep it reversible" step) — so this reads
# nothing from `op`, writes no secret to host disk persistently, and puts no
# token on the box. The captured env lives only in a tmpfs file for the swap.
#
# Run by pin-watch.timer (default: --if-stale, a no-op when current). Run once
# by hand with --force to clear accumulated debt and validate the recipe.
#
# Doctrine: docs/agents/hermes-agent.md + the fluncle-hermes-operator skill.
set -euo pipefail

# ── config (overridable via the env) ──────────────────────────────────────────
CONTAINER="${PINWATCH_CONTAINER:-hermes}"
IMAGE_REPO="${PINWATCH_IMAGE_REPO:-fluncle-hermes}"
REPO_URL="${PINWATCH_REPO_URL:-https://github.com/mauricekleine/fluncle.git}"
REPO_DIR="${PINWATCH_REPO_DIR:-/opt/fluncle-build}"
DOCKERFILE="docs/agents/hermes/Dockerfile"
LOCK="${PINWATCH_LOCK:-/run/lock/fluncle-pin-watch.lock}"
KEEP_IMAGES="${PINWATCH_KEEP_IMAGES:-4}"

MODE="--if-stale"
case "${1:-}" in
  --force) MODE="--force" ;;     # rebuild regardless of drift (the operator pilot)
  --dry-run) MODE="--dry-run" ;; # build + pre-smoke the new image, then STOP (never swap)
esac

log() { printf '[pin-watch] %s\n' "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

# ── single-flight ─────────────────────────────────────────────────────────────
exec 9>"$LOCK"
flock -n 9 || { log "another run holds the lock; exiting"; exit 0; }

command -v docker >/dev/null || die "docker not found"
command -v git >/dev/null || die "git not found"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "container '$CONTAINER' not running — refusing to act (an operator must (re)provision it)"

# Discord alert (best-effort; the webhook is read from the LIVE container's env
# so we never need a config file). Never throws.
WEBHOOK="$(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^DISCORD_ALERT_WEBHOOK=//p' | head -1 || true)"
alert() {
  [ -n "$WEBHOOK" ] || return 0
  curl -fsS -m 10 -H 'Content-Type: application/json' \
    -d "$(printf '{"content":%s}' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')")" \
    "$WEBHOOK" >/dev/null 2>&1 || true
}

# Self-deploy health → the public /status board (the `self-deploy` row). Reuses
# the agent token already in the LIVE container's env (the same token the
# pre-smoke read uses) — nothing is written to disk, nothing is read from `op`.
# Best-effort, never throws; the message is public-safe and deliberately vague
# (no host, no tool VERSIONS — those are internal — and no raw error). The Discord
# alerts below DO carry versions; they go to the operator, not the public board.
# status ∈ ok|degraded|down.
WORKER_URL="${PINWATCH_WORKER_URL:-https://www.fluncle.com}"
APITOKEN="$(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^FLUNCLE_API_TOKEN=//p' | head -1 || true)"
post_health() {
  [ -n "$APITOKEN" ] || return 0
  local status="$1" esc
  esc="$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  curl -fsS -m 10 \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $APITOKEN" \
    -d "$(printf '{"at":"%s","checks":[{"service":"self-deploy","status":"%s","message":"%s","latencyMs":null,"transitioned":false}]}' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$status" "$esc")" \
    "${WORKER_URL%/}/api/admin/health" >/dev/null 2>&1 || true
}

# ── 1. sync the build context (public repo, no credential) ────────────────────
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" fetch --depth 1 origin main -q
else
  log "cloning the public repo into $REPO_DIR"
  rm -rf "$REPO_DIR"
  git clone --depth 1 "$REPO_URL" "$REPO_DIR" -q
fi
git -C "$REPO_DIR" checkout -q -B main origin/main
git -C "$REPO_DIR" reset --hard -q origin/main

# ── 2. read the target pins (Dockerfile on main) vs the box's running versions ─
pin_from_dockerfile() { sed -n "s/.*$1@\\([0-9][0-9.]*\\).*/\\1/p" "$REPO_DIR/$DOCKERFILE" | head -1; }
# fluncle is the standalone binary now (releases/download/v<ver>/fluncle-…), not npm@;
# its version is read off the release-asset URL. claude-code stays an npm@ pin.
WANT_FLUNCLE="$(sed -n 's#.*releases/download/v\([0-9][0-9.]*\)/fluncle-.*#\1#p' "$REPO_DIR/$DOCKERFILE" | head -1)"
WANT_CLAUDE="$(pin_from_dockerfile '@anthropic-ai\/claude-code')"
[ -n "$WANT_FLUNCLE" ] && [ -n "$WANT_CLAUDE" ] || die "could not parse the Dockerfile pins (fluncle='$WANT_FLUNCLE' claude='$WANT_CLAUDE')"

HAVE_FLUNCLE="$(docker exec "$CONTAINER" fluncle version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
HAVE_CLAUDE="$(docker exec "$CONTAINER" claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
log "fluncle: have=$HAVE_FLUNCLE want=$WANT_FLUNCLE | claude-code: have=$HAVE_CLAUDE want=$WANT_CLAUDE"

if [ "$MODE" = "--if-stale" ] && [ "$HAVE_FLUNCLE" = "$WANT_FLUNCLE" ] && [ "$HAVE_CLAUDE" = "$WANT_CLAUDE" ]; then
  log "pins current — no-op"
  post_health ok "tools current"
  exit 0
fi
log "pins drifted (or --force) — rebuilding"

# ── 3. capture the running container's runtime env (the secrets) into a tmpfs ──
# = the container's env MINUS the image's baked ENV (so we re-inject only the
# --env-file vars, never the image defaults). Lives only in tmpfs; rm on exit.
OLD_IMAGE="$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')"
ENVTMP="$(mktemp -p "${XDG_RUNTIME_DIR:-/dev/shm}" pinwatch-env.XXXXXX)"
chmod 600 "$ENVTMP"
trap 'rm -f "$ENVTMP"' EXIT
comm -23 \
  <(docker inspect "$CONTAINER"  --format '{{range .Config.Env}}{{println .}}{{end}}' | sort) \
  <(docker inspect "$OLD_IMAGE"  --format '{{range .Config.Env}}{{println .}}{{end}}' | sort) \
  > "$ENVTMP"
[ -s "$ENVTMP" ] || die "captured runtime env is empty — refusing to launch a secret-less container"

# capture the run-config flags from the LIVE container (faithful reproduction —
# never assume a path: the script runs as root, so `~` would be /root, not the
# real /home/admin/.hermes mount).
RESTART="$(docker inspect "$CONTAINER" --format '{{.HostConfig.RestartPolicy.Name}}')"
MOUNT_SRC="$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/opt/data"}}{{.Source}}{{end}}{{end}}')"
[ -n "$MOUNT_SRC" ] || die "could not find the /opt/data mount source on the running container"

# ── 4. build the new image ────────────────────────────────────────────────────
SHA="$(git -C "$REPO_DIR" rev-parse --short HEAD)"
NEW_IMAGE="$IMAGE_REPO:v$(date -u +%Y.%m.%d)-$SHA"
log "building $NEW_IMAGE (repo root build context, -f $DOCKERFILE)"
docker build -f "$REPO_DIR/$DOCKERFILE" -t "$NEW_IMAGE" "$REPO_DIR" >&2 || { alert "🛠️ pin-watch: BUILD FAILED for $NEW_IMAGE — box untouched, staying on $OLD_IMAGE"; post_health degraded "a tool update failed to build; staying on the current tools"; die "build failed"; }

# ── 5. PRE-SMOKE the new image in throwaway containers (live box untouched) ────
presmoke_fail() { alert "🛠️ pin-watch: PRE-SMOKE FAILED ($1) for $NEW_IMAGE — box untouched, staying on $OLD_IMAGE"; post_health degraded "a tool update failed validation; box untouched on the current tools"; die "pre-smoke failed: $1"; }
GOT_FLUNCLE="$(docker run --rm --entrypoint fluncle "$NEW_IMAGE" version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
[ "$GOT_FLUNCLE" = "$WANT_FLUNCLE" ] || presmoke_fail "fluncle version $GOT_FLUNCLE != $WANT_FLUNCLE"
GOT_CLAUDE="$(docker run --rm --entrypoint claude "$NEW_IMAGE" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
[ "$GOT_CLAUDE" = "$WANT_CLAUDE" ] || presmoke_fail "claude version $GOT_CLAUDE != $WANT_CLAUDE"
# gh (the nightly-audit agents' PR driver) must be present + runnable in the new image. It's a
# manual-watch pin (not auto-bumped), so this just guards that a rebuild never ships a broken gh.
docker run --rm --entrypoint gh "$NEW_IMAGE" --version >/dev/null 2>&1 || presmoke_fail "gh --version failed (audit PR driver missing)"
# agent-allowed read with the agent token + live API (expect ok:true)
docker run --rm --env-file "$ENVTMP" --entrypoint fluncle "$NEW_IMAGE" admin tracks enrich --queue --json --limit 1 2>/dev/null | grep -Eq '"ok" *: *true' || presmoke_fail "agent read did not return ok:true"
# the server boundary: a publish-class command with the agent token MUST be refused
if docker run --rm --env-file "$ENVTMP" --entrypoint fluncle "$NEW_IMAGE" admin add 'https://open.spotify.com/track/0000000000000000pinwatch' >/dev/null 2>&1; then
  presmoke_fail "publish-class command was NOT refused (role boundary regression)"
fi
# embed engine (RFC Unit C): prove the MuQ interpreter resolves + torch/muq import, in a
# hard-capped throwaway container. NOT a full forward — the box has zero swap and the live
# container is up, so an uncapped MuQ load could OOM the live agent. This catches the actual
# failure mode (a dangling interpreter symlink / broken venv) cheaply (~2-3s, <1GB). A hang
# (timeout) is treated as a pre-smoke failure so a wedged build can't swap.
# shellcheck disable=SC2016  # single-quoted on purpose: $(readlink)/import run in the CONTAINER's sh, not the host
timeout 120 docker run --rm --memory=3g --memory-swap=3g --entrypoint sh "$NEW_IMAGE" -c \
  'test -e "$(readlink -f /opt/muq-venv/bin/python)" && /opt/muq-venv/bin/python -c "import torch, muq"' \
  >/dev/null 2>&1 || presmoke_fail "embed engine broken (interpreter/import)"
log "pre-smoke passed"

if [ "$MODE" = "--dry-run" ]; then
  log "dry-run: $NEW_IMAGE built and pre-smoke passed; leaving the live container untouched"
  exit 0
fi

# ── 6. swap (the only moment the live container is touched) ────────────────────
run_container() {
  # TZ pin: the Friday newsletter cron (`0 15 * * 5`) has no per-job timezone — it fires
  # at 15:00 in the BOX CLOCK's zone. Without this the rebuilt container defaults to UTC
  # and the newsletter slips to 17:00 Amsterdam (summer). Keep it pinned so every
  # auto-rebuild preserves 15:00 Amsterdam across the DST flip (see cron/README.md).
  docker run -d --name "$CONTAINER" --restart "${RESTART:-unless-stopped}" \
    --memory=4g --cpus=2 --shm-size=1g \
    -e TZ=Europe/Amsterdam \
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
    -v "$MOUNT_SRC":/opt/data \
    --env-file "$ENVTMP" \
    "$1" gateway run >/dev/null
}
# Healthy = the gateway came up and stays up (the CLI answers from inside).
# Test hook: PINWATCH_TEST_FAIL_POSTSMOKE=1 forces the FIRST health check (the
# post-swap one) to fail exactly once, to drill the rollback rail — the second
# call (the rollback's own check) runs for real. The box swaps to the new image,
# "fails", and is restored to the previous image; both are known-good, so it
# stays healthy throughout. See README § Testing the rollback rail.
postsmoke_drilled=0
container_healthy() {
  if [ "${PINWATCH_TEST_FAIL_POSTSMOKE:-}" = "1" ] && [ "$postsmoke_drilled" = "0" ]; then
    postsmoke_drilled=1
    log "TEST: forcing this post-swap smoke to fail (rollback drill)"
    return 1
  fi
  sleep 6
  [ "$(docker inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null)" = "true" ] &&
    docker exec "$CONTAINER" fluncle version >/dev/null 2>&1
}

log "swapping $CONTAINER: $OLD_IMAGE -> $NEW_IMAGE"
docker stop "$CONTAINER" >/dev/null 2>&1 || true
docker rm "$CONTAINER" >/dev/null 2>&1 || true

# ── 7. start new + post-swap smoke (the `if` keeps set -e from bare-exiting) ───
if run_container "$NEW_IMAGE" && container_healthy; then
  log "post-swap smoke passed — deployed $NEW_IMAGE"
  alert "🚀 pin-watch: deployed $NEW_IMAGE on rave-02 — fluncle $HAVE_FLUNCLE→$WANT_FLUNCLE, claude-code $HAVE_CLAUDE→$WANT_CLAUDE"
  post_health ok "rebuilt to the latest tools"
  # prune old fluncle-hermes images, keep the most recent $KEEP_IMAGES (rollback depth)
  docker images "$IMAGE_REPO" --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' \
    | sort -rk2 | awk 'NR>'"$KEEP_IMAGES"' {print $1}' | xargs -r docker rmi >/dev/null 2>&1 || true
  exit 0
fi

# ── 8. ROLLBACK — the box is never left broken ────────────────────────────────
log "new image did not come up healthy — rolling back to $OLD_IMAGE"
docker stop "$CONTAINER" >/dev/null 2>&1 || true
docker rm "$CONTAINER" >/dev/null 2>&1 || true
if run_container "$OLD_IMAGE" && container_healthy; then
  alert "↩️ pin-watch: $NEW_IMAGE failed smoke on rave-02 — ROLLED BACK to $OLD_IMAGE (running). A human should look."
  post_health degraded "rolled back a failed update; healthy on the previous tools"
  die "rolled back to $OLD_IMAGE after a failed deploy"
fi
alert "🔴 pin-watch: ROLLBACK ALSO FAILED on rave-02 — Hermes is DOWN. Operator needed NOW."
post_health down "agent box down after a failed update — operator needed"
die "rollback failed — box is down"
