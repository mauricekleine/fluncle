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
# Scheduled by a repo-checked-in HOST systemd timer (../render-timer/, installed by
# ../install-host-timers.sh), NOT a gateway `hermes cron create`. Per-run output is a
# freshness marker the sweep self-writes via cron-output.sh under
# ~/.hermes/cron/output/fluncle-render/ (read by the /status prober). See ../cron/README.md.
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
STATE_FILE="$STATE_DIR/state"          # "idle" | "rendering"
BOXID_FILE="$STATE_DIR/box-id"         # the current/last box.ascii id
STARTED_FILE="$STATE_DIR/started-at"   # epoch of the last render START
RENDER_LOGID_FILE="$STATE_DIR/render-logid" # logId of the in-flight render (its cost scope)
FAILS_FILE="$STATE_DIR/fail-counts"    # poison ledger: logId<TAB>count<TAB>lastFailEpoch
LOCK_DIR="$STATE_DIR/lock.d"           # atomic-mkdir single-flight lock
LOG_FILE="$STATE_DIR/conductor.log"
[ -f "$FAILS_FILE" ] || : >"$FAILS_FILE" # keep it present so the awk helpers never error on a first run
# The box CLI keeps its auth under $HOME/.ascii; HOME is the mounted, persisted
# /opt/data/home, so `box login` survives container restarts.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROVISION="${PROVISION:-$SCRIPT_DIR/provision-rave-03.sh}"

# --- config ---
START_INTERVAL="${START_INTERVAL:-3600}" # min seconds between render STARTS (hourly throttle)
MAX_RENDER="${MAX_RENDER:-12600}"         # a render past 3.5h is stuck -> force-park (plate-lane authoring runs ~2h+; 2.5h killed nearly-done renders)
MARKER_SKEW="${MARKER_SKEW:-300}"         # clock-skew grace when checking a done-marker's finish time against this render's start
# Poison-skip: a finding whose render keeps failing (non-zero exit, or force-parked as
# stuck) must NOT stay the queue head forever — that is head-of-line blocking, it starves
# every finding behind it (the 2026-07-16 stall: one finding failed hourly for ~9h while 5
# waited). After POISON_THRESHOLD consecutive failures, the pick skips it for POISON_TTL,
# then lets it retry (so a TRANSIENT box.ascii wobble self-heals, an item-specific defect
# re-poisons). A clean render clears that finding's ledger.
POISON_THRESHOLD="${POISON_THRESHOLD:-3}" # consecutive render failures before a finding is skipped
POISON_TTL="${POISON_TTL:-21600}"         # seconds a poisoned finding is skipped before one retry (6h)
DONE_MARKER='${HOME:-/home/user}/conductor-run.done'
API_URL="${FLUNCLE_API_URL:-https://www.fluncle.com}"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG_FILE" 2>/dev/null || true; }
emit() { printf '%s\n' "$*"; } # the cron run summary lands on stdout
now() { date +%s; }
read_or() { cat "$1" 2>/dev/null || printf '%s' "$2"; }

# Best-effort self-seconds cost emit for a finished render (COST-01 Path B — the bash
# variant of cost-emit.ts, which the box can't import). Mirrors, inline, the two things
# that live in the workspace: the deterministic id scheme
# (${step}:${scope}:${vendor}:${unitType}:${occurredAt}, scope = the rendered logId) and
# the CostEventInput shape POSTed to /api/admin/costs/events with the agent bearer. The
# render is `video` · `self` · `seconds` · `subsidized` (rave-03 is flat-tier) ·
# `measured` (the render's own DURATION). Guards every input and NEVER fails the tick —
# a dropped emit only understates the ledger.
#   $1 logId · $2 occurredAt (ISO) · $3 seconds
emit_render_cost() {
  local log_id="$1" occurred_at="$2" seconds="$3" id body http
  if [ -z "${FLUNCLE_API_TOKEN:-}" ] || [ -z "$log_id" ]; then
    log "cost: skipping render emit (no token or logId)"
    return 0
  fi
  case "$seconds" in '' | *[!0-9]*) log "cost: no numeric DURATION on the marker — skipping emit"; return 0 ;; esac
  case "$occurred_at" in 20[0-9][0-9]-[0-1][0-9]-[0-3][0-9]T*) : ;; *) log "cost: marker had no ISO timestamp — skipping emit"; return 0 ;; esac
  id="video:${log_id}:self:seconds:${occurred_at}"
  body="$(printf '[{"id":"%s","costBasis":"subsidized","logId":"%s","occurredAt":"%s","quantity":%s,"source":"measured","step":"video","unitType":"seconds","vendor":"self"}]' \
    "$id" "$log_id" "$occurred_at" "$seconds")"
  http="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -X POST "${API_URL}/api/admin/costs/events" \
    -H "Authorization: Bearer ${FLUNCLE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$body" 2>>"$LOG_FILE" || printf '000')"
  case "$http" in
    2*) log "cost: render self-seconds emitted (${seconds}s, $log_id, HTTP $http)" ;;
    *) log "cost: render emit HTTP $http (best-effort, ignored)" ;;
  esac
}

