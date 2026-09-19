#!/usr/bin/env bash
# render-conductor.sh — the `fluncle-render` `--no-agent` Hermes cron.
#
# LIVE (wired 2026-06-24). Version-controlled source; the repo is canonical and the
# box is a deploy target (fluncle-hermes-operator skill). Deployed onto the Hermes
# orchestrator box; the `fluncle-render` cron is wired there. See ../cron/README.md.
#
# WHAT IT DOES: drives the per-finding video render on a SCALE-TO-ZERO boat.dev
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
#   - CLAUDE_CODE_OAUTH_TOKEN + BOAT_API_KEY — file-sourced from a 0600
#     ${HOME}/.fluncle-secrets.env. CLAUDE_CODE_OAUTH_TOKEN is a RECOGNIZED
#     provider cred Hermes HARD-BLOCKS from the cron env (GHSA-rhgp-j443-p4rf),
#     so it can only reach this script via a file; the boat.dev key rides along.
#     Written from the configured 1Password items (see the ops runbook note).
#     The pre-rename name BOX_API_KEY is still accepted, so a secrets template that
#     has not been re-cut yet keeps the conductor authenticated.
#
# PREFLIGHT: `render-conductor.sh --preflight` performs the READ-ONLY half of a tick —
# CLI version, config, login, `boat list --all`, and the pick it WOULD make — prints
# what it would do, and exits before anything is created, resumed, stopped or extended.
# It is the first thing to run on the box after a CLI cutover.
#
# Scheduled by a repo-checked-in HOST systemd timer (../render-timer/, installed by
# ../install-host-timers.sh), NOT a gateway `hermes cron create`. Per-run output is a
# freshness marker the sweep self-writes via cron-output.sh under
# ~/.hermes/cron/output/fluncle-render/ (read by the /status prober). See ../cron/README.md.
set -uo pipefail

# --- PATH + absolute bins: the --no-agent runner strips PATH (../cron/README.md
#     § Operational gotchas), so a bare bun/fluncle/boat is "not found". ---
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
# The boat.dev CLI (the vendor renamed `box` -> `boat`; same account, same API host,
# same sandbox ids). `BOX_BIN` stays an accepted alias so an operator invocation written
# against the pre-rename binary keeps working.
BOAT_BIN="${BOAT_BIN:-${BOX_BIN:-/usr/local/bin/boat}}"
BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# Every CLI call carries `--no-update`. The binary is a checksum-pinned release
# (../Dockerfile), and the CLI otherwise checks for — and installs — a newer one on each
# run; that would put this script's verb contract back on a moving target, which is the
# whole reason the binary is pinned. `--no-update` is a GLOBAL flag, so it goes BEFORE
# the subcommand: after it, `ssh`'s trailing `[COMMAND]...` would swallow it as part of
# the remote command line.
boat_cli() { "$BOAT_BIN" --no-update "$@"; }

# The queue-response parser, shared by the idle pick and --preflight so the two can never
# disagree about what the queue said. Reads the CLI's `{ok:true,tracks:[…]}` payload on
# stdin and writes one logId per line; exit 2 on anything outside that contract, which is
# what makes the queue gate fail-closed rather than reading a malformed body as empty.
QUEUE_PARSER='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let body;try{body=JSON.parse(s)}catch{process.exit(2)}if(!body||typeof body!=="object"||Array.isArray(body)||body.ok!==true||!Array.isArray(body.tracks)||body.tracks.some(track=>!track||typeof track!=="object"||Array.isArray(track)||typeof track.logId!=="string"||track.logId.length===0))process.exit(2);for(const track of body.tracks)process.stdout.write(track.logId+"\n")})'

# --- --preflight: the read-only half of a tick ---
# Everything up to and including the queue pick, nothing that creates, resumes, stops,
# extends or deletes. It is what an operator runs first on a CLI cutover: it proves the
# binary, the config, the login, and — the question a CLI rename cannot answer offline —
# whether the sandbox this conductor has been driving is still there under the new CLI.
PREFLIGHT=0
for arg in "$@"; do
  case "$arg" in
    --preflight | --dry-run) PREFLIGHT=1 ;;
    *)
      printf 'usage: render-conductor.sh [--preflight]\n' >&2
      exit 2
      ;;
  esac
