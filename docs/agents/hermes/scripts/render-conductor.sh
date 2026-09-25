#!/usr/bin/env bash

set -uo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

BOAT_BIN="${BOAT_BIN:-${BOX_BIN:-/usr/local/bin/boat}}"
BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

boat_cli() { "$BOAT_BIN" --no-update "$@"; }

QUEUE_PARSER='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let body;try{body=JSON.parse(s)}catch{process.exit(2)}if(!body||typeof body!=="object"||Array.isArray(body)||body.ok!==true||!Array.isArray(body.tracks)||body.tracks.some(track=>!track||typeof track!=="object"||Array.isArray(track)||typeof track.logId!=="string"||track.logId.length===0))process.exit(2);for(const track of body.tracks)process.stdout.write(track.logId+"\n")})'

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

CONDUCTOR_ENV="${CONDUCTOR_ENV:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "$CONDUCTOR_ENV" ]; then
	set -a
	# shellcheck source=/dev/null
	. "$CONDUCTOR_ENV"
	set +a
fi

STATE_DIR="${STATE_DIR:-${HOME:-/opt/data/home}/.render-conductor}"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/state"
BOXID_FILE="$STATE_DIR/box-id"
STARTED_FILE="$STATE_DIR/started-at"
RENDER_LOGID_FILE="$STATE_DIR/render-logid"
FAILS_FILE="$STATE_DIR/fail-counts"
ORPHANS_FILE="$STATE_DIR/orphan-boxes"
PROBE_FAILS_FILE="$STATE_DIR/probe-failures"
LOCK_DIR="$STATE_DIR/lock.d"
LOG_FILE="$STATE_DIR/conductor.log"
[ -f "$FAILS_FILE" ] || : >"$FAILS_FILE"
[ -f "$ORPHANS_FILE" ] || : >"$ORPHANS_FILE"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROVISION="${PROVISION:-$SCRIPT_DIR/provision-rave-03.sh}"

START_INTERVAL="${START_INTERVAL:-3600}"
MAX_RENDER="${MAX_RENDER:-12600}"
MARKER_SKEW="${MARKER_SKEW:-300}"

POISON_THRESHOLD="${POISON_THRESHOLD:-3}"
POISON_TTL="${POISON_TTL:-21600}"

CONDEMN_TTL="${CONDEMN_TTL:-60}"
REAP_PER_TICK="${REAP_PER_TICK:-5}"
ORPHAN_ALERT_AFTER="${ORPHAN_ALERT_AFTER:-21600}"

LIVENESS_IDLE="${LIVENESS_IDLE:-600}"
PROBE_FAIL_LIMIT="${PROBE_FAIL_LIMIT:-3}"
API_URL="${FLUNCLE_API_URL:-https://www.fluncle.com}"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG_FILE" 2>/dev/null || true; }

RUN_CHECKED=0
RUN_PRODUCED=0
RUN_FAILED=0

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
emit() {
	printf '%s\n' "$*"
	printf '{"ok":true,"summary":"%s","checked":%s,"errors":0,"failed":%s,"produced":%s}\n' \
		"$(json_escape "$*")" "$RUN_CHECKED" "$RUN_FAILED" "$RUN_PRODUCED"
}

EMIT_REASON=""
emit_fail() {
	local reason=""
	[ -n "$EMIT_REASON" ] && reason="$(printf ',"reason":"%s"' "$(json_escape "$EMIT_REASON")")"
	printf '%s\n' "$*"
	printf '{"ok":false,"summary":"%s","checked":%s,"errors":1,"failed":%s,"produced":%s%s}\n' \
		"$(json_escape "$*")" "$RUN_CHECKED" "$RUN_FAILED" "$RUN_PRODUCED" "$reason"
}

emit_repair_pending() {
	printf '%s\n' "$*"
	printf '{"ok":true,"summary":"%s","checked":%s,"errors":0,"failed":%s,"gateState":"paused","partial":false,"produced":%s,"reason":"due_work_repair_pending","throttled":true}\n' \
		"$(json_escape "$*")" "$RUN_CHECKED" "$RUN_FAILED" "$RUN_PRODUCED"
}
now() { date +%s; }
read_or() { cat "$1" 2>/dev/null || printf '%s' "$2"; }