# --- poison ledger (head-of-line-block guard; see POISON_* config) -----------------
# A tab-separated file of `logId  count  lastFailEpoch`. Manipulated with awk (present on
# the box) via write-to-temp-then-mv so a killed tick never leaves a half-written ledger.

# `1` (via exit status) when this logId is currently poisoned: at/over the threshold AND
# still inside the TTL window. Past the TTL it is eligible again (transient infra recovers).
is_poisoned() {
  awk -F'\t' -v id="$1" -v thr="$POISON_THRESHOLD" -v ttl="$POISON_TTL" -v now="$(now)" '
    $1==id && ($2+0)>=thr && (now-($3+0))<ttl { hit=1 } END { exit hit?0:1 }' "$FAILS_FILE" 2>/dev/null
}

# Increment a finding's consecutive-fail count, stamping the failure time. Alerts EXACTLY
# when the count crosses the threshold (the poisoning moment), never on every later skip.
bump_fail() {
  local id="$1" prev next; [ -n "$id" ] || return 0
  prev="$(awk -F'\t' -v id="$id" '$1==id{print $2+0; f=1} END{if(!f)print 0}' "$FAILS_FILE" 2>/dev/null || printf 0)"
  next=$((prev + 1))
  { awk -F'\t' -v id="$id" '$1!=id' "$FAILS_FILE" 2>/dev/null; printf '%s\t%s\t%s\n' "$id" "$next" "$(now)"; } \
    >"$FAILS_FILE.tmp" && mv "$FAILS_FILE.tmp" "$FAILS_FILE"
  log "render fail #$next for $id"
  if [ "$next" -eq "$POISON_THRESHOLD" ]; then
    log "POISON: $id failed $next consecutive renders — skipping it for ${POISON_TTL}s"
    emit "render-conductor: POISON-SKIP $id after $next failed renders"
    if [ -n "${DISCORD_ALERT_WEBHOOK:-}" ]; then
      curl -sS -o /dev/null --max-time 10 -H 'Content-Type: application/json' \
        -d "$(printf '{"content":"render conductor: POISON-SKIP %s after %s failed renders — needs a look (%s/admin)"}' "$id" "$next" "$API_URL")" \
        "$DISCORD_ALERT_WEBHOOK" 2>>"$LOG_FILE" || true
    fi
  fi
}

# Drop a finding from the ledger — a clean render proves it (and the pipeline) are fine.
clear_fail() {
  local id="$1"; [ -n "$id" ] || return 0
  awk -F'\t' -v id="$id" '$1!=id' "$FAILS_FILE" 2>/dev/null >"$FAILS_FILE.tmp" && mv "$FAILS_FILE.tmp" "$FAILS_FILE"
}