done

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
BOXID_FILE="$STATE_DIR/box-id"         # the current/last boat.dev sandbox id
STARTED_FILE="$STATE_DIR/started-at"   # epoch of the last render START
RENDER_LOGID_FILE="$STATE_DIR/render-logid" # logId of the in-flight render (its cost scope)
FAILS_FILE="$STATE_DIR/fail-counts"    # poison ledger: logId<TAB>count<TAB>lastFailEpoch
ORPHANS_FILE="$STATE_DIR/orphan-boxes" # sandbox ids condemned but not yet PROVEN deleted (one per line)
LOCK_DIR="$STATE_DIR/lock.d"           # atomic-mkdir single-flight lock
LOG_FILE="$STATE_DIR/conductor.log"
[ -f "$FAILS_FILE" ] || : >"$FAILS_FILE" # keep it present so the awk helpers never error on a first run
[ -f "$ORPHANS_FILE" ] || : >"$ORPHANS_FILE"
# The state FILE NAMES are deliberately unchanged across the box -> boat CLI rename:
# they hold the live sandbox id and the orphan ledger, and renaming them would strand
# both on the box at cutover (a conductor with no id reprovisions and leaves the running
# sandbox behind).
# The CLI keeps its auth under $HOME/.ascii; HOME is the mounted, persisted
# /opt/data/home, so `boat login` survives container restarts.

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
# then lets it retry (so a TRANSIENT boat.dev wobble self-heals, an item-specific defect
# re-poisons). A clean render clears that finding's ledger.
POISON_THRESHOLD="${POISON_THRESHOLD:-3}" # consecutive render failures before a finding is skipped
POISON_TTL="${POISON_TTL:-21600}"         # seconds a poisoned finding is skipped before one retry (6h)
# Condemning a box ends with its id WRITTEN DOWN — the condemn is a reclamation TTL rather
# than a synchronous delete (see the box-lifecycle block), so absence is something a later
# tick proves rather than this one.
CONDEMN_TTL="${CONDEMN_TTL:-60}"              # seconds until boat.dev may reclaim a condemned box
REAP_PER_TICK="${REAP_PER_TICK:-5}"           # max orphans a single tick works through (tick-budget guard)
ORPHAN_ALERT_AFTER="${ORPHAN_ALERT_AFTER:-21600}" # seconds a condemned box may linger before one alert (6h)
DONE_MARKER='${HOME:-/home/user}/conductor-run.done'
API_URL="${FLUNCLE_API_URL:-https://www.fluncle.com}"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG_FILE" 2>/dev/null || true; }
# Tick-local render counters. `checked` counts finding slots actually inspected (the in-flight
# slot and queue candidates); `produced` counts successful render completions and launches.
# Item failures stay in `failed`; only emit_fail marks the RUN itself failed. Deliberately no
# queue_depth: the queue read is capped at 25, not a whole-backlog count.
RUN_CHECKED=0
RUN_PRODUCED=0
RUN_FAILED=0
# The cron run summary lands on stdout — as the human line PLUS the contracted JSON summary
# line fluncle-healthcheck's findJsonSummary requires (#892 hardened no-summary to "died
# mid-flight" on first sighting, which turned every text-only tick — queue empty included —
# into a false Down on /status). emit() is the benign/steady-state exit; emit_fail() marks a
# genuine failure (ok:false), which the healthcheck alarms on after two consecutive misses.
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
emit() {
  printf '%s\n' "$*"
  printf '{"ok":true,"summary":"%s","checked":%s,"errors":0,"failed":%s,"produced":%s}\n' \
    "$(json_escape "$*")" "$RUN_CHECKED" "$RUN_FAILED" "$RUN_PRODUCED"
}
emit_fail() {
  printf '%s\n' "$*"
  printf '{"ok":false,"summary":"%s","checked":%s,"errors":1,"failed":%s,"produced":%s}\n' \
    "$(json_escape "$*")" "$RUN_CHECKED" "$RUN_FAILED" "$RUN_PRODUCED"
}
# emit_repair_pending() records the Worker's typed due-work deferral (`due_work_maintenance_pending`,
# recognized in due-work-repair-pending.ts): the read was refused while due-work source repair
# converges, so the tick is exit-zero `paused` backpressure (`due_work_repair_pending`), never a
# failure, and the next tick reads again.
emit_repair_pending() {
  printf '%s\n' "$*"
  printf '{"ok":true,"summary":"%s","checked":%s,"errors":0,"failed":%s,"gateState":"paused","partial":false,"produced":%s,"reason":"due_work_repair_pending","throttled":true}\n' \
    "$(json_escape "$*")" "$RUN_CHECKED" "$RUN_FAILED" "$RUN_PRODUCED"
}
now() { date +%s; }
read_or() { cat "$1" 2>/dev/null || printf '%s' "$2"; }

# Best-effort self-seconds cost emit for a finished render (COST-01 Path B — the bash
# variant of cost-emit.ts, which the box can't import). Mirrors, inline, the two things
# that live in the workspace: the deterministic id scheme
# (${step}:${scope}:${vendor}:${unitType}:${occurredAt}, scope = the rendered logId) and
# the CostEventInput shape POSTed to /api/v1/admin/costs/events with the agent bearer. The
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
    -X POST "${API_URL}/api/v1/admin/costs/events" \
    -H "Authorization: Bearer ${FLUNCLE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$body" 2>>"$LOG_FILE" || printf '000')"
  case "$http" in
    2*) log "cost: render self-seconds emitted (${seconds}s, $log_id, HTTP $http)" ;;
    *) log "cost: render emit HTTP $http (best-effort, ignored)" ;;
  esac
}

# One-line Discord ping (best-effort — alerting never fails a tick).
discord_alert() {
  [ -n "${DISCORD_ALERT_WEBHOOK:-}" ] || return 0
  curl -sS -o /dev/null --max-time 10 -H 'Content-Type: application/json' \
    -d "$(printf '{"content":"%s"}' "$1")" \
    "$DISCORD_ALERT_WEBHOOK" 2>>"$LOG_FILE" || true
}

# --- box lifecycle: condemn + orphan reaping ---------------------------------------
# THE VERB TRAP: a condemn must never assume a verb the pinned CLI does not expose. The
# pre-rename `box` binary carried no delete/rm/destroy at all, and because the call sat
# under `>/dev/null 2>&1 || true` every condemn failed on `unrecognized subcommand` and
# was swallowed, orphaning every wedged box the conductor ever condemned.
#
# The condemn is therefore lifetime-based: `boat extend <id> --ttl <seconds>` sets
# `archiveAfter`, after which boat.dev reclaims the box and its snapshots. So a condemn is
# stop (drop the compute) + extend --ttl (mark for reclamation), and reclamation is
# ASYNCHRONOUS — the box lingers for a short while by design.
#
# `boat delete <id> --yes` DOES exist on the renamed CLI (docs.boat.dev/cli-reference) and
# would make a condemn synchronous, but it also destroys the snapshot chain. Switching to
# it changes what a condemn MEANS, so the CLI migration deliberately leaves this path as
# it stands: the TTL + ledger rails are unchanged, and adopting `delete` is its own
# operator decision.
#
# That asynchrony is why the orphan ledger is the load-bearing half rather than a fallback:
# a condemn cannot prove absence in-tick, so every condemned id is written down and later
# ticks watch it until boat.dev has actually taken it. The rule is unchanged in spirit —
# nothing is ever merely hoped-deleted — but "proven gone" is now something a LATER tick
# establishes, not this one.

