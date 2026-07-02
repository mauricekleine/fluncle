#!/usr/bin/env bash
# render-conductor.sh — the `fluncle-render` `--no-agent` Hermes cron.
#
# LIVE (wired 2026-06-24). Version-controlled source; the repo is canonical and the
# box is a deploy target (fluncle-hermes-operator skill). Deployed onto the Hermes
# orchestrator box; the `fluncle-render` cron is wired there. See ../cron/README.md.
#
# WHAT IT DOES: drives the per-finding video render on a SCALE-TO-ZERO box.ascii
# render box. It wakes the box, triggers the `@fluncle-video` render of
# exactly one queued finding via `claude -p` (the render-queue prompt), and parks
# the box when the render finishes. The box renders + SHIPS to R2/the website;
# it NEVER posts to social (the prompt's hard rail). Social posting stays manual.
#
# WHY A STATE MACHINE, NOT A BLOCKING JOB: a swangle (software-GL) render runs
# ~85 min, but the Hermes `--no-agent` runner KILLS any job at ~120s (../cron/
# README.md § Operational gotchas). So this cannot block on the render. Instead
# the render runs DETACHED ON THE BOX (render-detached.sh, survives a Hermes
# container restart — it's decoupled), and the conductor is a quick (<120s) tick
# that drives a two-state machine persisted under ~/.hermes:
#
#   RENDERING -> poll the box for the done-marker; STOP the box when present.
#                still running -> NO-OP (this is the single-flight: never a 2nd).
#   IDLE      -> if past the hourly start gate AND the queue is non-empty:
#                resume-or-reprovision the box, inject creds, trigger one render.
#
# SINGLE-FLIGHT (the operator's hard requirement — no two renders at once): the
# STATE enforces it (only `idle` starts a render; `rendering` ticks only poll),
# and flock is a second guard so two ticks never race the state file. Because a
# render (~85m) outlasts the hourly tick, the `rendering` no-op branch fires
# every cycle — it is the primary safety, not a rare one.
#
# SECRETS (../cron/README.md § the render cron + § Operational gotchas):
#   - FLUNCLE_API_TOKEN — the agent-scoped token; arrives via the CRON ENV (an
#     unrecognized custom var passes Hermes' provider-cred blocklist, like the
#     other sweeps). Used for the queue gate here AND injected to the box.
#   - CLAUDE_CODE_OAUTH_TOKEN + BOX_API_KEY — file-sourced from a 0600
#     ${HOME}/.render-conductor.env. CLAUDE_CODE_OAUTH_TOKEN is a RECOGNIZED
#     provider cred Hermes HARD-BLOCKS from the cron env (GHSA-rhgp-j443-p4rf),
#     so it can only reach this script via a file; BOX_API_KEY rides along.
#     Written from the configured 1Password items (see the ops runbook note).
#
# Operator wires it on the devbox (image carries bun + fluncle + the box CLI):
#   hermes cron create "every 60m" --no-agent --script render-conductor.sh \
#     --deliver local --name fluncle-render
set -uo pipefail

# --- PATH + absolute bins: the --no-agent runner strips PATH (../cron/README.md
#     § Operational gotchas), so a bare bun/fluncle/box is "not found". ---
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
BOX_BIN="${BOX_BIN:-/usr/local/bin/box}"
BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# --- file-sourced secrets (provider creds are blocked from the cron env) ---
CONDUCTOR_ENV="${CONDUCTOR_ENV:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "$CONDUCTOR_ENV" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$CONDUCTOR_ENV"
  set +a
fi

# --- state (persisted in the mounted, hermes-writable ~/.hermes) ---
STATE_DIR="${STATE_DIR:-${HOME:-/opt/data/home}/.render-conductor}"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/state"        # "idle" | "rendering"
BOXID_FILE="$STATE_DIR/box-id"       # the current/last box.ascii id
STARTED_FILE="$STATE_DIR/started-at" # epoch of the last render START
LOCK_DIR="$STATE_DIR/lock.d"         # atomic-mkdir single-flight lock
LOG_FILE="$STATE_DIR/conductor.log"
# The box CLI keeps its auth under $HOME/.ascii; HOME is the mounted, persisted
# /opt/data/home, so `box login` survives container restarts.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROVISION="${PROVISION:-$SCRIPT_DIR/provision-rave-03.sh}"