# `0` (success) when the finding now carries a SHIPPED video — the REAL proof a render
# worked, as opposed to a bare EXIT=0. A render can exit clean without shipping a video: the
# `claude -p` agent gets cut off mid-render by a usage limit (a clean exit, no video), or it
# renders a video the quality gates reject and withholds it. Treating that EXIT=0 as success
# clears the poison ledger and re-picks the SAME finding forever — the head-of-line loop
# (2026-07-17: 047.8.6J, then 047.6.6P, each spent hours false-succeeding). Best-effort: on
# any API/parse failure it returns 0 (assume shipped) so a transient read glitch NEVER wrongly
# poisons a good render — a real success is the norm, the no-video false-success the exception.
render_produced_video() {
  local id="$1" out
  [ -n "$id" ] || return 0
  out="$("$FLUNCLE_BIN" admin tracks get "$id" --json 2>/dev/null || printf '')"
  [ -n "$out" ] || return 0
  printf '%s' "$out" | "$BUN_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=JSON.parse(s).track||{};process.exit(t.videoUrl?0:1)}catch(e){process.exit(0)}})'
}

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
  #
  # FRESHNESS GUARD: the box's /home/user persists across stop/resume snapshots, so a
  # done-marker from a PREVIOUS render can outlive it. render-detached.sh rm's the marker
  # before forking — but ONLY if its trigger actually ran; a wedged box (box.ascii 5xx on
  # ssh/scp) silently no-ops the trigger, leaving the OLD marker in place. A bare `test -f`
  # then reads that stale marker as "finished", parks, and chains to the SAME never-shipped
  # finding — forever (the 2026-07-09 loop: a 07-08 marker re-picking 039.8.7J every tick).
  # So trust the marker only when its finish time (`@ <iso>`) is at/after this render's
  # start (minus clock skew). A stale/undated marker is treated as still-in-flight and the
  # stuck-guard below force-parks it, rather than a false "finished".
  marker_fresh=0
  result='?'
  if "$BOX_BIN" ssh "$boxid" "test -f $DONE_MARKER" >/dev/null 2>&1; then
    result="$("$BOX_BIN" ssh "$boxid" "cat $DONE_MARKER" 2>/dev/null | tr -d '\r\n' || printf '?')"
    marker_iso="${result#*@ }"; marker_iso="${marker_iso%% *}"
    marker_epoch="$(date -u -d "$marker_iso" +%s 2>/dev/null || printf 0)"
    started="$(read_or "$STARTED_FILE" 0)"
    case "$marker_epoch$started" in
      *[!0-9]*) : ;; # non-numeric -> leave stale (marker_fresh stays 0)
      *) [ "$marker_epoch" -gt 0 ] && [ "$marker_epoch" -ge "$((started - MARKER_SKEW))" ] && marker_fresh=1 ;;
    esac
    [ "$marker_fresh" = 1 ] || log "stale done-marker ($result) predates render start ($started) — ignoring, treating as in-flight"
  fi
  if [ "$marker_fresh" = 1 ]; then
    "$BOX_BIN" stop "$boxid" >/dev/null 2>&1 || true
    printf 'idle' >"$STATE_FILE"
    state=idle
    log "render finished ($result) — box $boxid parked; chaining to the next pick"
    emit "render-conductor: render finished ($result), box parked"

    # Record the render's self-seconds compute (COST-01): DURATION= is the render's own
    # wall-clock (one box clock), @ <iso> its finish time, attributed to the logId we
    # stamped at start. Parse with pure expansions; emit_render_cost guards every field.
    render_iso="${result#*@ }"
    render_iso="${render_iso%% *}"
    emit_render_cost "$(read_or "$RENDER_LOGID_FILE" '')" "$render_iso" "${result##*DURATION=}"

    # Poison accounting: a non-zero render EXIT (it ran but failed — e.g. the 13s crash)
    # counts against this finding. A clean EXIT=0 is NOT proof on its own — a render can exit
    # clean without shipping a video (a usage-limit cutoff, or a gate-rejected video withheld).
    # So an EXIT=0 clears the ledger ONLY when the video actually landed; a no-video EXIT=0 is
    # a FALSE success and counts as a failure, so a serially-false-succeeding finding poisons
    # and is skipped (2026-07-17 loop). The idle pick below then skips a poisoned head.
    rendered_logid="$(read_or "$RENDER_LOGID_FILE" '')"
    render_exit="${result#EXIT=}"; render_exit="${render_exit%% *}"
    case "$render_exit" in
      0)
        if render_produced_video "$rendered_logid"; then
          clear_fail "$rendered_logid"
        else
          log "render EXIT=0 but $rendered_logid still has no video — false success, counting as a failure"
          bump_fail "$rendered_logid"
        fi
        ;;
      '' | *[!0-9]*) : ;; # unparseable exit — leave the ledger untouched
      *) bump_fail "$rendered_logid" ;;
    esac
    # Chain: fall out of the rendering block to the idle pick in THIS tick — a
    # finished render must not cost a dead hour. The hourly START gate below
    # still holds (the last start is over an hour old once a render finishes).
  else
    # Still running -> single-flight: do NOT start another. Stuck guard only.
    started="$(read_or "$STARTED_FILE" 0)"
    if [ "$(( $(now) - started ))" -gt "$MAX_RENDER" ]; then
      "$BOX_BIN" stop "$boxid" >/dev/null 2>&1 || true
      printf 'idle' >"$STATE_FILE"
      bump_fail "$(read_or "$RENDER_LOGID_FILE" '')" # a stuck render counts against the finding too
      log "render exceeded ${MAX_RENDER}s — force-parked box $boxid"
      emit "render-conductor: render stuck >${MAX_RENDER}s, force-parked"
      exit 0
    fi
    emit "render-conductor: render in flight on $boxid — single-flight hold"
    exit 0
  fi
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
# Read a WINDOW of the queue (oldest first), not just the head, so a poisoned head can be
# stepped over. The natural order is preserved: the pick is the oldest finding that is NOT
# currently poisoned. 25 is far past any realistic simultaneous-poison count.
queue_json="$("$FLUNCLE_BIN" admin tracks queue --limit 25 --json 2>/dev/null || printf '')"
queued_ids="$(printf '%s' "$queue_json" | "$BUN_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const t of (JSON.parse(s).tracks||[]))if(t&&t.logId)process.stdout.write(t.logId+"\n")}catch(e){}})' 2>/dev/null || printf '')"
head=""; skipped=0
while IFS= read -r lid; do
  [ -n "$lid" ] || continue
  if is_poisoned "$lid"; then skipped=$((skipped + 1)); continue; fi
  head="$lid"; break