# `0` (success) ONLY when boat.dev PROVES the id is absent. An unreachable API, a failed
# list, or an empty body returns non-zero — "not proven gone" must never read as "deleted",
# or one wobble would drop an id from the ledger and orphan that box permanently.
#
# NOTE the bare `list`: both the pre-rename and the renamed CLI default to `--filter r`
# (up/running only), so a condemned-and-stopped box reads as absent here. That is the
# behaviour this reap rail has always had and the CLI migration keeps it byte for byte;
# tightening it to `--all` turns the orphan alert from dormant into live and is an
# operator decision, not a rename (see docs/agents/render-conductor.md § Known issues).
box_gone() {
  local id="$1" out
  [ -n "$id" ] || return 0
  out="$(boat_cli list --json 2>/dev/null)" || return 1
  case "$out" in
    '') return 1 ;;                        # empty body is not proof of absence
    *"\"id\":\"$id\""*) return 1 ;;        # exact key match; a substring test could hit a longer id
    *) return 0 ;;
  esac
}

# `0` when boat.dev POSITIVELY reports the id in ANY state (`--all` spans running, stopped,
# pending, stopping and error). This is the opposite question to box_gone and it is asked
# for a different reason: deciding whether a failed/abandoned `resume` may clear the box id
# and reprovision. Only an id boat.dev does not know about is safe to walk away from —
# anything else is a sandbox that would be left running with nobody to stop it. A failed
# list is non-zero, i.e. "cannot tell", which the caller treats as "hold".
box_present() {
  local id="$1" out
  [ -n "$id" ] || return 1
  out="$(boat_cli list --all --json 2>/dev/null)" || return 1
  case "$out" in
    '') return 1 ;;
    *"\"id\":\"$id\""*) return 0 ;;
    *) return 1 ;;
  esac
}

# Park a box and mark it for reclamation. Idempotent — safe to re-issue every tick on an
# id boat.dev has not taken yet. `0` when the CLI accepted the TTL (the box is now on a
# clock), non-zero when it did not (API down, or the verb moved again).
mark_for_reclaim() {
  local id="$1"
  [ -n "$id" ] || return 1
  boat_cli stop "$id" >>"$LOG_FILE" 2>&1 || true # best-effort: a stopped box errors here
  boat_cli extend "$id" --ttl "$CONDEMN_TTL" >>"$LOG_FILE" 2>&1
}

# The ledger is `boxId<TAB>firstFiledEpoch<TAB>alerted`, same temp+mv discipline as the
# poison ledger. The timestamp is what lets the reaper stay quiet during the normal
# reclamation lag and speak up only when a box is genuinely stuck.
add_orphan() {
  local id="$1"
  [ -n "$id" ] || return 0
  awk -F'\t' -v id="$id" '$1==id{f=1} END{exit f?0:1}' "$ORPHANS_FILE" 2>/dev/null && return 0
  printf '%s\t%s\t0\n' "$id" "$(now)" >>"$ORPHANS_FILE"
}

drop_orphan() {
  local id="$1"
  [ -n "$id" ] || return 0
  [ -f "$ORPHANS_FILE" ] || return 0
  # `awk` prints nothing when the ledger drains to empty; unlike `grep -v` that is still a
  # 0 exit, but keep the mv unchained anyway so this can never strand a stale ledger.
  awk -F'\t' -v id="$id" '$1!=id' "$ORPHANS_FILE" >"$ORPHANS_FILE.tmp" 2>/dev/null
  mv "$ORPHANS_FILE.tmp" "$ORPHANS_FILE" 2>/dev/null || true
}

mark_orphan_alerted() {
  local id="$1"
  awk -F'\t' -v id="$id" 'BEGIN{OFS="\t"} $1==id{$3=1} {print}' "$ORPHANS_FILE" >"$ORPHANS_FILE.tmp" 2>/dev/null
  mv "$ORPHANS_FILE.tmp" "$ORPHANS_FILE" 2>/dev/null || true
}

# Condemn a box: park it, put it on a reclamation clock, and WRITE THE ID DOWN. There is no
# synchronous delete to succeed at any more, so this always files — the ledger is how the
# id survives the `: >"$BOXID_FILE"` that follows, and later ticks are what prove the box
# actually went away.
condemn_box() {
  local id="$1"
  [ -n "$id" ] || return 0
  if mark_for_reclaim "$id"; then
    log "condemned box $id — parked and marked for reclamation in ${CONDEMN_TTL}s"
  else
    log "condemned box $id — could NOT set its reclamation TTL (boat.dev unreachable?); filed for retry"
  fi
  add_orphan "$id"
}

