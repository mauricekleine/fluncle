#!/usr/bin/env bash
# fluncle-pin-watch — the rave-02 box's self-deploy.
#
# Watches main's baked CLI pins (the `fluncle` + Claude Code versions in
# docs/agents/hermes/Dockerfile) AND main's baked content — everything that
# Dockerfile COPYs (the sweep scripts, ALL of packages/skills, the baked font),
# plus the Dockerfile itself — against what the running Hermes
# container has; when main is ahead on EITHER, rebuilds the image and swaps the
# container — with a
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
# `--fingerprint` prints the watched paths + the current hash and exits (no
# docker, no network, no sync) — the cheap way to see what the box is watching.
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
KEEP_IMAGES="${PINWATCH_KEEP_IMAGES:-2}"  # running + 1 rollback; each hermes image is ~10GB, so 4 fills the 38GB box
SWEEP_DRAIN_TIMEOUT="${PINWATCH_SWEEP_DRAIN_TIMEOUT:-300}"  # max seconds to wait for an in-flight sweep to finish before the rebuild proceeds anyway

# ── the container resource ceiling (ONE source of truth) ──────────────────────
# Every path that (re)creates the live container — the swap AND the rollback — goes
# through `run_container`, which reads only these. A recreate must never quietly hand
# the agent a smaller box than the operator gave it: a ceiling that lives in the
# `docker run` line is re-applied verbatim on every rebake, so a hand-raised limit is
# erased by the next tick and the agent is back to throttled CPU periods and cgroup OOM
# kills with the host sitting idle.
#
# Two rails keep the ceiling durable:
#   1. These defaults (env-overridable, validated below — a bad value refuses loudly
#      rather than silently falling back to something smaller).
#   2. `preserve_live_ceiling`, which reads the LIVE container's own limits before the
#      swap and keeps whichever is higher. An operator `docker update --cpus … --memory …`
#      therefore survives every later rebake without editing this file.
# The host runs with no swap, so `--memory-swap` always equals `--memory`.
HERMES_CPUS="${PINWATCH_CPUS:-3}"
HERMES_MEMORY_GIB="${PINWATCH_MEMORY_GIB:-6}"

# The inherited s6 bootstrap needs CHOWN/DAC_OVERRIDE/FOWNER for /opt/data, SETUID/SETGID to enter hermes, and KILL to supervise that uid.
CONTAINER_SECURITY_ARGS=(
  --security-opt no-new-privileges
  --cap-drop ALL
  --cap-add CHOWN
  --cap-add DAC_OVERRIDE
  --cap-add FOWNER
  --cap-add KILL
  --cap-add SETGID
  --cap-add SETUID
)

MODE="--if-stale"
case "${1:-}" in
  --force) MODE="--force" ;;             # rebuild regardless of drift (the operator pilot)
  --dry-run) MODE="--dry-run" ;;         # build + pre-smoke the new image, then STOP (never swap)
  --fingerprint) MODE="--fingerprint" ;; # print the watched paths + the fingerprint at REPO_DIR HEAD, then STOP
esac

log() { printf '[pin-watch] %s\n' "$*" >&2; }
die() { ERRORS=1; log "FATAL: $*"; exit 1; }

# ── the run ledger ────────────────────────────────────────────────────────────
# WHY A SELF-DEPLOY REPORTS A RUN AT ALL. This unit already alerts Discord and posts the
# `self-deploy` /status row, and both are per-attempt signals an operator has to be watching in
# the moment. What it had no place in was the LEDGER — the durable, queryable record every other
# rave-02 unit writes and `fluncle admin telemetry read` reads — so a build that failed on every
# hourly tick for days left nothing behind to ask about after the fact. A self-deploy is the same
# shape as the watchdog next door: it legitimately produces NOTHING for weeks, so `produced == 0`
# says nothing about its health and only the denominator and the error count do.
#
# So every attempt past the single-flight lock ends with one summary line and one POST:
# `checked` (1 once this tick actually read the box's versions against main's), `produced` (1 when
# a new image was deployed), `errors` (1 on any FATAL path), and `queue_depth` (1 while drift is
# known and undeployed). A build that keeps failing therefore writes the ledger's designed alarm —
# `produced == 0 AND queue_depth > 0` — every hour, and its exit code makes the derived verdict
# `ok: false`. A tick that dies before it can even compare versions reports `checked: 0`, which is
# the one shape a blind run must never be able to hide behind.
RUN_EVENT_UNIT="fluncle-pin-watch"
# MIRRORS pin-watch.timer's own `OnUnitActiveSec=1h`; run-events.test.ts pins the pair in lockstep.
RUN_EVENT_INTERVAL_MS=3600000

CHECKED=0
DEPLOYED=0
ERRORS=0
DRIFT=0
SUMMARY_EMITTED=0
STARTED_AT=""
ENVTMP=""

# Read one KEY out of the LIVE container's env — the credential-free read this script already
# uses for the webhook and the agent token. Container down ⇒ empty ⇒ the caller degrades.
container_env() {
  docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | sed -n "s/^$1=//p" | head -1 || true
}


# ── ceiling arithmetic ────────────────────────────────────────────────────────
# Held in docker's own integer units — nanocpus (what `HostConfig.NanoCpus` reports) and
# bytes (`HostConfig.Memory`) — so comparing the configured ceiling against the live one
# is exact integer arithmetic. bash has no floats, and `--cpus` is allowed a decimal.
to_nanocpus() {
  local whole="${1%%.*}" frac=""
  case "$1" in *.*) frac="${1#*.}" ;; esac
  frac="${frac}000000000"
  printf '%d' "$((10#${whole:-0} * 1000000000 + 10#${frac:0:9}))"
}

# Back to a `--cpus` argument. Three decimals is docker's own resolution for the flag.
from_nanocpus() { printf '%d.%03d' "$(($1 / 1000000000))" "$((($1 % 1000000000) / 1000000))"; }