done <<EOF
$queued_ids
EOF
if [ -z "$head" ]; then
  if [ "$skipped" -gt 0 ]; then
    emit "render-conductor: nothing renderable — $skipped queued finding(s) poisoned"
  else
    emit "render-conductor: queue empty — nothing to render"
  fi
  exit 0
fi
[ "$skipped" -gt 0 ] && log "skipped $skipped poisoned finding(s) at the head"
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
  # render-detached.sh lives at ~/ (NOT inside the ~/fluncle checkout), so freshen_checkout
  # can't update it — re-scp it every wake like the CLI above, or a resumed box keeps the
  # render-detached.sh it was PROVISIONED with (its --model pin, its entry) frozen forever.
  if [ -n "$boxid" ]; then
    if "$BOX_BIN" scp "$SCRIPT_DIR/render-detached.sh" "$boxid:/home/user/render-detached.sh" >>"$LOG_FILE" 2>&1; then
      "$BOX_BIN" ssh "$boxid" 'chmod +x ~/render-detached.sh' >/dev/null 2>&1 || true
      log "render-detached.sh refreshed from the conductor's bundled copy"
    else
      log "render-detached.sh refresh failed — rendering with the box's existing copy"
    fi
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
  # The plate lane: the render agent authors photographic plates via Gemini. The key
  # arrives here from the 1P-injected sweep secrets; absent -> the agent's documented
  # procedural fallback (never a failure).
  printf 'export GEMINI_API_KEY=%s\n' "${GEMINI_API_KEY:-}"
} >"$creds"
"$BOX_BIN" scp "$creds" "$boxid:/dev/shm/fluncle.env" >/dev/null 2>&1
rm -f "$creds"

# Trigger the DETACHED render (returns immediately; ~85m on the box). The box is
# NOT stopped here — a later RENDERING tick parks it when the done-marker appears.
# VERIFY THE LAUNCH: render-detached.sh echoes "render-detached: launched" and, before
# forking, rm's any prior done-marker. A wedged box (box.ascii 5xx on ssh) silently
# no-ops this trigger; marking 'rendering' anyway would leave the OLD marker to be
# misread as 'finished' next tick — the stale-marker loop. If the launch line doesn't
# come back, the box is wedged: delete it + stay idle so a FRESH box provisions next
# tick, rather than looping on the dead one. (The freshness guard above is the second
# line of defence; this stops the wedge at the source.)
trigger_out="$("$BOX_BIN" ssh "$boxid" 'bash ~/render-detached.sh' 2>&1)"
printf '%s\n' "$trigger_out" >>"$LOG_FILE"
if ! printf '%s' "$trigger_out" | grep -q 'render-detached: launched'; then
  log "render trigger did not launch on $boxid (wedged box) — deleting it + staying idle to reprovision"
  emit "render-conductor: render trigger failed on $boxid — box condemned, reprovision next tick"
  "$BOX_BIN" stop "$boxid" >/dev/null 2>&1 || true
  "$BOX_BIN" delete "$boxid" >/dev/null 2>&1 || true
  : >"$BOXID_FILE"
  printf 'idle' >"$STATE_FILE"
  exit 1
fi
printf 'rendering' >"$STATE_FILE"
now >"$STARTED_FILE"
printf '%s' "$head" >"$RENDER_LOGID_FILE" # the finding this render is spending on (cost scope)
log "started detached render of $head on box $boxid"
emit "render-conductor: started render of $head on $boxid"
exit 0