# Drain the ledger, bounded by REAP_PER_TICK so it can never eat the tick budget. Runs every
# tick: drop the ids boat.dev has taken, re-issue the TTL on the ones it has not (idempotent,
# and it repairs an id filed while the API was down), and alert ONCE on a box still standing
# after ORPHAN_ALERT_AFTER — the normal reclamation lag stays silent, a stuck box does not.
# (The `while read` holds an fd on the ledger while drop_orphan rewrites it via temp+mv; the
# loop keeps iterating the original list and each write composes onto the current file.)
reap_orphans() {
  local id filed alerted reaped=0
  [ -s "$ORPHANS_FILE" ] || return 0
  while IFS=$'\t' read -r id filed alerted; do
    [ -n "$id" ] || continue
    [ "$reaped" -lt "$REAP_PER_TICK" ] || break
    reaped=$((reaped + 1))
    if box_gone "$id"; then
      log "orphan $id reclaimed — dropping from the ledger"
      drop_orphan "$id"
      continue
    fi
    mark_for_reclaim "$id" || true
    case "$filed" in '' | *[!0-9]*) filed="$(now)" ;; esac
    if [ "$alerted" != "1" ] && [ "$(($(now) - filed))" -gt "$ORPHAN_ALERT_AFTER" ]; then
      log "orphan $id still standing after ${ORPHAN_ALERT_AFTER}s — alerting"
      discord_alert "render conductor: render box $id has not been reclaimed since it was condemned — needs a look ($API_URL/admin)"
      mark_orphan_alerted "$id"
    fi
  done <"$ORPHANS_FILE"
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
  RUN_FAILED=$((RUN_FAILED + 1))
  prev="$(awk -F'\t' -v id="$id" '$1==id{print $2+0; f=1} END{if(!f)print 0}' "$FAILS_FILE" 2>/dev/null || printf 0)"
  next=$((prev + 1))
  { awk -F'\t' -v id="$id" '$1!=id' "$FAILS_FILE" 2>/dev/null; printf '%s\t%s\t%s\n' "$id" "$next" "$(now)"; } \
    >"$FAILS_FILE.tmp" && mv "$FAILS_FILE.tmp" "$FAILS_FILE"
  log "render fail #$next for $id"
  if [ "$next" -eq "$POISON_THRESHOLD" ]; then
    log "POISON: $id failed $next consecutive renders — skipping it for ${POISON_TTL}s"
    emit "render-conductor: POISON-SKIP $id after $next failed renders"
    discord_alert "render conductor: POISON-SKIP $id after $next failed renders — needs a look ($API_URL/admin)"
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

# --- the restoring window: a resumed box answers later than its resume returns -------
# A resume can report success while the box spends the next seconds RESTORING, and every
# call against it in that window fails with a typed restoring error — the freshen ssh,
# both scp refreshes, and the render trigger itself, a burst of a few seconds. Without
# this gate the trigger's launch-line check reads that healthy box as WEDGED and condemns
# it, costing the hourly slot PLUS a full reprovision (fresh clone + toolchain install).
#
# So a restoring error is RETRY, never wedge. This gate is a bounded poll of a trivial
# `ssh` — the verb the freshen needs next, so answering it IS the readiness that matters,
# and no new verb is invented against the CLI. It is bounded by WALL CLOCK (probe latency
# counts, not just the sleeps) and deliberately well under the unit's
# `TimeoutStartSec=180`, so a box that never comes back ends the tick cleanly instead of
# being killed between resume and trigger.
#
# THE CODE IS MATCHED IN THREE SPELLINGS. The code is emitted by the API, not the CLI, so
# a CLI rename does not settle it: the pre-rename transport returned `box_restoring` (HTTP
# 500) and the renamed API documents `boat_restoring` (HTTP 409, docs.boat.dev/use-in-code),
# with `sandbox_restoring` the third spelling the renamed binary carries. Matching all
# three keeps the gate correct on either side of the cutover and through any further
# renaming, and the anchored `_restoring` suffix keeps it from matching prose.
#
# `0` when the box answers. Non-zero when it never did — a genuine timeout or a different
# error — and the caller then carries on exactly as before, so the trigger's launch-line
# check stays the wedge authority and a truly dead box still lands in the condemn path.
RESTORING_CODE_RE='(box|boat|sandbox)_restoring'
BOAT_READY_TIMEOUT="${BOAT_READY_TIMEOUT:-${BOX_READY_TIMEOUT:-75}}"  # max seconds to wait out a restoring box
BOAT_READY_INTERVAL="${BOAT_READY_INTERVAL:-${BOX_READY_INTERVAL:-5}}" # seconds between readiness probes
await_box_ready() {
  local id="$1" out rc began waited saw_restore=0
  [ -n "$id" ] || return 1
  began="$(now)"
  while :; do
    out="$(boat_cli ssh "$id" 'true' 2>&1)"
    rc=$?
    waited="$(($(now) - began))"
    if [ "$rc" = "0" ]; then
      [ "$saw_restore" = "1" ] && log "box $id ready after ${waited}s"
      return 0
    fi
    printf '%s\n' "$out" >>"$LOG_FILE"
    if ! printf '%s' "$out" | grep -qE "$RESTORING_CODE_RE"; then
      log "box $id readiness probe failed with something other than a restore (rc=$rc) — proceeding"
      return 1
    fi
    saw_restore=1
    if [ "$waited" -ge "$BOAT_READY_TIMEOUT" ]; then
      log "box $id still restoring after ${waited}s — giving up the wait"
      return 1
    fi
    log "box $id restoring — waiting (${waited}s elapsed)"
    sleep "$BOAT_READY_INTERVAL"
  done
}