emit_render_cost() {
	local log_id="$1" occurred_at="$2" seconds="$3" id body http
	if [ -z "${FLUNCLE_API_TOKEN:-}" ] || [ -z "$log_id" ]; then
		log "cost: skipping render emit (no token or logId)"
		return 0
	fi
	case "$seconds" in '' | *[!0-9]*)
		log "cost: no numeric DURATION on the marker — skipping emit"
		return 0
		;;
	esac
	case "$occurred_at" in 20[0-9][0-9]-[0-1][0-9]-[0-3][0-9]T*) : ;; *)
		log "cost: marker had no ISO timestamp — skipping emit"
		return 0
		;;
	esac
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

discord_alert() {
	[ -n "${DISCORD_ALERT_WEBHOOK:-}" ] || return 0
	curl -sS -o /dev/null --max-time 10 -H 'Content-Type: application/json' \
		-d "$(printf '{"content":"%s"}' "$1")" \
		"$DISCORD_ALERT_WEBHOOK" 2>>"$LOG_FILE" || true
}

probe_box() {
	boat_cli ssh "$1" 'bash -s' 2>&1 <<'PROBE'
set -u
marker="$HOME/conductor-run.done"
if [ -f "$marker" ]; then
  printf 'MARKER-PRESENT %s\n' "$(tr -d '\r\n' <"$marker")"
else
  printf 'MARKER-ABSENT\n'
fi
printf 'CLAUDE-PROCS %s\n' "$(pgrep -c -f 'claude -p' 2>/dev/null || printf 0)"
printf 'LOG-MTIME %s\n' "$(stat -c %Y "$HOME/conductor-run.log" 2>/dev/null || printf 0)"
newest=0
for session in "$HOME"/.claude/projects/*/*.jsonl; do
  [ -f "$session" ] || continue
  seen="$(stat -c %Y "$session" 2>/dev/null || printf 0)"
  [ "$seen" -gt "$newest" ] && newest="$seen"
done
printf 'SESSION-MTIME %s\n' "$newest"
printf 'NOW %s\n' "$(date +%s)"
printf 'MEM-AVAILABLE-MB %s\n' "$(free -m 2>/dev/null | awk '/^Mem:/{print $7+0; found=1} END{if(!found)print 0}')"
ooms="$(dmesg 2>/dev/null | grep -ci 'out of memory' || printf '')"
printf 'OOM-KILLS %s\n' "${ooms:-unknown}"
PROBE
}

probe_field() { printf '%s\n' "$1" | awk -v key="$2" '$1==key{print $2; exit}'; }

numeric_or() { case "$1" in '' | *[!0-9]*) printf '%s' "$2" ;; *) printf '%s' "$1" ;; esac }

force_park() {
	local reason="$1" summary="$2" tail_out
	tail_out="$(boat_cli ssh "$boxid" 'tail -c 4000 ~/conductor-run.log' 2>&1 || printf '')"
	if [ -n "$tail_out" ]; then
		log "conductor-run.log tail from $boxid (last 4000 bytes):"
		printf '%s\n' "$tail_out" >>"$LOG_FILE"
	else
		log "no conductor-run.log tail available from $boxid"
	fi
	boat_cli stop "$boxid" >/dev/null 2>&1 || true
	printf 'idle' >"$STATE_FILE"
	bump_fail "$(read_or "$RENDER_LOGID_FILE" '')"
	log "force-parked box $boxid — $summary"
	discord_alert "render conductor: $summary ($API_URL/admin)"
	EMIT_REASON="$reason"
	emit_fail "render-conductor: $summary"
}

box_list_all() { boat_cli list --all --json 2>/dev/null; }

box_gone() {
	local id="$1" out
	[ -n "$id" ] || return 0
	out="$(box_list_all)" || return 1
	case "$out" in
	'') return 1 ;;
	*"\"id\":\"$id\""*) return 1 ;;
	*) return 0 ;;
	esac
}

box_present() {
	local id="$1" out
	[ -n "$id" ] || return 1
	out="$(box_list_all)" || return 1
	case "$out" in
	'') return 1 ;;
	*"\"id\":\"$id\""*) return 0 ;;
	*) return 1 ;;
	esac
}

mark_for_reclaim() {
	local id="$1"
	[ -n "$id" ] || return 1
	boat_cli stop "$id" >>"$LOG_FILE" 2>&1 || true
	boat_cli extend "$id" --ttl "$CONDEMN_TTL" >>"$LOG_FILE" 2>&1
}

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

	awk -F'\t' -v id="$id" '$1!=id' "$ORPHANS_FILE" >"$ORPHANS_FILE.tmp" 2>/dev/null
	mv "$ORPHANS_FILE.tmp" "$ORPHANS_FILE" 2>/dev/null || true
}

mark_orphan_alerted() {
	local id="$1"
	awk -F'\t' -v id="$id" 'BEGIN{OFS="\t"} $1==id{$3=1} {print}' "$ORPHANS_FILE" >"$ORPHANS_FILE.tmp" 2>/dev/null
	mv "$ORPHANS_FILE.tmp" "$ORPHANS_FILE" 2>/dev/null || true
}

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

is_poisoned() {
	awk -F'\t' -v id="$1" -v thr="$POISON_THRESHOLD" -v ttl="$POISON_TTL" -v now="$(now)" '
    $1==id && ($2+0)>=thr && (now-($3+0))<ttl { hit=1 } END { exit hit?0:1 }' "$FAILS_FILE" 2>/dev/null
}

bump_fail() {
	local id="$1" prev next
	[ -n "$id" ] || return 0
	RUN_FAILED=$((RUN_FAILED + 1))
	prev="$(awk -F'\t' -v id="$id" '$1==id{print $2+0; f=1} END{if(!f)print 0}' "$FAILS_FILE" 2>/dev/null || printf 0)"
	next=$((prev + 1))
	{
		awk -F'\t' -v id="$id" '$1!=id' "$FAILS_FILE" 2>/dev/null
		printf '%s\t%s\t%s\n' "$id" "$next" "$(now)"
	} \
		>"$FAILS_FILE.tmp" && mv "$FAILS_FILE.tmp" "$FAILS_FILE"
	log "render fail #$next for $id"
	if [ "$next" -eq "$POISON_THRESHOLD" ]; then
		log "POISON: $id failed $next consecutive renders — skipping it for ${POISON_TTL}s"
		emit "render-conductor: POISON-SKIP $id after $next failed renders"
		discord_alert "render conductor: POISON-SKIP $id after $next failed renders — needs a look ($API_URL/admin)"
	fi
}

clear_fail() {
	local id="$1"
	[ -n "$id" ] || return 0
	awk -F'\t' -v id="$id" '$1!=id' "$FAILS_FILE" 2>/dev/null >"$FAILS_FILE.tmp" && mv "$FAILS_FILE.tmp" "$FAILS_FILE"
}

render_produced_video() {
	local id="$1" out
	[ -n "$id" ] || return 0
	out="$("$FLUNCLE_BIN" admin tracks get "$id" --json 2>/dev/null || printf '')"
	[ -n "$out" ] || return 0
	printf '%s' "$out" | "$BUN_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=JSON.parse(s).track||{};process.exit(t.videoUrl?0:1)}catch(e){process.exit(0)}})'
}

RESTORING_CODE_RE='(box|boat|sandbox)_restoring'
BOAT_READY_TIMEOUT="${BOAT_READY_TIMEOUT:-${BOX_READY_TIMEOUT:-75}}"
BOAT_READY_INTERVAL="${BOAT_READY_INTERVAL:-${BOX_READY_INTERVAL:-5}}"
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

RESUME_TIMEOUT="${RESUME_TIMEOUT:-90}"

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

freshen_checkout() {
	local out rc=0
	out="$(
		boat_cli ssh "$1" 'bash -s' 2>&1 <<'FRESH'
set -u
cd "$HOME/fluncle" || { echo "[freshen] no ~/fluncle — needs reprovision"; exit 42; }

# THE CHECKOUT AND ITS DEPENDENCIES MOVE TOGETHER, and this runs on EVERY wake — a tree that
# is already at `main` can still be missing modules, which is the same hole. Advancing the
# checkout without installing leaves the workspace short of whatever the new head added, the
# render's first build step dies on a missing module, and the agent — the only thing awake —
# improvises a full-workspace install BESIDE its own session on a small box, which is how a
# render's process group gets OOM-killed with no marker and no trace. So the conductor
# installs here, at wake, while nothing else heavy is running and before `claude -p` starts.
# Bounded, and it ASSERTS: the deps-ok / deps-failed marker is what the caller reads, because
# `boat ssh` flattens the remote exit code. The agent NEVER installs (render-detached.sh
# refuses to launch into an incomplete workspace instead).
# A killed install (OOM, timeout) leaves EMPTY package directories behind, and the next
# `bun install --frozen-lockfile` trusts a directory that exists as a package that is installed,
# exits 0 and steps over the hole. So a directory is never proof: the check demands the package
# manifest, the install prunes every empty package directory first so bun re-links them, and
# `deps-ok` is asserted on the tree AFTER the install, never on bun's exit code alone.
empty_packages() {
  [ -d node_modules ] || return 0
  find node_modules -mindepth 1 -maxdepth 1 -type d -empty ! -name '.*' 2>/dev/null
  find node_modules -mindepth 2 -maxdepth 2 -type d -empty -path 'node_modules/@*/*' 2>/dev/null
}
# THE TOOLCHAIN MOVES WITH THE CHECKOUT TOO. The lockfile format follows the bun release the
# repo pins (`packageManager` in package.json); a box whose bun predates it fails every frozen
# install with "Unknown lockfile version" no matter how complete the tree is. So the wake step
# holds the box's bun at that pin before it installs — the PINNED release, never `bun upgrade`
# (which tracks latest and puts the toolchain on a moving target).
# The installer is `bash -s`, which reads its SCRIPT from stdin: that stdin is the curl pipe and
# must never be redirected to /dev/null, or bash reads nothing, exits, and curl reports a write
# failure with an empty log.
bun_pin() { sed -n 's/.*"packageManager": *"bun@\([0-9][0-9.]*\)".*/\1/p' package.json | head -1; }
bun_stale() { local want; want="$(bun_pin)"; [ -n "$want" ] && [ "$want" != "$(bun --version 2>/dev/null)" ]; }
sync_bun() {
  bun_stale || return 0
  local want have
  want="$(bun_pin)"; have="$(bun --version 2>/dev/null || echo none)"
  if curl -fsSL https://bun.sh/install | BUN_INSTALL="$HOME/.bun" bash -s "bun-v$want" >"$HOME/.freshen-bun.log" 2>&1 \
    && [ -x "$HOME/.bun/bin/bun" ] && install -m 0755 "$HOME/.bun/bin/bun" /usr/local/bin/bun; then
    echo "[freshen] bun $have -> $(bun --version)"
    return 0
  fi
  echo "[freshen] deps-failed"
  echo "bun toolchain: the repo pins $want, the box has $have, and the pinned install failed"
  tail -c 600 "$HOME/.freshen-bun.log" 2>/dev/null
  return 1
}
# The killed install's other residue: HOLLOW entries in bun's global cache (a package
# directory with no manifest, its extraction never finished). bun links every later install
# from that cache, so a hollow entry becomes an empty package directory in node_modules on
# every run until the entry itself is gone. Purge them beside the empty directories.
hollow_cache_entries() {
  local cache="$HOME/.bun/install/cache"
  [ -d "$cache" ] || return 0
  find "$cache" -mindepth 1 -maxdepth 1 -type d ! -name '.*' ! -name '@*' ! -exec test -e '{}/package.json' ';' -print 2>/dev/null
  find "$cache" -mindepth 2 -maxdepth 2 -type d -path "$cache/@*/*" ! -exec test -e '{}/package.json' ';' -print 2>/dev/null
}
install_deps() {
  sync_bun || return 1
  local hollow; hollow="$(hollow_cache_entries | wc -l | tr -d ' ')"
  [ "$hollow" = "0" ] || { echo "[freshen] purging $hollow hollow bun cache entries"; hollow_cache_entries | xargs -r rm -rf; }
  # Two passes: pruning a scope's last package leaves the scope directory itself empty.
  empty_packages | xargs -r rmdir 2>/dev/null
  empty_packages | xargs -r rmdir 2>/dev/null
  if timeout 900 bun install --frozen-lockfile </dev/null >"$HOME/.freshen-install.log" 2>&1 && ! deps_incomplete; then
    echo "[freshen] deps-ok"
    return 0
  fi
  echo "[freshen] deps-failed"
  tail -c 1000 "$HOME/.freshen-install.log" 2>/dev/null
  deps_incomplete && echo "the tree is still incomplete after the install: $(empty_packages | head -5 | tr '\n' ' ')"
  return 1
}
# `browserslist` is a transitive dependency of the render's webpack bundling step, so its
# missing manifest is the cheapest honest proof that the workspace tree is incomplete; an empty
# package directory anywhere is the other face of the same hole.
deps_incomplete() {
  bun_stale && return 0
  [ -f node_modules/browserslist/package.json ] || return 0
  [ -n "$(empty_packages | head -1)" ] && return 0
  return 1
}