# --- config ---
START_INTERVAL="${START_INTERVAL:-3600}" # min seconds between render STARTS (hourly throttle)
MAX_RENDER="${MAX_RENDER:-9000}"          # a render past 2.5h is stuck -> force-park
DONE_MARKER='${HOME:-/home/user}/conductor-run.done'
API_URL="${FLUNCLE_API_URL:-https://www.fluncle.com}"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG_FILE" 2>/dev/null || true; }
emit() { printf '%s\n' "$*"; } # the cron run summary lands on stdout
now() { date +%s; }
read_or() { cat "$1" 2>/dev/null || printf '%s' "$2"; }

# Freshen a RESUMED snapshot's stale checkout to current `main`. The render box is
# scale-to-zero (asleep but for a render), so it can't watch `main` itself like the
# rave-02 `fluncle-pin-watch` timer — the conductor does it here, at wake, before the
# render, so a `packages/video` fix lands on the very next render instead of waiting
# for a snapshot purge + reprovision. Drift-gated + BEST-EFFORT: a fetch/reset failure
# logs and renders on the existing checkout (the queue is idempotent, the next tick
# retries; a broken render just re-queues). `bun install` + the fluncle-video skill
# re-add run ONLY when the lockfile / skill subtree actually moved (the common case —
# a code change — is just a shallow fetch + reset, seconds against an ~85m render).
# The reprovision branch needs none of this: it clones clean `main` by construction.
# Returns 0 when the checkout is present (freshened or already current) or when the
# freshen ssh just hiccups (proceed on the existing checkout). Returns 2 when ~/fluncle
# is MISSING — box.ascii's snapshot dropped it on resume — so the caller reprovisions
# instead of rendering nothing and looping forever on a stale done-marker. The remote
# `exit 42` is the missing-checkout signal.
freshen_checkout() {
  local out rc=0
  out="$("$BOX_BIN" ssh "$1" 'bash -s' 2>&1 <<'FRESH'
set -u
cd "$HOME/fluncle" || { echo "[freshen] no ~/fluncle — needs reprovision"; exit 42; }
git fetch --depth 1 origin main -q 2>/dev/null || { echo "[freshen] fetch failed — keep current"; exit 0; }
have="$(git rev-parse HEAD 2>/dev/null)"; want="$(git rev-parse FETCH_HEAD 2>/dev/null)"
[ -n "$want" ] && [ "$have" != "$want" ] || { echo "[freshen] current at ${have:0:7}"; exit 0; }
before_lock="$(sha256sum bun.lock 2>/dev/null)"
before_skill="$(git rev-parse HEAD:packages/skills/fluncle-video 2>/dev/null)"
git reset --hard FETCH_HEAD -q || { echo "[freshen] reset failed — keep current"; exit 0; }
[ "$(sha256sum bun.lock 2>/dev/null)" != "$before_lock" ] && bun install </dev/null >/dev/null 2>&1
[ "$(git rev-parse HEAD:packages/skills/fluncle-video 2>/dev/null)" != "$before_skill" ] \
  && npx -y skills add ./packages/skills/fluncle-video -y -a claude-code </dev/null >/dev/null 2>&1
echo "[freshen] updated ${have:0:7} -> $(git rev-parse --short HEAD)"
FRESH
)" || rc=$?
  printf '%s\n' "$out" >>"$LOG_FILE"
  # box.ascii's `ssh` FLATTENS a remote non-zero exit to its OWN exit 1 (the real
  # remote status lands only in its error JSON), so the in-script `exit 42` never
  # arrives here as rc=42 — detect the missing-checkout signal from the remote's
  # OUTPUT marker instead of the (flattened) exit code.
  if printf '%s' "$out" | grep -q 'needs reprovision'; then
    return 2 # ~/fluncle missing on resume — caller must reprovision
  fi
  [ "$rc" = "0" ] || log "freshen: ssh rc=$rc — rendering on the existing checkout"
  return 0
}