# --- the blocking resume: bound it, and never walk away from a live sandbox ----------
# The renamed CLI's `resume` no longer returns as soon as the API accepts it: it waits for
# a ready state and a successful no-op command, bounded at THIRTY MINUTES
# (docs.boat.dev/cli-reference). The conductor's host unit kills a tick at
# `TimeoutStartSec=180`, so an unbounded resume can take the whole tick and die silently
# between resume and trigger. `timeout` caps it well inside the unit's budget; the
# readiness gate above still runs afterwards, because the CLI's own wait covers command
# execution, not the restoring window the freshen's ssh hits next.
#
# A cap alone is not enough: the caller used to treat ANY non-zero resume as "the box is
# gone, reprovision". Under a bounded blocking resume that is exactly wrong — the resume
# is still converging server-side, and reprovisioning would leave a running sandbox with
# nobody to stop it. So the caller asks `box_present` and only walks away from an id
# boat.dev does not know about.
RESUME_TIMEOUT="${RESUME_TIMEOUT:-90}" # max seconds to let a blocking resume run
# `timeout` is coreutils and present on the box; resolve it once rather than assuming it,
# so the script still runs (unbounded, and it says so) anywhere it is missing.
TIMEOUT_BIN="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || printf '')"
run_bounded() {
  local secs="$1"
  shift
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" "$secs" "$@"
    return $?
  fi
  log "no timeout(1) on PATH — running '$1' unbounded"
  "$@"
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
# is MISSING — boat.dev's snapshot dropped it on resume — so the caller reprovisions
# instead of rendering nothing and looping forever on a stale done-marker. The remote
# `exit 42` is the missing-checkout signal.
freshen_checkout() {
  local out rc=0
  out="$(boat_cli ssh "$1" 'bash -s' 2>&1 <<'FRESH'
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
  # boat.dev's `ssh` FLATTENS a remote non-zero exit to its OWN exit 1 (the real
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
# BOAT_API_KEY is the name the vendor documents; BOX_API_KEY is what a secrets template
# cut before the rename provides. Prefer the new name, accept the old, so the cutover
# does not depend on the secret being re-cut first.
BOAT_API_KEY="${BOAT_API_KEY:-${BOX_API_KEY:-}}"
if [ -z "$BOAT_API_KEY" ]; then
  log "BOAT_API_KEY missing (place it in $CONDUCTOR_ENV; BOX_API_KEY is still accepted)"
  emit_fail "render-conductor: no BOAT_API_KEY — cannot reach the render box"
  exit 1
fi
# The image bake wrote the CLI config under ROOT's HOME; this cron runs as a non-root
# user with a different HOME, so re-create the (non-secret) config here. The auth token
# lands beside it via `boat login`. Both persist in the mounted HOME. The shape and the
# values are the vendor's own for a Docker install (docs.boat.dev/use-in-production): the
# API HOST is unchanged by the rename — only the binary's name, its config directory, and
# its route prefix moved — which is why an existing sandbox is still the same sandbox.
BOAT_CFG_DIR="${XDG_CONFIG_HOME:-${HOME:-/opt/data/home}/.config}/ascii/boat"
if [ ! -f "$BOAT_CFG_DIR/config.json" ]; then
  mkdir -p "$BOAT_CFG_DIR"
  printf '{"api_url":"https://ascii.dev","channel":"prod"}\n' >"$BOAT_CFG_DIR/config.json"
fi
# `status` exits 0 even when NOT authenticated, so it can't gate the login.
# Always (re-)login — it is idempotent + non-interactive; log its output so a real auth
# failure (bad key, network) is visible, not silent. The key goes in on STDIN
# (`--key-stdin`), never on argv where every other process on the host could read it.
if ! printf '%s' "$BOAT_API_KEY" | boat_cli login --key-stdin --json >>"$LOG_FILE" 2>&1; then
  log "boat login failed (see output above)"
  emit_fail "render-conductor: boat.dev auth failed"
  exit 1
fi

# ============================ PREFLIGHT: report, change nothing ============================
# Runs AFTER the login (auth is the thing most worth proving) and BEFORE `reap_orphans`,
# which issues stop/extend. Nothing below this block mutates anything.
if [ "$PREFLIGHT" = "1" ]; then
  pf_state="$(read_or "$STATE_FILE" idle)"
  pf_boxid="$(read_or "$BOXID_FILE" '')"
  printf 'render-conductor preflight\n'
  printf '  cli:         %s\n' "$("$BOAT_BIN" --no-update --version 2>&1 | tr -d '\r\n')"
  printf '  config:      %s/config.json\n' "$BOAT_CFG_DIR"
  printf '  auth:        login accepted\n'
  printf '  state:       %s\n' "$pf_state"
  printf '  recorded id: %s\n' "${pf_boxid:-<none>}"

  # THE CARRY-OVER QUESTION. `--all` spans every state, so a parked render box shows up
  # here exactly as a running one does. If the id this conductor has been driving is
  # listed, the sandbox survived the CLI cutover and the next real tick resumes it; if it
  # is not, the next real tick reprovisions from clean `main`, which is a ~5-minute
  # non-event but worth knowing BEFORE the render window rather than during it.
  if pf_list="$(boat_cli list --all --json 2>&1)"; then
    printf '  sandboxes:   %s known to this account\n' \
      "$(printf '%s' "$pf_list" | grep -o '"id":"' | wc -l | tr -d ' ')"
    if [ -z "$pf_boxid" ]; then
      printf '  carry-over:  nothing recorded — a real tick would provision a fresh box\n'
    elif printf '%s' "$pf_list" | grep -q "\"id\":\"$pf_boxid\""; then
      printf '  carry-over:  YES — %s is still there; a real tick would resume it\n' "$pf_boxid"
    else
      printf '  carry-over:  NO — %s is not listed; a real tick would provision a fresh box\n' "$pf_boxid"
    fi
  else
    printf '  sandboxes:   list FAILED — %s\n' "$(printf '%s' "$pf_list" | tr '\n' ' ')"
    printf '  carry-over:  unknown\n'
  fi

  if [ -s "$ORPHANS_FILE" ]; then
    printf '  orphans:     %s condemned id(s) a real tick would re-issue a TTL on\n' \
      "$(wc -l <"$ORPHANS_FILE" | tr -d ' ')"
  else
    printf '  orphans:     none\n'
  fi

  # The pick, computed exactly as the idle branch computes it — same CLI call, same
  # parser, same poison ledger — so the preflight names the finding a real tick would film.
  if [ -z "${FLUNCLE_API_TOKEN:-}" ]; then
    printf '  queue:       NO agent token — a real tick would fail here\n'
  elif ! pf_queue="$("$FLUNCLE_BIN" admin tracks queue --limit 25 --json 2>>"$LOG_FILE")"; then
    printf '  queue:       read FAILED — a real tick would exit non-zero without waking a box\n'
  elif ! pf_ids="$(printf '%s' "$pf_queue" | "$BUN_BIN" -e "$QUEUE_PARSER" 2>>"$LOG_FILE")"; then
    printf '  queue:       response MALFORMED — a real tick would exit non-zero\n'
  else
    pf_pick=""
    pf_skipped=0
    while IFS= read -r pf_lid; do
      [ -n "$pf_lid" ] || continue
      if is_poisoned "$pf_lid"; then
        pf_skipped=$((pf_skipped + 1))
        continue
      fi
      pf_pick="$pf_lid"
      break
    done <<PFQ
$pf_ids
PFQ
    printf '  queue:       %s renderable pick, %s poisoned skip(s)\n' \
      "${pf_pick:-no}" "$pf_skipped"
  fi

  printf '  would do:    nothing — preflight creates, resumes, stops and extends NOTHING\n'
  emit "render-conductor: preflight only — no box was touched"
  exit 0
fi

# Drain any box a previous tick condemned but could not delete. Deliberately BEFORE the
# state machine and on every tick (idle or rendering): a wedged box is exactly the case
# where the next tick is busy rendering on its replacement, so gating this on idle would
# leave the orphan standing for as long as the render runs. No-ops on an empty ledger.
reap_orphans

state="$(read_or "$STATE_FILE" idle)"
boxid="$(read_or "$BOXID_FILE" '')"

# ============================ RENDERING: poll ============================
if [ "$state" = "rendering" ]; then
  RUN_CHECKED=$((RUN_CHECKED + 1))
  if [ -z "$boxid" ]; then
    printf 'idle' >"$STATE_FILE"
    RUN_FAILED=$((RUN_FAILED + 1))
    emit "render-conductor: rendering state with no box id — reset to idle"
    exit 0
  fi

  # Done-marker present -> the detached render finished (it already shipped, or
  # failed). Park the box and return to idle either way; a non-zero render is
  # caught next idle tick (the finding is still queued if ship never ran).
  #
  # FRESHNESS GUARD: the box's /home/user persists across stop/resume snapshots, so a
  # done-marker from a PREVIOUS render can outlive it. render-detached.sh rm's the marker
  # before forking — but ONLY if its trigger actually ran; a wedged box (boat.dev 5xx on
  # ssh/scp) silently no-ops the trigger, leaving the OLD marker in place. A bare `test -f`
  # then reads that stale marker as "finished", parks, and chains to the SAME never-shipped
  # finding — forever (the 2026-07-09 loop: a 07-08 marker re-picking 039.8.7J every tick).
  # So trust the marker only when its finish time (`@ <iso>`) is at/after this render's
  # start (minus clock skew). A stale/undated marker is treated as still-in-flight and the
  # stuck-guard below force-parks it, rather than a false "finished".
  marker_fresh=0
  result='?'
  if boat_cli ssh "$boxid" "test -f $DONE_MARKER" >/dev/null 2>&1; then
    result="$(boat_cli ssh "$boxid" "cat $DONE_MARKER" 2>/dev/null | tr -d '\r\n' || printf '?')"
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
    boat_cli stop "$boxid" >/dev/null 2>&1 || true
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
          RUN_PRODUCED=$((RUN_PRODUCED + 1))
        else
          log "render EXIT=0 but $rendered_logid still has no video — false success, counting as a failure"
          bump_fail "$rendered_logid"
          # STALL WARNING one failure ahead of the poison alert: two consecutive clean
          # exits with no video landing is the silent-waste signature (a whole render's
          # tokens burned twice with nothing shipped) — page the operator an hour before
          # the poison threshold instead of after a third burn.
          stall_count="$(awk -F'\t' -v id="$rendered_logid" '$1==id{print $2+0}' "$FAILS_FILE" 2>/dev/null || printf 0)"
          if [ "${stall_count:-0}" -eq $((POISON_THRESHOLD - 1)) ]; then
            discord_alert "render conductor: STALL WARNING — $rendered_logid exited clean ${stall_count}x with no video landing; one more poisons it ($API_URL/admin)"
          fi
        fi
        ;;
      '' | *[!0-9]*) RUN_FAILED=$((RUN_FAILED + 1)) ;; # unparseable exit — leave the poison ledger untouched
      *) bump_fail "$rendered_logid" ;;
    esac
    # Chain: fall out of the rendering block to the idle pick in THIS tick — a
    # finished render must not cost a dead hour. The hourly START gate below
    # still holds (the last start is over an hour old once a render finishes).
  else
    # Still running -> single-flight: do NOT start another. Stuck guard only.
    started="$(read_or "$STARTED_FILE" 0)"
    if [ "$(( $(now) - started ))" -gt "$MAX_RENDER" ]; then
      boat_cli stop "$boxid" >/dev/null 2>&1 || true
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
  emit_fail "render-conductor: no agent token"
  exit 1