validate_ceiling() {
  case "$HERMES_CPUS" in
    '' | *[!0-9.]* | *.*.* | .* | *.) die "PINWATCH_CPUS='$HERMES_CPUS' is not a CPU count (a positive number, e.g. 3 or 2.5)" ;;
  esac
  case "$HERMES_MEMORY_GIB" in
    '' | *[!0-9]*) die "PINWATCH_MEMORY_GIB='$HERMES_MEMORY_GIB' is not a whole number of GiB (e.g. 6)" ;;
  esac
  CEILING_NANOCPUS="$(to_nanocpus "$HERMES_CPUS")"
  CEILING_MEMORY_BYTES="$((10#$HERMES_MEMORY_GIB * 1073741824))"
  # Docker itself refuses below these; refusing here names the variable instead of
  # failing deep inside the swap, where a refusal costs a rollback.
  [ "$CEILING_NANOCPUS" -ge 1000000000 ] || die "PINWATCH_CPUS='$HERMES_CPUS' is below docker's 1 CPU floor"
  [ "$CEILING_MEMORY_BYTES" -ge 1073741824 ] || die "PINWATCH_MEMORY_GIB='$HERMES_MEMORY_GIB' is below the 1 GiB floor the gateway needs"
}

# Keep whichever ceiling is HIGHER: the configured default, or what the live container is
# already running with. Read while the old container still exists (before the swap), so an
# operator raise made with `docker update` is carried into the new container rather than
# erased. A lower live value is NOT adopted — the defaults above are the floor.
preserve_live_ceiling() {
  local live_nanocpus live_memory
  live_nanocpus="$(docker inspect "$CONTAINER" --format '{{.HostConfig.NanoCpus}}' 2>/dev/null || true)"
  live_memory="$(docker inspect "$CONTAINER" --format '{{.HostConfig.Memory}}' 2>/dev/null || true)"
  case "$live_nanocpus" in '' | *[!0-9]*) live_nanocpus=0 ;; esac
  case "$live_memory" in '' | *[!0-9]*) live_memory=0 ;; esac
  if [ "$live_nanocpus" -gt "$CEILING_NANOCPUS" ]; then
    log "keeping the live CPU ceiling ($(from_nanocpus "$live_nanocpus")) — higher than the configured $(from_nanocpus "$CEILING_NANOCPUS")"
    CEILING_NANOCPUS="$live_nanocpus"
  fi
  if [ "$live_memory" -gt "$CEILING_MEMORY_BYTES" ]; then
    log "keeping the live memory ceiling ($((live_memory / 1073741824)) GiB) — higher than the configured $((CEILING_MEMORY_BYTES / 1073741824)) GiB"
    CEILING_MEMORY_BYTES="$live_memory"
  fi
  log "container ceiling: --cpus=$(from_nanocpus "$CEILING_NANOCPUS") --memory=${CEILING_MEMORY_BYTES}b (no swap)"
}

validate_ceiling

# Discord alert (best-effort; never throws). Defined UP HERE — ahead of the path-set
# resolution below, which alerts when it has to fall back — while $WEBHOOK is still read
# later, off the LIVE container's env. Hence `${WEBHOOK:-}`: an alert fired before that
# read (or on the docker-free --fingerprint path, which never reads it) is a silent no-op
# rather than an unbound-variable crash.
alert() {
  [ -n "${WEBHOOK:-}" ] || return 0
  curl -fsS -m 10 -H 'Content-Type: application/json' \
    -d "$(printf '{"content":%s}' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')")" \
    "$WEBHOOK" >/dev/null 2>&1 || true
}

# >>> BEGIN MIRRORED BLOCK: record_run_event — keep BYTE-IDENTICAL across all four copies >>>
# The run-ledger emitter. FOUR scripts carry this block verbatim, because they run on two
# different boxes with no shared bash library between them: the ~41 container sweeps get it by
# sourcing this file, and the three host units are each laid down as a lone file
# (install-host-timers.sh copies only the script an ExecStart names; the sonar freshen lives on
# another box entirely). `run-events.test.ts` compares the four copies byte for byte, so a
# silent drift fails the build — the same mirror-plus-drift-test posture cost-emit.ts already
# uses for the cost ledger.
#
# THE CONTRACT is owned by the agent-tier `record_run` oRPC op in
# packages/contracts/src/orpc/admin-telemetry.ts, which a box script cannot import. Mirrored
# here: the endpoint path, the five body fields, and the Bearer auth. If any of them changes in
# the workspace, change it in all four copies.
#
# THE DRIFT TEST IS NOT ENOUGH ON ITS OWN, and this cost a shipped bug: the four copies once
# agreed with EACH OTHER on `/api/v1/admin/runs/events` while the contract declared
# `/admin/telemetry/runs`, so every POST 404'd, the `|| true` swallowed it, the ledger stayed
# empty, and both test suites were green. Byte-equality is a closed loop. So run-events.test.ts
# now RESOLVES this path against the workspace's own surfaces (the contract op paths + the
# `apps/web/src/routes/api/**` file routes) — the assertion that crosses the boundary.
#
# THE BODY CARRIES FACTS ONLY. There is no `ok` field, deliberately: the Worker derives it as
# `exit_code === 0 && (summary.errors ?? 0) === 0`. The nightly Sentry sweep exited 0 for
# eleven nights while printing `{"errors":2,"ok":true}` — a hardcoded literal sitting beside
# the number that contradicted it — so a self-reported `ok` is exactly the thing this ledger
# must not accept.
#
# BEST-EFFORT, ALWAYS: the caller's exit code is never touched and the whole thing is
# hard-timeout bounded. Delivery failure is returned, not swallowed here: the caller decides
# how to surface it without turning a telemetry outage into a failed sweep. The reason is a
# public-safe enum-like string, never a URL, response body, or token.
RUN_EVENT_PATH='/api/v1/admin/telemetry/runs'
# 5s, NOT cost-emit.ts's 15s. That budget was sized for a contended `insert into settings`
# measured at ~8.9s p95 on the PRIMARY database; this is one small insert into the separate
# `fluncle-telemetry` database, which exists precisely so it never queues behind the primary's
# single writer. 5s absorbs a cold isolate plus a slow tick and still sits two orders inside
# the shortest unit TimeoutStartSec on either box.
RUN_EVENT_TIMEOUT_SECS="${RUN_EVENT_TIMEOUT_SECS:-5}"
RUN_EVENT_FAILURE_REASON=""