git fetch --depth 1 origin main -q 2>/dev/null || { echo "[freshen] fetch failed — keep current"; exit 0; }
have="$(git rev-parse HEAD 2>/dev/null)"; want="$(git rev-parse FETCH_HEAD 2>/dev/null)"
if [ -z "$want" ] || [ "$have" = "$want" ]; then
  echo "[freshen] current at ${have:0:7}"
  deps_incomplete && { install_deps || exit 0; }
  exit 0
fi
before_skill="$(git rev-parse HEAD:packages/skills/fluncle-video 2>/dev/null)"
git reset --hard FETCH_HEAD -q || { echo "[freshen] reset failed — keep current"; exit 0; }
if git diff --name-only "$have" HEAD -- bun.lock package.json '*/package.json' 2>/dev/null | grep -q . || deps_incomplete; then
  install_deps || exit 0
fi
[ "$(git rev-parse HEAD:packages/skills/fluncle-video 2>/dev/null)" != "$before_skill" ] \
  && npx -y skills add ./packages/skills/fluncle-video -y -a claude-code </dev/null >/dev/null 2>&1
echo "[freshen] updated ${have:0:7} -> $(git rev-parse --short HEAD)"
FRESH
	)" || rc=$?
	printf '%s\n' "$out" >>"$LOG_FILE"

	if printf '%s' "$out" | grep -q 'needs reprovision'; then
		return 2
	fi
	if printf '%s' "$out" | grep -q '\[freshen\] deps-failed'; then
		return 3
	fi
	[ "$rc" = "0" ] || log "freshen: ssh rc=$rc — rendering on the existing checkout"
	return 0
}