fi
# Read a WINDOW of the queue (oldest first), not just the head, so a poisoned head can be
# stepped over. The natural order is preserved: the pick is the oldest finding that is NOT
# currently poisoned. 25 is far past any realistic simultaneous-poison count. The read is
# fail-closed: a failed CLI call or a response outside the CLI's `{ok:true,tracks:[…]}` contract
# is a RUN error, never evidence that the queue is empty.
queue_json="$("$FLUNCLE_BIN" admin tracks queue --limit 25 --json 2>>"$LOG_FILE")"
queue_read_rc=$?
if [ "$queue_read_rc" -ne 0 ]; then
  # The one non-failure: the CLI's JSON failure payload carrying the Worker's typed due-work code.
  # Any other non-zero read (a generic fault, a crash, a malformed payload) stays a run error.
  if printf '%s' "$queue_json" | "$BUN_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let body;try{body=JSON.parse(s)}catch{process.exit(1)}process.exit(body&&typeof body==="object"&&!Array.isArray(body)&&body.ok===false&&body.code==="due_work_maintenance_pending"?0:1)})' 2>>"$LOG_FILE"; then
    log "queue read deferred: due-work repair is still converging (rc=$queue_read_rc)"
    emit_repair_pending "render-conductor: queue read deferred — due-work repair still converging"
    exit 0
  fi
  log "queue read failed (rc=$queue_read_rc)"
  emit_fail "render-conductor: queue read failed"
  exit 1