# Escape one line for a JSON string literal, in pure bash parameter expansion — NOT
# `sed -e 's/\t/\\t/'`, whose `\t` is a GNU extension that silently matches a literal `t` on
# the BSD sed the tests run under. Capped at 4000 chars so a runaway line cannot inflate the
# POST, and stripped of any remaining control character (raw ones are illegal in JSON).
_run_event_json_string() {
  local s="${1:0:4000}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  printf '%s' "$s" | tr -d '\000-\037'
}

# record_run_event <unit> <started_at> <ended_at> <exit_code> <summary_raw>
record_run_event() {
  local unit="$1" started_at="$2" ended_at="$3" exit_code="$4" summary_raw="$5"
  local base token body
  RUN_EVENT_FAILURE_REASON=""
  # `-` NOT `:-`, deliberately. With the colon an EMPTY base fell back to the production
  # URL, which made the guard two lines down unreachable and fired a real POST at
  # www.fluncle.com from every `bun run test:scripts` run in CI. An
  # empty base means THERE IS NO LEDGER HERE, and the guard is the line that says so.
  base="${FLUNCLE_API_BASE_URL-https://www.fluncle.com}"
  base="${base%/}"
  token="${FLUNCLE_API_TOKEN:-}"
  if [ -z "$token" ]; then
    RUN_EVENT_FAILURE_REASON="missing-token"
    return 1
  fi
  if [ -z "$base" ]; then
    RUN_EVENT_FAILURE_REASON="missing-base-url"
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    RUN_EVENT_FAILURE_REASON="curl-unavailable"
    return 1
  fi
  case "$exit_code" in '' | *[!0-9]*) exit_code=0 ;; esac
  body="$(printf '{"unit":"%s","started_at":"%s","ended_at":"%s","exit_code":%s,"summary_raw":"%s"}' \
    "$(_run_event_json_string "$unit")" \
    "$(_run_event_json_string "$started_at")" \
    "$(_run_event_json_string "$ended_at")" \
    "$exit_code" \
    "$(_run_event_json_string "$summary_raw")")"
  if ! curl -fsS -o /dev/null --max-time "$RUN_EVENT_TIMEOUT_SECS" \
    -X POST -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${token}" \
    --data-binary "$body" "${base}${RUN_EVENT_PATH}" >/dev/null 2>&1; then
    RUN_EVENT_FAILURE_REASON="post-failed"
    return 1
  fi
  return 0
}

# The box clock, in the one format every copy sends. DISTINCT from the Worker's own write
# time: a box row's `occurred_at` legitimately precedes its `created_at` under clock skew, and
# the ledger keeps both. Seconds precision on purpose — `date +%3N` is GNU-only.
run_event_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}
# <<< END MIRRORED BLOCK: record_run_event <<<

# Print the run's summary line and POST its run record, exactly once, whatever exit path got
# here. Runs from the EXIT trap so a `die` deep in the script cannot skip it — the shape that
# leaves a ledger row missing is the shape that reads as a missed run.
#
# THE LINE CARRIES NO `ok`. The verdict is `exit_code == 0 && errors == 0` and the Worker computes
# it from the two facts below; a self-reported one is rejected at the edge.
emit_run_summary() {
  local rc="${1:-0}" ended summary
  if [ "$SUMMARY_EMITTED" = "1" ]; then return 0; fi
  SUMMARY_EMITTED=1
  case "$rc" in '' | *[!0-9]*) rc=0 ;; esac
  ended="$(run_event_now)"
  summary="$(printf '{"checked":%d,"produced":%d,"errors":%d,"queue_depth":%d,"gateState":null,"expectedIntervalMs":%d}' \
    "$CHECKED" "$DEPLOYED" "$ERRORS" "$DRIFT" "$RUN_EVENT_INTERVAL_MS")"
  printf '%s\n' "$summary"
  if [ -z "${FLUNCLE_API_TOKEN:-}" ]; then
    FLUNCLE_API_TOKEN="${APITOKEN:-$(container_env FLUNCLE_API_TOKEN)}"
  fi
  record_run_event "$RUN_EVENT_UNIT" "$STARTED_AT" "$ended" "$rc" "$summary" || true
  return 0
}

# THE ONE EXIT PATH. Every cleanup this script owes plus the ledger row, composed once and armed
# once, so there is no later `trap` that can drop one of them: both cleanups are no-ops until the
# state they release exists, and the row is the last thing written.
# shellcheck disable=SC2329  # invoked indirectly from the EXIT trap armed after the lock
pinwatch_on_exit() {
  local rc=$?
  cleanup_gateway_smoke
  restore_sweep_timers
  [ -n "$ENVTMP" ] && rm -f "$ENVTMP"
  emit_run_summary "$rc" || true
  return 0
}