LOCK_STALE_SECONDS=1560
if [ -d "$LOCK_DIR" ]; then
	lock_mtime="$(stat -c %Y "$LOCK_DIR" 2>/dev/null || stat -f %m "$LOCK_DIR" 2>/dev/null || printf '0')"
	if [ "$(($(now) - lock_mtime))" -gt "$LOCK_STALE_SECONDS" ]; then
		rmdir "$LOCK_DIR" 2>/dev/null || true
	fi
fi
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
	emit "render-conductor: a tick is already running — skip"
	exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

BOAT_API_KEY="${BOAT_API_KEY:-${BOX_API_KEY:-}}"
if [ -z "$BOAT_API_KEY" ]; then
	log "BOAT_API_KEY missing (place it in $CONDUCTOR_ENV; BOX_API_KEY is still accepted)"
	emit_fail "render-conductor: no BOAT_API_KEY — cannot reach the render box"
	exit 1
fi

BOAT_CFG_DIR="${XDG_CONFIG_HOME:-${HOME:-/opt/data/home}/.config}/ascii/boat"
if [ ! -f "$BOAT_CFG_DIR/config.json" ]; then
	mkdir -p "$BOAT_CFG_DIR"
	printf '{"api_url":"https://ascii.dev","channel":"prod"}\n' >"$BOAT_CFG_DIR/config.json"