fi
queued_ids="$(printf '%s' "$queue_json" | "$BUN_BIN" -e "$QUEUE_PARSER" 2>>"$LOG_FILE")"
queue_parse_rc=$?
if [ "$queue_parse_rc" -ne 0 ]; then
  log "queue response malformed (parser rc=$queue_parse_rc)"
  emit_fail "render-conductor: queue response malformed"
  exit 1
fi
head=""; skipped=0
while IFS= read -r lid; do
  [ -n "$lid" ] || continue
  RUN_CHECKED=$((RUN_CHECKED + 1))
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

# Ensure the box exists: resume the parked snapshot, or reprovision if boat.dev
# reclaimed it (idle boxes + snapshots are purged past the archive window).
# The resume is BOUNDED (RESUME_TIMEOUT) because the CLI's own resume blocks on readiness
# for up to half an hour, which would eat the whole tick. A resume that does not finish in
# time is NOT a dead box: the API keeps converging, so the tick holds the id and lets the
# next one pick it up. Only an id boat.dev no longer lists is safe to abandon — walking
# away from a live one would strand a running sandbox nothing will stop.
resume_rc=0
if [ -n "$boxid" ]; then
  run_bounded "$RESUME_TIMEOUT" "$BOAT_BIN" --no-update resume "$boxid" >/dev/null 2>&1 || resume_rc=$?
else
  resume_rc=1
fi
if [ -n "$boxid" ] && [ "$resume_rc" != "0" ] && box_present "$boxid"; then
  log "resume of $boxid did not complete (rc=$resume_rc) but boat.dev still lists it — holding the id for the next tick"
  emit "render-conductor: resume of $boxid still converging — holding"
  exit 0
fi
if [ -n "$boxid" ] && [ "$resume_rc" = "0" ]; then
  log "resumed box $boxid"
  # WAIT OUT THE RESTORE (see await_box_ready): a resume can report ready before the box
  # serves ssh, and every call inside that window fails with the typed restoring code.
  # Gate the first contact here so the burst never reaches the trigger's wedge check as a
  # false condemn.
  await_box_ready "$boxid" || log "no ready signal from $boxid — proceeding; the trigger check decides"
  # A resume can succeed while boat.dev's snapshot dropped ~/fluncle. freshen_checkout
  # returns 2 in that case: stop the checkout-less box (it renders nothing) and fall
  # through to a fresh reprovision, so a lost checkout self-heals instead of looping on
  # a stale done-marker.
  if ! freshen_checkout "$boxid"; then
    log "resumed box $boxid lost its ~/fluncle checkout — stopping it + reprovisioning"
    boat_cli stop "$boxid" >/dev/null 2>&1 || true
    boxid=""
  # The checkout freshens above, but the CLI does NOT ride the checkout: provision
  # copies the conductor's bundled binary ONCE, so a resumed snapshot keeps that
  # vintage forever while the pin moves on (a register-aware upload needs a newer
  # binary than the box may have been provisioned with). Re-copy it at every wake —
  # one small scp against an ~85m render — and BEST-EFFORT: a failed copy logs and
  # renders on the existing CLI (the same discipline as freshen itself).
  elif boat_cli scp "$FLUNCLE_BIN" "$boxid:/home/user/.local/lib/fluncle.mjs" >>"$LOG_FILE" 2>&1; then
    log "box CLI refreshed from the conductor's bundled fluncle"
  else
    log "box CLI refresh failed — rendering with the existing CLI"
  fi
  # render-detached.sh lives at ~/ (NOT inside the ~/fluncle checkout), so freshen_checkout
  # can't update it — re-scp it every wake like the CLI above, or a resumed box keeps the
  # render-detached.sh it was PROVISIONED with (its --model pin, its entry) frozen forever.
  if [ -n "$boxid" ]; then
    if boat_cli scp "$SCRIPT_DIR/render-detached.sh" "$boxid:/home/user/render-detached.sh" >>"$LOG_FILE" 2>&1; then
      boat_cli ssh "$boxid" 'chmod +x ~/render-detached.sh' >/dev/null 2>&1 || true
      log "render-detached.sh refreshed from the conductor's bundled copy"
    else
      log "render-detached.sh refresh failed — rendering with the box's existing copy"
    fi
  fi