# ── the baked path set (derived from the Dockerfile's own COPY lines) ─────────────────────────
# WHAT the image bakes is decided in exactly one place — the COPY lines in $DOCKERFILE — so the
# fingerprint DERIVES its watch set from them rather than restating it. A hand-kept list drifts:
# it used to name two skill sub-paths while the Dockerfile has long baked `COPY packages/skills`
# WHOLESALE, so a new or edited skill rode into the image without ever moving the fingerprint and
# the box ran it stale until some unrelated change happened to force a rebuild. Deriving makes
# a new COPY self-covering — there is nothing here to remember to update.
#
# The parser is deliberately narrow, because the Dockerfile is ours: single-stage, plain-form
# COPY. Take each COPY line, skip `--from=` (a stage/image source, not a repo path), drop the
# remaining `--flag` tokens, and treat every token but the last (the destination) as a source.
# The Dockerfile itself is appended separately — it is the recipe, never a COPY source.
#
# THE RAIL: if a COPY ever takes a shape this cannot read (JSON-array form, a `\` continuation,
# a build-arg inside a path) the validation below fails the derived set over to
# BAKED_PATHS_FALLBACK — a coarse SUPERSET of every root the image bakes today — and alerts. The
# box then over-rebuilds instead of silently running stale content, which is the safe direction.
# Keep the fallback a superset if the Dockerfile ever COPYs from a new top-level root.
BAKED_PATHS_FALLBACK=(
  docs/agents/hermes
  packages/skills
  apps/cli/assets/fonts
)
BAKED_PATHS=()

# Emit the COPY sources declared in the Dockerfile at REPO_DIR HEAD, one per line, deduped.
derive_baked_paths() {
  awk '
    toupper($1) == "COPY" {
      if ($0 ~ /--from=/) next
      n = 0
      for (i = 2; i <= NF; i++) if ($i !~ /^--/) tok[++n] = $i
      for (i = 1; i < n; i++) { sub(/\/+$/, "", tok[i]); print tok[i] }
    }
  ' "$REPO_DIR/$DOCKERFILE" | LC_ALL=C sort -u
}