fi

if ! printf '%s' "$BOAT_API_KEY" | boat_cli login --key-stdin --json >>"$LOG_FILE" 2>&1; then
	log "boat login failed (see output above)"
	emit_fail "render-conductor: boat.dev auth failed"
	exit 1
fi

if [ "$PREFLIGHT" = "1" ]; then
	pf_state="$(read_or "$STATE_FILE" idle)"
	pf_boxid="$(read_or "$BOXID_FILE" '')"
	printf 'render-conductor preflight\n'
	printf '  cli:         %s\n' "$("$BOAT_BIN" --no-update --version 2>&1 | tr -d '\r\n')"
	printf '  config:      %s/config.json\n' "$BOAT_CFG_DIR"
	printf '  auth:        login accepted\n'
	printf '  state:       %s\n' "$pf_state"
	printf '  recorded id: %s\n' "${pf_boxid:-<none>}"

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

reap_orphans

state="$(read_or "$STATE_FILE" idle)"
boxid="$(read_or "$BOXID_FILE" '')"

if [ "$state" = "rendering" ]; then
	RUN_CHECKED=$((RUN_CHECKED + 1))
	if [ -z "$boxid" ]; then
		printf 'idle' >"$STATE_FILE"
		RUN_FAILED=$((RUN_FAILED + 1))
		emit "render-conductor: rendering state with no box id — reset to idle"
		exit 0
	fi

	probe_out="$(probe_box "$boxid")"
	printf '%s\n' "$probe_out" >>"$LOG_FILE"
	probe_fails="$(numeric_or "$(read_or "$PROBE_FAILS_FILE" 0)" 0)"
	case "$probe_out" in
	*MARKER-PRESENT*) marker_word=present ;;
	*MARKER-ABSENT*) marker_word=absent ;;
	*) marker_word='' ;;
	esac
	if [ -z "$marker_word" ]; then
		probe_fails=$((probe_fails + 1))
		printf '%s' "$probe_fails" >"$PROBE_FAILS_FILE"
		log "done-marker probe on $boxid answered neither MARKER-PRESENT nor MARKER-ABSENT — transport failure #$probe_fails"
		if [ "$probe_fails" -ge "$PROBE_FAIL_LIMIT" ]; then
			: >"$PROBE_FAILS_FILE"
			force_park render_box_wedged \
				"render box $boxid did not answer the done-marker probe $probe_fails ticks running — wedged, force-parked"
			exit 1
		fi
		EMIT_REASON=render_probe_transport
		emit_fail "render-conductor: done-marker probe failed on $boxid (transport failure $probe_fails of $PROBE_FAIL_LIMIT) — holding"
		exit 1
	fi
	: >"$PROBE_FAILS_FILE"
	log "done-marker probe on $boxid: MARKER-$(printf '%s' "$marker_word" | tr '[:lower:]' '[:upper:]')"

	marker_fresh=0
	result='?'
	if [ "$marker_word" = present ]; then
		result="$(printf '%s\n' "$probe_out" | sed -n 's/^MARKER-PRESENT //p' | head -n 1)"
		[ -n "$result" ] || result='?'
		marker_iso="${result#*@ }"
		marker_iso="${marker_iso%% *}"
		marker_epoch="$(date -u -d "$marker_iso" +%s 2>/dev/null || printf 0)"
		started="$(read_or "$STARTED_FILE" 0)"
		case "$marker_epoch$started" in
		*[!0-9]*) : ;;
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

		render_iso="${result#*@ }"
		render_iso="${render_iso%% *}"
		emit_render_cost "$(read_or "$RENDER_LOGID_FILE" '')" "$render_iso" "${result##*DURATION=}"

		rendered_logid="$(read_or "$RENDER_LOGID_FILE" '')"
		render_exit="${result#EXIT=}"
		render_exit="${render_exit%% *}"
		case "$render_exit" in
		0)
			if render_produced_video "$rendered_logid"; then
				clear_fail "$rendered_logid"
				RUN_PRODUCED=$((RUN_PRODUCED + 1))
			else
				log "render EXIT=0 but $rendered_logid still has no video — false success, counting as a failure"
				bump_fail "$rendered_logid"

				stall_count="$(awk -F'\t' -v id="$rendered_logid" '$1==id{print $2+0}' "$FAILS_FILE" 2>/dev/null || printf 0)"
				if [ "${stall_count:-0}" -eq $((POISON_THRESHOLD - 1)) ]; then
					discord_alert "render conductor: STALL WARNING — $rendered_logid exited clean ${stall_count}x with no video landing; one more poisons it ($API_URL/admin)"
				fi
			fi
			;;

		'' | *[!0-9]*)
			RUN_FAILED=$((RUN_FAILED + 1))
			log "render marker carries a named launcher fault ($result) — the box refused to render"
			discord_alert "render conductor: the render launcher refused on $boxid ($result) — nothing rendered ($API_URL/admin)"
			;;
		*) bump_fail "$rendered_logid" ;;
		esac
		# Chain: fall out of the rendering block to the idle pick in THIS tick — a
		# finished render must not cost a dead hour. The hourly START gate below
		# still holds (the last start is over an hour old once a render finishes).
	else

		started="$(read_or "$STARTED_FILE" 0)"
		claude_procs="$(numeric_or "$(probe_field "$probe_out" CLAUDE-PROCS)" '')"
		box_now="$(numeric_or "$(probe_field "$probe_out" NOW)" "$(now)")"
		log_mtime="$(numeric_or "$(probe_field "$probe_out" LOG-MTIME)" 0)"
		session_mtime="$(numeric_or "$(probe_field "$probe_out" SESSION-MTIME)" 0)"
		mem_available="$(probe_field "$probe_out" MEM-AVAILABLE-MB)"
		oom_kills="$(probe_field "$probe_out" OOM-KILLS)"
		newest="$log_mtime"
		[ "$session_mtime" -gt "$newest" ] && newest="$session_mtime"

		[ "$newest" -gt 0 ] || newest="$(numeric_or "$started" "$box_now")"
		idle_for=$((box_now - newest))
		[ "$idle_for" -ge 0 ] || idle_for=0
		log "liveness on $boxid: claude=${claude_procs:-unknown} idle=${idle_for}s mem_available=${mem_available:-unknown}MB oom_kills=${oom_kills:-unknown}"

		if [ "$claude_procs" = "0" ] && [ "$idle_for" -gt "$LIVENESS_IDLE" ]; then
			force_park render_died \
				"the render of $(read_or "$RENDER_LOGID_FILE" '?') on $boxid is DEAD — no done-marker, no claude process, nothing written for ${idle_for}s (${mem_available:-unknown}MB available, oom kills: ${oom_kills:-unknown})"
			exit 1
		fi

		if [ "$(($(now) - started))" -gt "$MAX_RENDER" ]; then
			force_park render_stuck \
				"the render of $(read_or "$RENDER_LOGID_FILE" '?') on $boxid ran past ${MAX_RENDER}s — force-parked"
			exit 1
		fi
		emit "render-conductor: render in flight on $boxid — single-flight hold"
		exit 0
	fi