else
  # Either there was no id to begin with, or the resume failed AND boat.dev no longer
  # lists the id — the sandbox is genuinely gone, so provisioning a fresh one strands
  # nothing.
  [ -n "$boxid" ] && log "resume of $boxid failed (rc=$resume_rc) and boat.dev does not list it — reprovisioning"
  boxid=""
fi

if [ -z "$boxid" ]; then
  log "no usable box — reprovisioning"
  if ! boxid="$(BOAT_BIN="$BOAT_BIN" BUN_BIN="$BUN_BIN" FLUNCLE_BIN="$FLUNCLE_BIN" bash "$PROVISION" 2>>"$LOG_FILE")" || [ -z "$boxid" ]; then
    log "provision failed"
    emit_fail "render-conductor: provision failed"
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
  # THE ASSIGNED FINDING (poison↔queue coherence): the render agent must film the
  # SAME finding this conductor accounts for. Before this, the agent re-read the
  # queue itself and could re-pick a head the conductor had just poison-skipped —
  # the fail counter then bumped an innocent finding while the offender burned
  # tokens uncounted (2026-07-19: 049.4.4G took fail #2 for 049.7.6B's renders).
  # The prompt treats this as THE pick when set; its videoUrl guard keeps re-runs safe.
  printf 'export FLUNCLE_RENDER_LOG_ID=%s\n' "$head"
  # The plate lane: the render agent authors photographic plates via Gemini. The key
  # arrives here from the 1P-injected sweep secrets; absent -> the agent's documented
  # procedural fallback (never a failure).
  printf 'export GEMINI_API_KEY=%s\n' "${GEMINI_API_KEY:-}"
} >"$creds"

# DETERMINISTIC DIVERSITY AXES (docs/planning/homogenisation-evidence.md; ROADMAP
# § Homogenisation): diversity must be DESIGNED IN UP FRONT — assign the grain family,
# register, and a palette-avoid directive from the vehicles ledger BEFORE the render, so
# the agent's creativity lives inside a fixed cell instead of eyeballing recent posters
# (which produced the amber/halftone attractor anyway). assign-video-axes.ts reads the
# ledger on stdin and emits `FLUNCLE_VIDEO_*` env lines; we append them to the box env.
# FAIL-OPEN by contract: any hiccup (the assigner errors, bun/fluncle missing) leaves the
# vars absent and the render falls back to today's free-choice behaviour — an axis assign
# NEVER blocks a render. The box sources this file with `set -a`, so bare KEY='value'
# lines export.
axes="$("$FLUNCLE_BIN" admin tracks vehicles --json 2>>"$LOG_FILE" | "$BUN_BIN" "$SCRIPT_DIR/assign-video-axes.ts" 2>>"$LOG_FILE" || printf '')"
if [ -n "$axes" ]; then
  printf '%s\n' "$axes" >>"$creds"
  log "assigned video axes: $(printf '%s' "$axes" | tr '\n' ' ')"
else
  log "video-axis assigner produced no assignment — render falls back to free choice"
fi

boat_cli scp "$creds" "$boxid:/dev/shm/fluncle.env" >/dev/null 2>&1
rm -f "$creds"

# Trigger the DETACHED render (returns immediately; ~85m on the box). The box is
# NOT stopped here — a later RENDERING tick parks it when the done-marker appears.
# VERIFY THE LAUNCH: render-detached.sh echoes "render-detached: launched" and, before
# forking, rm's any prior done-marker. A wedged box (boat.dev 5xx on ssh) silently
# no-ops this trigger; marking 'rendering' anyway would leave the OLD marker to be
# misread as 'finished' next tick — the stale-marker loop. If the launch line doesn't
# come back, the box is wedged: delete it + stay idle so a FRESH box provisions next
# tick, rather than looping on the dead one. (The freshness guard above is the second
# line of defence; this stops the wedge at the source.)
trigger_out="$(boat_cli ssh "$boxid" 'bash ~/render-detached.sh' 2>&1)"
printf '%s\n' "$trigger_out" >>"$LOG_FILE"
if ! printf '%s' "$trigger_out" | grep -q 'render-detached: launched'; then
  log "render trigger did not launch on $boxid (wedged box) — deleting it + staying idle to reprovision"
  RUN_FAILED=$((RUN_FAILED + 1))
  emit_fail "render-conductor: render trigger failed on $boxid — box condemned, reprovision next tick"
  # condemn_box retries the delete and, if boat.dev still will not take it, files the id
  # to the orphan ledger. Clearing BOXID_FILE below is what makes the next tick provision a
  # fresh box, so the id MUST be written down first or it is lost with this variable.
  condemn_box "$boxid" || true
  : >"$BOXID_FILE"
  printf 'idle' >"$STATE_FILE"
  exit 1
fi
printf 'rendering' >"$STATE_FILE"
now >"$STARTED_FILE"
printf '%s' "$head" >"$RENDER_LOGID_FILE" # the finding this render is spending on (cost scope)
log "started detached render of $head on box $boxid"
RUN_PRODUCED=$((RUN_PRODUCED + 1))
emit "render-conductor: started render of $head on $boxid"
exit 0