# Every derived path must be a plain repo path that actually resolves in HEAD's tree. An
# unmatched pathspec is the dangerous case: `git ls-tree` exits 0 and prints NOTHING, so a
# mis-parsed path would silently shrink the fingerprint instead of erroring.
validate_baked_paths() {
  local p matched
  [ "${#BAKED_PATHS[@]}" -gt 0 ] || return 1
  for p in "${BAKED_PATHS[@]}"; do
    case "$p" in '' | -* | /* | *'$'* | *'"'* | *"'"* | *'['*) return 1 ;; esac
    matched="$(git -C "$REPO_DIR" ls-tree -r HEAD -- "$p")"
    [ -n "$matched" ] || return 1
  done
}

resolve_baked_paths() {
  # A while-read loop rather than `mapfile`, which is bash 4+: the box has it and the machine
  # this script is TESTED on does not, and an untestable self-deploy is how it stayed silent.
  local line
  BAKED_PATHS=()
  while IFS= read -r line; do
    [ -n "$line" ] && BAKED_PATHS+=("$line")
  done < <(derive_baked_paths)
  BAKED_PATHS+=("$DOCKERFILE")
  if validate_baked_paths; then
    log "baked paths (derived from the $DOCKERFILE COPY set): ${BAKED_PATHS[*]}"
    return 0
  fi
  BAKED_PATHS=("${BAKED_PATHS_FALLBACK[@]}")
  log "WARNING: could not derive the baked paths from $DOCKERFILE — using the coarse fallback: ${BAKED_PATHS[*]}"
  alert "⚠️ pin-watch: could not parse the COPY set in $DOCKERFILE — fingerprinting the coarse fallback paths instead. The box still rebuilds (it over-triggers), but the parser needs a look."
}

# A deterministic fingerprint of the baked content at REPO_DIR HEAD. `git ls-tree -r` emits the
# mode+type+blob-sha+path of every file under those paths, so any content change moves it. It reads
# only HEAD's tree — no history — so it is safe on the depth-1 shallow clone. Sorted before hashing
# so the hash depends on the CONTENT of the watched set, never on pathspec order.
baked_fingerprint() {
  git -C "$REPO_DIR" ls-tree -r HEAD -- "${BAKED_PATHS[@]}" | LC_ALL=C sort | sha256sum | cut -d' ' -f1
}

# `--fingerprint`: answer "what is this box watching, and what does it hash to?" without touching
# docker, the network, or the live container. Reads REPO_DIR's checkout exactly as it stands (no
# fetch, no reset), so it is safe to point at any checkout via PINWATCH_REPO_DIR.
if [ "$MODE" = "--fingerprint" ]; then
  command -v git >/dev/null || die "git not found"
  [ -d "$REPO_DIR/.git" ] || die "no git checkout at $REPO_DIR (set PINWATCH_REPO_DIR)"
  resolve_baked_paths
  printf 'paths: %s\n' "${BAKED_PATHS[*]}"
  printf 'fingerprint: %s\n' "$(baked_fingerprint)"
  exit 0
fi

# ── sweep quiesce (serialize the docker-heavy rebuild against the box's sweeps) ─
# The rebuild's `docker build` + throwaway pre-smoke `docker run`s contend hard with
# the daemon (buildkit "only one connection allowed", rapid container create/delete).
# A sweep timer (fluncle-embed / fluncle-enrich / …) firing its own `docker run`
# mid-rebuild gets SIGKILLed (137) by that churn — confirmed on rave-02, NOT an OOM.
# It self-heals next tick but fires a false failure alert every time a rebuild overlaps
# a sweep (~daily). So before the first `docker build` we STOP the active sweep timers,
# drain any sweep already mid-run, and GUARANTEE a restart via the EXIT trap.
STOPPED_TIMERS=()
GATEWAY_SMOKE_CONTAINER=""

cleanup_gateway_smoke() {
  [ -n "$GATEWAY_SMOKE_CONTAINER" ] || return 0
  docker rm -f "$GATEWAY_SMOKE_CONTAINER" >/dev/null 2>&1 || true
  GATEWAY_SMOKE_CONTAINER=""
}

# The rebake LOCK — the half of the quiesce that covers what stopping timers cannot: a
# MANUAL `systemctl start fluncle-<job>.service` walking into the build/swap window. The
# container swap TERMs every in-flight `docker exec` (measured twice: exit 143 mid-tick,
# 2026-07-26 12:27 and 2026-07-27 04:34 — both manually-triggered sweeps; a pre-check
# races the swap, so the sweep itself must see the window). Written into the /opt/data
# mount so the BAKED sweeps can read it (cron-output.sh skips the tick when it is
# present, with a >45-min staleness escape so a hard-killed rebuild can never wedge the
# roster). Removed in restore_sweep_timers, which the EXIT trap already guarantees.
REBAKE_LOCK=""

# Re-arm ONE timer that came back from the quiesce with no next elapse. These timers fire
# once on OnBootSec and then ride OnUnitActiveSec, which systemd measures from the
# SERVICE's last activation — so stopping one BEFORE its one-shot boot fire and starting
# it again afterwards can leave it with no reference point at all: `active`, yet
# NextElapse=infinity, never firing again. Persistent=true is what makes that permanent
# (its stamp file reads as the last trigger, so systemd declines to re-fire the elapsed
# OnBootSec) — see ../timer-watchdog/README.md for the reproduction. A reboot landing
# inside this quiesce window did exactly that on 2026-07-28 and killed seven sweeps for
# 13h with every health signal still green.
# Activating the service once restores the reference point. --no-block so a long sweep
# never holds the EXIT trap open; a busy service is skipped (its infinity is just the
# in-flight tick). Returns 0 only when it actually re-armed something.
# shellcheck disable=SC2329  # invoked indirectly from the EXIT trap set in quiesce_sweeps
rearm_stalled_timer() {
  local timer="$1" service="${1%.timer}.service" mono real
  mono="$(systemctl show "$timer" -p NextElapseUSecMonotonic --value 2>/dev/null)"
  real="$(systemctl show "$timer" -p NextElapseUSecRealtime --value 2>/dev/null)"
  [ "$mono" = "infinity" ] && [ -z "$real" ] || return 1
  case "$(systemctl show "$service" -p ActiveState --value 2>/dev/null)" in
    active | activating | reloading | deactivating) return 1 ;;
  esac
  systemctl start --no-block "$service" >/dev/null 2>&1 || return 1
  log "re-armed ${timer} (restored with no next elapse; kicked ${service} once)"
}

# Restart EXACTLY the timers we stopped, best-effort so one failing start never strands
# the rest. Runs from the EXIT trap, so it fires on success, on die(), on a build/smoke
# failure, AND on the rollback path — a failed rebuild must never leave sweeps disabled.
# shellcheck disable=SC2329  # invoked indirectly from the EXIT trap set in quiesce_sweeps
restore_sweep_timers() {
  if [ -n "$REBAKE_LOCK" ]; then
    rm -f "$REBAKE_LOCK" 2>/dev/null || true
    REBAKE_LOCK=""
  fi
  [ "${#STOPPED_TIMERS[@]}" -gt 0 ] || return 0
  local t rearmed=0
  for t in "${STOPPED_TIMERS[@]}"; do
    systemctl start "$t" >/dev/null 2>&1 || true
    # `if` so the common not-stranded return of 1 can never trip `set -e` from the EXIT trap.
    if rearm_stalled_timer "$t"; then
      rearmed=$((rearmed + 1))
    fi
  done
  if [ "$rearmed" -gt 0 ]; then
    log "restored ${#STOPPED_TIMERS[@]} sweep timer(s); re-armed ${rearmed} that came back with no next elapse"
  else
    log "restored ${#STOPPED_TIMERS[@]} sweep timer(s)"
  fi
  STOPPED_TIMERS=()
}

quiesce_sweeps() {
  local t svc waited
  # Enumerate the ACTIVE sweep timers dynamically (new sweeps are auto-covered),
  # EXCLUDING the healthcheck beacon (its dead-man's-switch must keep pinging through
  # the rebake) and pin-watch itself (never stop the timer that scheduled this run).
  # pin-watch is `pin-watch.timer`, already outside the fluncle-* glob; the exclude is
  # listed defensively in case it is ever renamed to fluncle-pin-watch.timer.
  # --plain drops the leading status glyph so $1 is the bare unit name.
  # A while-read loop, not `mapfile` — see resolve_baked_paths for why this stays bash-3 clean.
  STOPPED_TIMERS=()
  while IFS= read -r t; do
    [ -n "$t" ] && STOPPED_TIMERS+=("$t")
  done < <(
    systemctl list-units --type=timer --state=active --no-legend --plain 'fluncle-*.timer' 2>/dev/null \
      | awk '{print $1}' \
      | grep -vxF 'fluncle-healthcheck.timer' \
      | grep -vxF 'fluncle-pin-watch.timer' || true
  )
  [ "${#STOPPED_TIMERS[@]}" -gt 0 ] || { log "no active sweep timers to quiesce"; return 0; }

  # The restart guard needs no trap of its own: `pinwatch_on_exit` has been armed since the lock
  # and already calls restore_sweep_timers, which is a no-op until STOPPED_TIMERS is populated
  # just above. One trap, armed once, is what makes that guarantee unconditional.

  # Drop the rebake lock into the live container's /opt/data mount (resolved from the
  # container, never assumed — the script runs as root, `~` would be /root). Best-effort:
  # a missing mount just means no lock, which is today's behavior, not a failure.
  local lock_src
  lock_src="$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/opt/data"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)"
  if [ -n "$lock_src" ] && [ -d "$lock_src" ]; then
    REBAKE_LOCK="${lock_src}/rebake.lock"
    date -u +%FT%TZ > "$REBAKE_LOCK" 2>/dev/null || REBAKE_LOCK=""
    [ -n "$REBAKE_LOCK" ] && log "rebake lock held: $REBAKE_LOCK"
  fi

  for t in "${STOPPED_TIMERS[@]}"; do
    systemctl stop "$t" >/dev/null 2>&1 || true
  done
  log "quiesced ${#STOPPED_TIMERS[@]} sweep timer(s) for the rebuild: ${STOPPED_TIMERS[*]}"

  # Drain: wait (bounded) for any sweep already mid-run to finish, so the rebuild does
  # not kill it with the very contention we are avoiding. Poll the .service twin of each
  # stopped .timer; on timeout, log and proceed (a rare stuck sweep must not block forever).
  for t in "${STOPPED_TIMERS[@]}"; do
    svc="${t%.timer}.service"
    waited=0
    while systemctl is-active --quiet "$svc"; do
      if [ "$waited" -ge "$SWEEP_DRAIN_TIMEOUT" ]; then
        log "drain timeout (${SWEEP_DRAIN_TIMEOUT}s): $svc still active — proceeding with the rebuild"
        break
      fi
      sleep 3
      waited=$((waited + 3))
    done
  done
}

# ── single-flight ─────────────────────────────────────────────────────────────
exec 9>"$LOCK"
flock -n 9 || { log "another run holds the lock; exiting"; exit 0; }

# From here on this IS the tick, so arm the one exit path: cleanups plus the ledger row. A
# lock-losing run deliberately reports nothing — the run that holds the lock is the attempt.
STARTED_AT="$(run_event_now)"
trap 'pinwatch_on_exit' EXIT

command -v docker >/dev/null || die "docker not found"
command -v git >/dev/null || die "git not found"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "container '$CONTAINER' not running — refusing to act (an operator must (re)provision it)"

# The webhook is read from the LIVE container's env (see alert() above), so we never
# need a config file.
WEBHOOK="$(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^DISCORD_ALERT_WEBHOOK=//p' | head -1 || true)"

# Self-deploy health → the public /status board (the `self-deploy` row). Reuses
# the agent token already in the LIVE container's env (the same token the
# pre-smoke role-boundary probe uses) — nothing is written to disk, nothing is read from `op`.
# Best-effort, never throws; the message is public-safe and deliberately vague
# (no host, no tool VERSIONS — those are internal — and no raw error). The Discord
# alerts below DO carry versions; they go to the operator, not the public board.
# status ∈ ok|degraded|down.
WORKER_URL="${PINWATCH_WORKER_URL:-https://www.fluncle.com}"
APITOKEN="$(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^FLUNCLE_API_TOKEN=//p' | head -1 || true)"
post_health() {
  [ -n "$APITOKEN" ] || return 0
  local status="$1" esc at producer core digest key body reconcile_body response http_status response_body attempt
  esc="$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  producer="hermes-pin-watch"
  core="$(printf '{"at":"%s","checks":[{"latencyMs":null,"message":"%s","service":"self-deploy","status":"%s","transitioned":false}],"producer":"%s"}' \
    "$at" "$esc" "$status" "$producer")"
  if command -v sha256sum >/dev/null 2>&1; then
    digest="$(printf '%s' "$core" | sha256sum | awk '{print $1}')"
  else
    digest="$(printf '%s' "$core" | shasum -a 256 | awk '{print $1}')"
  fi
  key="health.snapshot:${producer}:${at}"
  body="$(printf '{"at":"%s","checks":[{"service":"self-deploy","status":"%s","message":"%s","latencyMs":null,"transitioned":false}],"operationKey":"%s","producer":"%s","requestDigest":"%s"}' \
    "$at" "$status" "$esc" "$key" "$producer" "$digest")"
  reconcile_body="$(printf '{"operationId":"health.snapshot","operationKey":"%s","requestDigest":"%s"}' "$key" "$digest")"

  for attempt in 1 2; do
    http_status=""
    if http_status="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' \
      -H 'Content-Type: application/json' -H "Authorization: Bearer $APITOKEN" \
      -d "$body" "${WORKER_URL%/}/api/v1/admin/health" 2>/dev/null)"; then
      case "$http_status" in
        2??) return 0 ;;
        4??) log "record_health rejected the snapshot (best-effort, not replayed)"; return 0 ;;
      esac
    fi

    if ! response="$(curl -sS -m 10 -w $'\n%{http_code}' \
      -H 'Content-Type: application/json' -H "Authorization: Bearer $APITOKEN" \
      -d "$reconcile_body" "${WORKER_URL%/}/api/v1/admin/operation-receipts/resolve" 2>/dev/null)"; then
      log "record_health reconciliation unavailable; snapshot was not replayed"
      return 0
    fi
    http_status="${response##*$'\n'}"
    response_body="${response%$'\n'*}"
    case "$http_status" in
      2??) ;;
      *) log "record_health reconciliation unavailable; snapshot was not replayed"; return 0 ;;
    esac
    if printf '%s' "$response_body" | grep -Eq '"outcome"[[:space:]]*:[[:space:]]*"committed"'; then
      return 0
    fi
    if printf '%s' "$response_body" | grep -Eq '"outcome"[[:space:]]*:[[:space:]]*"safely-retryable"' && [ "$attempt" -lt 2 ]; then
      continue
    fi
    log "record_health reconciliation did not authorize replay"
    return 0
  done
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

# ── 2b. read the baked-content fingerprint (main HEAD) vs the running image's stamp ────────────
# The CLI pins do NOT move for a script-only change, so the fingerprint is what makes such a change
# reach the box. An empty HAVE_FP (an image built before this fingerprint existed) counts as drift.
# Resolve the watch set from the JUST-SYNCED Dockerfile first, so the set always matches the COPYs
# of the image this run would actually build.
resolve_baked_paths
WANT_FP="$(baked_fingerprint)"
HAVE_FP="$(docker exec "$CONTAINER" cat /opt/.hermes-baked-fp 2>/dev/null | tr -d '[:space:]' || true)"
log "baked-fp: have=${HAVE_FP:-<none>} want=$WANT_FP"

# The DENOMINATOR: this tick has now compared what the box runs against what main declares. Set
# here and nowhere earlier, so a run that died on a missing binary, an unreachable container, or
# an unparseable Dockerfile cannot report a look it never took.
CHECKED=1

if [ "$MODE" = "--if-stale" ] \
   && [ "$HAVE_FLUNCLE" = "$WANT_FLUNCLE" ] && [ "$HAVE_CLAUDE" = "$WANT_CLAUDE" ] \
   && [ -n "$HAVE_FP" ] && [ "$HAVE_FP" = "$WANT_FP" ]; then
  log "pins + baked content current — no-op"
  post_health ok "tools + scripts current"
  exit 0
fi
# The WORKLIST: drift is known and undeployed. It stays 1 until a swap actually lands, so an
# hourly run of failed builds reads as `produced == 0 AND queue_depth > 0` in the ledger.
DRIFT=1
log "pins or baked content drifted (or --force) — rebuilding"

# ── 3. capture the running container's runtime env (the secrets) into a tmpfs ──
# = the container's env MINUS the image's baked ENV (so we re-inject only the
# --env-file vars, never the image defaults). Lives only in tmpfs; rm on exit.
OLD_IMAGE="$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')"
ENVTMP="$(mktemp -p "${XDG_RUNTIME_DIR:-/dev/shm}" pinwatch-env.XXXXXX)"
chmod 600 "$ENVTMP"
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
# Read the live resource ceiling while the old container is still here — the swap below
# removes it, and the rollback path recreates from the same values.
preserve_live_ceiling

# ── 3b. PRE-BUILD prune — guarantee headroom BEFORE building the new image ─────
# The post-swap prune (step 7) only runs on a SUCCESSFUL rebuild, so it never helps
# the build currently in flight: a full rebuild has to write a SECOND large image
# (plus fresh layer cache) alongside the running one, and on a tight disk that peak
# is exactly what strands the next rebuild with "no space left on device" (seen
# 2026-07-09, mid base-bump, at 99%). So free space up front — drop every
# fluncle-hermes image EXCEPT the running one ($OLD_IMAGE, kept for rollback) and
# trim the build cache to a small working set. Doubly safe: the OLD container is
# still up on $OLD_IMAGE here, so docker refuses to remove it even if the grep
# missed, and every step is `|| true` so a prune hiccup never aborts the rebuild.
log "pre-build prune: freeing space (keeping $OLD_IMAGE for rollback)"
docker images "$IMAGE_REPO" --format '{{.Repository}}:{{.Tag}}' \
  | grep -vxF "$OLD_IMAGE" | xargs -r docker rmi >/dev/null 2>&1 || true
docker builder prune -f --keep-storage=3GB >/dev/null 2>&1 || true

# ── 3c. quiesce the box's sweep timers for the docker-heavy section ────────────
# Only reached when a rebuild WILL happen (the no-op --if-stale path exited above);
# --dry-run reaches here too (it builds + pre-smokes), so it quiesces as well. From
# here the docker daemon churns (build + throwaway pre-smoke runs + the swap), so
# stop the sweeps first and let the EXIT trap guarantee they come back.
quiesce_sweeps

# ── 4. build the new image ────────────────────────────────────────────────────
SHA="$(git -C "$REPO_DIR" rev-parse --short HEAD)"
NEW_IMAGE="$IMAGE_REPO:v$(date -u +%Y.%m.%d)-$SHA"
log "building $NEW_IMAGE (repo root build context, -f $DOCKERFILE)"
docker build --build-arg FLUNCLE_BAKED_FP="$WANT_FP" -f "$REPO_DIR/$DOCKERFILE" -t "$NEW_IMAGE" "$REPO_DIR" >&2 || { alert "🛠️ pin-watch: BUILD FAILED for $NEW_IMAGE — box untouched, staying on $OLD_IMAGE"; post_health degraded "a tool update failed to build; staying on the current tools"; die "build failed"; }

# ── 5. PRE-SMOKE the new image in throwaway containers (live box untouched) ────
presmoke_fail() { alert "🛠️ pin-watch: PRE-SMOKE FAILED ($1) for $NEW_IMAGE — box untouched, staying on $OLD_IMAGE"; post_health degraded "a tool update failed validation; box untouched on the current tools"; die "pre-smoke failed: $1"; }
verify_agent_role_boundary() {
  local response
  # This operator-tier rejection happens in auth middleware before the publish handler opens the
  # primary database. Requiring the exact `forbidden` code proves the captured token authenticated
  # as the agent role; an invalid token (`unauthorized`), a malformed response, or accidental
  # operator authority fails the image. No agent-allowed database read belongs in this control-plane
  # pre-smoke: a database outage must not suppress rebuild, verification, or swap.
  if response="$(docker run --rm "${CONTAINER_SECURITY_ARGS[@]}" --env-file "$ENVTMP" --entrypoint fluncle "$NEW_IMAGE" admin tracks publish 'https://open.spotify.com/track/0000000000000000pinwatch' --json 2>/dev/null)"; then
    presmoke_fail "publish-class command was NOT refused (role boundary regression)"
  fi
  printf '%s' "$response" | grep -Eq '"code"[[:space:]]*:[[:space:]]*"forbidden"' \
    || presmoke_fail "agent token did not receive the exact forbidden role-boundary response"
}
GOT_FLUNCLE="$(docker run --rm "${CONTAINER_SECURITY_ARGS[@]}" --entrypoint fluncle "$NEW_IMAGE" version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
[ "$GOT_FLUNCLE" = "$WANT_FLUNCLE" ] || presmoke_fail "fluncle version $GOT_FLUNCLE != $WANT_FLUNCLE"
GOT_CLAUDE="$(docker run --rm "${CONTAINER_SECURITY_ARGS[@]}" --entrypoint claude "$NEW_IMAGE" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
[ "$GOT_CLAUDE" = "$WANT_CLAUDE" ] || presmoke_fail "claude version $GOT_CLAUDE != $WANT_CLAUDE"
# gh (the nightly-audit agents' PR driver) must be present + runnable in the new image. It's a
# manual-watch pin (not auto-bumped), so this just guards that a rebuild never ships a broken gh.
docker run --rm "${CONTAINER_SECURITY_ARGS[@]}" --entrypoint gh "$NEW_IMAGE" --version >/dev/null 2>&1 || presmoke_fail "gh --version failed (audit PR driver missing)"
verify_agent_role_boundary
# Gateway startup without the live env or data mount: state lands on a scratch tmpfs and no
# platform token exists, so no Discord connection can open. No config is mounted on purpose —
# the s6 bootstrap SEEDS a default config into an empty HERMES_HOME (and Hermes rewrites its
# config in place at boot, so a read-only bind here would EROFS the seeding path). Readiness is
# asserted on observable state rather than a log string (the CLI's no-platform message is not
# emitted on the `gateway run` path): the pid file `start_gateway` writes into HERMES_HOME,
# plus the container still running after a settle. That proves image boot, the s6 bootstrap
# (UID remap, volume chown, config seeding), the privilege drop, gateway imports, and
# fresh-state writes under the production security flags.
GATEWAY_SMOKE_CONTAINER="pinwatch-gateway-smoke-$$"
docker run -d --name "$GATEWAY_SMOKE_CONTAINER" \
  "${CONTAINER_SECURITY_ARGS[@]}" \
  --tmpfs /opt/data:rw,noexec,nosuid,nodev,size=64m \
  "$NEW_IMAGE" gateway run --no-supervise >/dev/null 2>&1 || presmoke_fail "tokenless gateway container did not start"
gateway_smoke_ready=0
for _ in $(seq 1 60); do
  if docker exec "$GATEWAY_SMOKE_CONTAINER" test -s /opt/data/gateway.pid 2>/dev/null; then
    gateway_smoke_ready=1
    break
  fi
  [ "$(docker inspect "$GATEWAY_SMOKE_CONTAINER" --format '{{.State.Running}}' 2>/dev/null || true)" = "true" ] || break
  sleep 1
done
# Settle: a pid file alone could precede an early exit (e.g. the respawn-storm backoff path);
# the gateway must still be up a beat later, and the scratch home must be hermes-writable.
sleep 3
if [ "$gateway_smoke_ready" != "1" ] \
  || [ "$(docker inspect "$GATEWAY_SMOKE_CONTAINER" --format '{{.State.Running}}' 2>/dev/null || true)" != "true" ] \
  || ! docker exec -u hermes "$GATEWAY_SMOKE_CONTAINER" test -w /opt/data; then
  cleanup_gateway_smoke
  presmoke_fail "tokenless gateway did not reach a running, hermes-writable state"
fi
cleanup_gateway_smoke
# embed + cluster engines: prove the MuQ interpreter resolves + the whole stack imports, in a
# hard-capped throwaway container. NOT a full forward — the box has zero swap and the live
# container is up, so an uncapped MuQ load could OOM the live agent. This catches the actual
# failure mode (a dangling interpreter symlink / broken venv) cheaply (~2-3s, <1GB). The
# cluster engine's fits ride the SAME venv (sklearn + scipy, the third pip step), so the
# import guard extends to them — a rebuild that ships a broken cluster stack fails pre-smoke
# and rolls back. A hang (timeout) is treated as a pre-smoke failure so a wedged build can't swap.
# shellcheck disable=SC2016  # single-quoted on purpose: $(readlink)/import run in the CONTAINER's sh, not the host
timeout 120 docker run --rm "${CONTAINER_SECURITY_ARGS[@]}" --memory=3g --memory-swap=3g --entrypoint sh "$NEW_IMAGE" -c \
  'test -e "$(readlink -f /opt/muq-venv/bin/python)" && /opt/muq-venv/bin/python -c "import torch, muq, sklearn, scipy"' \
  >/dev/null 2>&1 || presmoke_fail "embed/cluster engine broken (interpreter/import)"
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
  #
  # The resource ceiling comes from the resolved globals, never a literal — this is the
  # ONE creation path, shared by the swap and the rollback, so both land the same box.
  docker run -d --name "$CONTAINER" --restart "${RESTART:-unless-stopped}" \
    "${CONTAINER_SECURITY_ARGS[@]}" \
    --cpus="$(from_nanocpus "$CEILING_NANOCPUS")" \
    --memory="${CEILING_MEMORY_BYTES}b" --memory-swap="${CEILING_MEMORY_BYTES}b" \
    --shm-size=1g \
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
  # The work this unit exists to do actually landed: the drift is gone and one deploy is produced.
  DEPLOYED=1
  DRIFT=0
  # Report only the pins that actually moved — an unchanged pin (claude-code X→X) is noise.
  CHANGES=""
  [ "$HAVE_FLUNCLE" != "$WANT_FLUNCLE" ] && CHANGES="fluncle $HAVE_FLUNCLE→$WANT_FLUNCLE"
  [ "$HAVE_CLAUDE" != "$WANT_CLAUDE" ] && CHANGES="${CHANGES:+$CHANGES, }claude-code $HAVE_CLAUDE→$WANT_CLAUDE"
  alert "🚀 pin-watch: rave-02 updated${CHANGES:+ — $CHANGES}."
  post_health ok "rebuilt to the latest tools"
  # prune old fluncle-hermes images, keep the most recent $KEEP_IMAGES (rollback depth)
  docker images "$IMAGE_REPO" --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' \
    | sort -rk2 | awk 'NR>'"$KEEP_IMAGES"' {print $1}' | xargs -r docker rmi >/dev/null 2>&1 || true
  # prune the BUILD CACHE too — the unbounded consumer the image prune above never touches.
  # A full rebuild (esp. a base-image bump, which busts the cache) writes ~15GB of layer
  # cache; left uncapped it silently fills the disk and strands the NEXT rebuild with
  # "no space left on device" (seen 2026-07-09: the box hit 99% mid-base-bump). Keep a small
  # working set so incremental rebuilds stay fast.
  docker builder prune -f --keep-storage=3GB >/dev/null 2>&1 || true
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