fi

started="$(read_or "$STARTED_FILE" 0)"
if [ "$(($(now) - started))" -lt "$START_INTERVAL" ]; then
	emit "render-conductor: within the hourly start window — idle"
	exit 0
fi

if [ -z "${FLUNCLE_API_TOKEN:-}" ]; then
	log "FLUNCLE_API_TOKEN missing from the cron env"
	emit_fail "render-conductor: no agent token"
	exit 1
fi

queue_json="$("$FLUNCLE_BIN" admin tracks queue --limit 25 --json 2>>"$LOG_FILE")"
queue_read_rc=$?
if [ "$queue_read_rc" -ne 0 ]; then

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
head=""
skipped=0
while IFS= read -r lid; do
	[ -n "$lid" ] || continue
	RUN_CHECKED=$((RUN_CHECKED + 1))
	if is_poisoned "$lid"; then
		skipped=$((skipped + 1))
		continue
	fi
	head="$lid"
	break
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

	await_box_ready "$boxid" || log "no ready signal from $boxid — proceeding; the trigger check decides"

	freshen_rc=0
	freshen_checkout "$boxid" || freshen_rc=$?

	if [ "$freshen_rc" = "3" ]; then
		boat_cli stop "$boxid" >/dev/null 2>&1 || true
		RUN_FAILED=$((RUN_FAILED + 1))
		log "dependency install failed on $boxid — parked without rendering; the workspace is incomplete"
		discord_alert "render conductor: the dependency install failed on render box $boxid — nothing rendered this window, and the box is parked until it installs ($API_URL/admin)"
		EMIT_REASON=render_deps_install_failed
		emit_fail "render-conductor: dependency install failed on $boxid — box parked, nothing rendered"
		exit 1
	fi
	if [ "$freshen_rc" != "0" ]; then
		log "resumed box $boxid lost its ~/fluncle checkout — stopping it + reprovisioning"
		boat_cli stop "$boxid" >/dev/null 2>&1 || true
		boxid=""
	elif boat_cli scp "$FLUNCLE_BIN" "$boxid:~/.local/lib/fluncle.mjs" >>"$LOG_FILE" 2>&1; then
		log "box CLI refreshed from the conductor's bundled fluncle"
	else
		log "box CLI refresh failed — rendering with the existing CLI"
	fi

	if [ -n "$boxid" ]; then
		if boat_cli scp "$SCRIPT_DIR/render-detached.sh" "$boxid:~/render-detached.sh" >>"$LOG_FILE" 2>&1; then
			boat_cli ssh "$boxid" 'chmod +x ~/render-detached.sh' >/dev/null 2>&1 || true
			log "render-detached.sh refreshed from the conductor's bundled copy"
		else
			log "render-detached.sh refresh failed — rendering with the box's existing copy"
		fi
	fi