# --- single-flight: only one tick mutates state at a time. An atomic `mkdir`
#     lock (portable; no util-linux `flock` dependency). A tick killed by the
#     ~120s runner can't run its EXIT trap, so first break a lock older than the
#     kill window (a held lock that old is necessarily orphaned). ---
if [ -d "$LOCK_DIR" ]; then
  lock_mtime="$(stat -c %Y "$LOCK_DIR" 2>/dev/null || stat -f %m "$LOCK_DIR" 2>/dev/null || printf '0')"
  if [ "$(($(now) - lock_mtime))" -gt 130 ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
fi
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  emit "render-conductor: a tick is already running — skip"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# --- box CLI auth (idempotent; persisted under $HOME) ---
if [ -z "${BOX_API_KEY:-}" ]; then
  log "BOX_API_KEY missing (place it in $CONDUCTOR_ENV)"
  emit "render-conductor: no BOX_API_KEY — cannot reach the render box"
  exit 1
fi
# The installer wrote the box config under ROOT's HOME at build; this cron runs as
# a non-root user with a different HOME, so re-create the (non-secret) config here.
# The auth token lands beside it via `box login`. Both persist in the mounted HOME.
BOX_CFG_DIR="${XDG_CONFIG_HOME:-${HOME:-/opt/data/home}/.config}/ascii/box"
if [ ! -f "$BOX_CFG_DIR/config.json" ]; then
  mkdir -p "$BOX_CFG_DIR"
  printf '{"api_url":"https://ascii.dev","channel":"ascii-prod"}\n' >"$BOX_CFG_DIR/config.json"
fi
# `box status` exits 0 even when NOT authenticated, so it can't gate the login.
# Always (re-)login — `box login <token>` is idempotent + non-interactive; log its
# output so a real auth failure (bad key, network) is visible, not silent.
if ! "$BOX_BIN" login "$BOX_API_KEY" >>"$LOG_FILE" 2>&1; then
  log "box login failed (see output above)"
  emit "render-conductor: box.ascii auth failed"
  exit 1
fi

state="$(read_or "$STATE_FILE" idle)"
boxid="$(read_or "$BOXID_FILE" '')"

# ============================ RENDERING: poll ============================
if [ "$state" = "rendering" ]; then
  if [ -z "$boxid" ]; then
    printf 'idle' >"$STATE_FILE"
    emit "render-conductor: rendering state with no box id — reset to idle"
    exit 0
  fi

  # Done-marker present -> the detached render finished (it already shipped, or
  # failed). Park the box and return to idle either way; a non-zero render is
  # caught next idle tick (the finding is still queued if ship never ran).
  if "$BOX_BIN" ssh "$boxid" "test -f $DONE_MARKER" >/dev/null 2>&1; then
    result="$("$BOX_BIN" ssh "$boxid" "cat $DONE_MARKER" 2>/dev/null | tr -d '\r\n' || printf '?')"
    "$BOX_BIN" stop "$boxid" >/dev/null 2>&1 || true
    printf 'idle' >"$STATE_FILE"
    log "render finished ($result) — box $boxid parked"
    emit "render-conductor: render finished ($result), box parked"
    exit 0
  fi

  # Still running -> single-flight: do NOT start another. Stuck guard only.
  started="$(read_or "$STARTED_FILE" 0)"
  if [ "$(( $(now) - started ))" -gt "$MAX_RENDER" ]; then
    "$BOX_BIN" stop "$boxid" >/dev/null 2>&1 || true
    printf 'idle' >"$STATE_FILE"
    log "render exceeded ${MAX_RENDER}s — force-parked box $boxid"
    emit "render-conductor: render stuck >${MAX_RENDER}s, force-parked"
    exit 0
  fi
  emit "render-conductor: render in flight on $boxid — single-flight hold"
  exit 0
fi

# ============================== IDLE: maybe start ==============================
# Hourly start gate (the operator's cadence; the tick may run more often for
# prompt parking, but a render STARTS at most once per START_INTERVAL).
started="$(read_or "$STARTED_FILE" 0)"
if [ "$(( $(now) - started ))" -lt "$START_INTERVAL" ]; then
  emit "render-conductor: within the hourly start window — idle"
  exit 0
fi

# Queue gate (cheap; avoids waking the box for nothing).
if [ -z "${FLUNCLE_API_TOKEN:-}" ]; then
  log "FLUNCLE_API_TOKEN missing from the cron env"
  emit "render-conductor: no agent token"
  exit 1
fi
queue_json="$("$FLUNCLE_BIN" admin tracks queue --limit 1 --json 2>/dev/null || printf '')"
head="$(printf '%s' "$queue_json" | "$BUN_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=(JSON.parse(s).tracks||[])[0];process.stdout.write(t&&t.logId?t.logId:"")}catch(e){}})' 2>/dev/null || printf '')"
if [ -z "$head" ]; then
  emit "render-conductor: queue empty — nothing to render"
  exit 0