else

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

umask 077
creds="$(mktemp)"
{
	printf 'export CLAUDE_CODE_OAUTH_TOKEN=%s\n' "${CLAUDE_CODE_OAUTH_TOKEN:-}"
	printf 'export FLUNCLE_API_TOKEN=%s\n' "$FLUNCLE_API_TOKEN"
	printf 'export FLUNCLE_API_URL=%s\n' "$API_URL"
	printf 'export FLUNCLE_GL=swangle\n'

	printf 'export FLUNCLE_RENDER_LOG_ID=%s\n' "$head"

	printf 'export GEMINI_API_KEY=%s\n' "${GEMINI_API_KEY:-}"
	printf 'export RENDER_CLAUDE_EFFORT=%s\n' "${RENDER_CLAUDE_EFFORT:-high}"
} >"$creds"

axes="$("$FLUNCLE_BIN" admin tracks vehicles --json 2>>"$LOG_FILE" | "$BUN_BIN" "$SCRIPT_DIR/assign-video-axes.ts" 2>>"$LOG_FILE" || printf '')"
if [ -n "$axes" ]; then
	printf '%s\n' "$axes" >>"$creds"
	log "assigned video axes: $(printf '%s' "$axes" | tr '\n' ' ')"
else
	log "video-axis assigner produced no assignment — render falls back to free choice"
fi

boat_cli scp "$creds" "$boxid:/dev/shm/fluncle.env" >/dev/null 2>&1
rm -f "$creds"

trigger_out="$(boat_cli ssh "$boxid" 'bash ~/render-detached.sh' 2>&1)"
printf '%s\n' "$trigger_out" >>"$LOG_FILE"

if printf '%s' "$trigger_out" | grep -q 'render-detached: refused'; then
	refusal="$(printf '%s\n' "$trigger_out" | sed -n 's/.*render-detached: refused //p' | head -n 1)"
	boat_cli stop "$boxid" >/dev/null 2>&1 || true
	printf 'idle' >"$STATE_FILE"
	RUN_FAILED=$((RUN_FAILED + 1))
	log "render launcher refused to start on $boxid: ${refusal:-unstated}"
	discord_alert "render conductor: the render launcher refused to start on $boxid (${refusal:-unstated}) — nothing rendered this window ($API_URL/admin)"
	EMIT_REASON=render_launch_refused
	emit_fail "render-conductor: render launcher refused on $boxid (${refusal:-unstated}) — box parked, staying idle"
	exit 1
fi
if ! printf '%s' "$trigger_out" | grep -q 'render-detached: launched'; then
	log "render trigger did not launch on $boxid (wedged box) — deleting it + staying idle to reprovision"
	RUN_FAILED=$((RUN_FAILED + 1))
	emit_fail "render-conductor: render trigger failed on $boxid — box condemned, reprovision next tick"

	condemn_box "$boxid" || true
	: >"$BOXID_FILE"
	printf 'idle' >"$STATE_FILE"
	exit 1
fi
printf 'rendering' >"$STATE_FILE"
now >"$STARTED_FILE"
: >"$PROBE_FAILS_FILE"
printf '%s' "$head" >"$RENDER_LOGID_FILE"
log "started detached render of $head on box $boxid"
RUN_PRODUCED=$((RUN_PRODUCED + 1))
emit "render-conductor: started render of $head on $boxid"
exit 0