fi
log "queue head: $head"

# Ensure the box exists: resume the parked snapshot, or reprovision if box.ascii
# reclaimed it (idle boxes + snapshots are purged past the archive window).
if [ -n "$boxid" ] && "$BOX_BIN" resume "$boxid" >/dev/null 2>&1; then
  log "resumed box $boxid"
  # A resume can succeed while box.ascii's snapshot dropped ~/fluncle. freshen_checkout
  # returns 2 in that case: stop the checkout-less box (it renders nothing) and fall
  # through to a fresh reprovision, so a lost checkout self-heals instead of looping on
  # a stale done-marker.
  if ! freshen_checkout "$boxid"; then
    log "resumed box $boxid lost its ~/fluncle checkout — stopping it + reprovisioning"
    "$BOX_BIN" stop "$boxid" >/dev/null 2>&1 || true
    boxid=""
  # The checkout freshens above, but the CLI does NOT ride the checkout: provision
  # copies the conductor's bundled binary ONCE, so a resumed snapshot keeps that
  # vintage forever while the pin moves on (a register-aware upload needs a newer
  # binary than the box may have been provisioned with). Re-copy it at every wake —
  # one small scp against an ~85m render — and BEST-EFFORT: a failed copy logs and
  # renders on the existing CLI (the same discipline as freshen itself).
  elif "$BOX_BIN" scp "$FLUNCLE_BIN" "$boxid:/home/user/.local/lib/fluncle.mjs" >>"$LOG_FILE" 2>&1; then
    log "box CLI refreshed from the conductor's bundled fluncle"
  else
    log "box CLI refresh failed — rendering with the existing CLI"
  fi
else
  boxid=""
fi

if [ -z "$boxid" ]; then
  log "no usable box — reprovisioning"
  if ! boxid="$(BOX_BIN="$BOX_BIN" BUN_BIN="$BUN_BIN" FLUNCLE_BIN="$FLUNCLE_BIN" bash "$PROVISION" 2>>"$LOG_FILE")" || [ -z "$boxid" ]; then
    log "provision failed"
    emit "render-conductor: provision failed"
    exit 1
  fi
  printf '%s' "$boxid" >"$BOXID_FILE"
  log "provisioned box $boxid"
fi

# Inject creds to the box tmpfs (re-injected each wake — tmpfs does NOT survive a
# stop/resume snapshot; never on argv). FLUNCLE_GL=swangle = software GL.
umask 077
creds="$(mktemp)"
{
  printf 'export CLAUDE_CODE_OAUTH_TOKEN=%s\n' "${CLAUDE_CODE_OAUTH_TOKEN:-}"
  printf 'export FLUNCLE_API_TOKEN=%s\n' "$FLUNCLE_API_TOKEN"
  printf 'export FLUNCLE_API_URL=%s\n' "$API_URL"
  printf 'export FLUNCLE_GL=swangle\n'
} >"$creds"
"$BOX_BIN" scp "$creds" "$boxid:/dev/shm/fluncle.env" >/dev/null 2>&1
rm -f "$creds"

# Trigger the DETACHED render (returns immediately; ~85m on the box). The box is
# NOT stopped here — a later RENDERING tick parks it when the done-marker appears.
"$BOX_BIN" ssh "$boxid" 'bash ~/render-detached.sh' >/dev/null 2>&1
printf 'rendering' >"$STATE_FILE"
now >"$STARTED_FILE"
log "started detached render of $head on box $boxid"
emit "render-conductor: started render of $head on $boxid"
exit 0
