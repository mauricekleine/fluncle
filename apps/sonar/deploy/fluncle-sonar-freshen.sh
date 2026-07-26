#!/usr/bin/env bash
# fluncle-sonar-freshen — the rave-01 box's self-deploy for the sonar vector engine.
#
# Watches the rolling `sonar-latest` GitHub Release (published by
# .github/workflows/sonar-release.yml on every merge to main that touches
# apps/sonar/**), and when it carries a commit the box has not deployed yet:
# downloads the static musl binary, VERIFIES its checksum, pre-smokes it in
# ISOLATION on a throwaway loopback port BEFORE the live one is touched, swaps it
# into the `sonar` systemd service, restarts, post-smokes, and auto-rolls-back to
# the prior binary on any failure. The box is never left broken.
#
# This is the sibling of apps/ssh/deploy/fluncle-ssh-freshen.sh (the public SSH
# terminal's self-deploy on the same box) and of docs/agents/hermes/pin-watch (the
# rave-02 Hermes self-deploy). It closes the gap where a merge to main did NOT
# reach the live sonar service until an operator cross-built on a Mac and scp'd it
# up by hand.
#
# THE ONE DELIBERATE DIVERGENCE FROM THE SSH SIBLING: sonar does NOT build on the
# box. The ssh freshen argues for an on-box `go build` because the Go toolchain is
# small and a build is ~10s; neither holds for Rust. A `cargo build --release` of
# sonar is ~7-14 min on this box's two shared vCPUs and needs a ~1.5GB toolchain on
# the deliberately-minimal public edge — which is simultaneously serving the SSH
# terminal, DNS, and sonar itself. So CI builds the artifact and the box only
# downloads + verifies + swaps. See apps/sonar/deploy/README.md for the full
# reasoning and the trust boundary that replaces "we built it ourselves".
#
# CREDENTIAL-FREE BY DESIGN: the repo is public, so the release assets are fetched
# by plain unauthenticated curl — no GitHub token on the box. The swap only
# REPLACES THE BINARY at /opt/sonar/sonar and restarts the service; the systemd
# unit and /etc/sonar.env (the service contract the operator established) are left
# untouched, so it reuses the env already on the box and reads nothing from `op`.
# The optional Discord-alert + /status-post inputs come from an operator-placed
# EnvironmentFile kept OUT of the repo; unset any of them and that best-effort
# visibility is simply skipped.
#
# Run by fluncle-sonar-freshen.timer (default: --if-changed, a no-op when current).
# Run once by hand with --force to clear accumulated debt and validate the recipe;
# run with --dry-run to download + verify + pre-smoke and STOP (the live service is
# never touched).
#
# Doctrine: apps/sonar/deploy/README.md.
set -euo pipefail

# ── config (overridable via the env) ──────────────────────────────────────────
# The rolling pre-release the CI workflow publishes. Public repo ⇒ the download
# host needs no credential; `.../releases/download/<tag>/<asset>` is a plain GET.
RELEASE_REPO="${SONARFRESHEN_RELEASE_REPO:-mauricekleine/fluncle}"
RELEASE_TAG="${SONARFRESHEN_RELEASE_TAG:-sonar-latest}"
ASSET_BASE="${SONARFRESHEN_ASSET_BASE:-https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}}"

STATE_DIR="${SONARFRESHEN_STATE_DIR:-/opt/sonar-freshen}"
SHA_FILE="${SONARFRESHEN_SHA_FILE:-$STATE_DIR/deployed-sha}"
LOCK="${SONARFRESHEN_LOCK:-/run/lock/fluncle-sonar-freshen.lock}"

# The live service contract (must match apps/sonar/deploy/sonar.service).
SERVICE="${SONARFRESHEN_SERVICE:-sonar}"
APP_DIR="${SONARFRESHEN_APP_DIR:-/opt/sonar}"
APP_BIN="${SONARFRESHEN_APP_BIN:-$APP_DIR/sonar}"
PREV_BIN="$APP_BIN.prev"
SERVICE_ENV="${SONARFRESHEN_SERVICE_ENV:-/etc/sonar.env}"

# How long to wait for an index load. sonar reads the WHOLE embedding corpus out of
# Turso and builds both in-memory indexes before it serves /health — ~30s at today's
# corpus and it grows with the archive, so this is deliberately generous. Applied to
# both the isolated pre-smoke and the post-swap wait.
BOOT_TIMEOUT_SECS="${SONARFRESHEN_BOOT_TIMEOUT_SECS:-180}"

# Optional alert/status inputs (operator EnvironmentFile; all best-effort, all optional).
WORKER_URL="${SONARFRESHEN_WORKER_URL:-https://www.fluncle.com}"

MODE="--if-changed"
case "${1:-}" in
  --force) MODE="--force" ;;     # redeploy regardless of the recorded SHA (the operator pilot)
  --dry-run) MODE="--dry-run" ;; # download + verify + pre-smoke, then STOP (never swap)
esac

log() { printf '[sonar-freshen] %s\n' "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

# ── single-flight ─────────────────────────────────────────────────────────────
exec 9>"$LOCK"
flock -n 9 || { log "another run holds the lock; exiting"; exit 0; }

command -v curl >/dev/null || die "curl not found"

# ── Discord alert (best-effort; webhook from the operator EnvironmentFile). Never throws. ──
alert() {
  [ -n "${DISCORD_ALERT_WEBHOOK:-}" ] || return 0
  curl -fsS -m 10 -H 'Content-Type: application/json' \
    -d "$(printf '{"content":%s}' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')")" \
    "${DISCORD_ALERT_WEBHOOK}" >/dev/null 2>&1 || true
}

# Self-deploy health → the public /status board (the `self-deploy-sonar` row, beside
# `self-deploy-ssh` on the same box). Best-effort, never throws; the message is
# public-safe and deliberately vague (no host, no raw error). status ∈ ok|degraded|down.
# Needs the agent token + worker URL from the operator EnvironmentFile; unset → skipped.
post_health() {
  [ -n "${FLUNCLE_API_TOKEN:-}" ] || return 0
  local status="$1" esc
  esc="$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  curl -fsS -m 10 \
    -H 'Content-Type: application/json' -H "Authorization: Bearer ${FLUNCLE_API_TOKEN}" \
    -d "$(printf '{"at":"%s","checks":[{"service":"self-deploy-sonar","status":"%s","message":"%s","latencyMs":null,"transitioned":false}]}' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$status" "$esc")" \
    "${WORKER_URL%/}/api/v1/admin/health" >/dev/null 2>&1 || true
}

# Read one KEY=value out of the live service's EnvironmentFile WITHOUT sourcing it
# (never executes the file — it is systemd's format, not shell). Strips one layer of
# surrounding quotes. Values here are secrets: they are passed straight into the
# pre-smoke's environment and NEVER logged.
env_value() {
  [ -r "$SERVICE_ENV" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$SERVICE_ENV" 2>/dev/null | tail -1 \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# ── 1. what does the rolling release say was built? ───────────────────────────
# `sonar.commit` is the full commit SHA the published binary was built from — the
# artifact's identity, and the only thing that decides whether there is work to do.
# A missing/unreachable release is a NORMAL state (CI has not published yet, or
# GitHub is having a moment): log it, mark degraded, and leave the box alone.
mkdir -p "$STATE_DIR"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sonar-freshen.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

if ! curl -fsSL --retry 3 --retry-delay 2 -m 60 -o "$WORK_DIR/sonar.commit" "$ASSET_BASE/sonar.commit"; then
  log "could not fetch $ASSET_BASE/sonar.commit — leaving the live service alone"
  post_health degraded "the sonar release feed is unreachable; the live engine is untouched"
  exit 0
fi

NEW_SHA="$(tr -d '[:space:]' <"$WORK_DIR/sonar.commit")"
# Guard against an HTML error page or a truncated asset masquerading as a SHA.
if ! printf '%s' "$NEW_SHA" | grep -Eq '^[0-9a-f]{40}$'; then
  log "the published sonar.commit is not a commit SHA — refusing to act on it"
  post_health degraded "the sonar release feed looks malformed; the live engine is untouched"
  exit 0
fi

OLD_SHA="$(cat "$SHA_FILE" 2>/dev/null || true)"

# ── 2. decide whether to deploy ───────────────────────────────────────────────
# Deploy when: --force; OR there is no recorded baseline (first run); OR the published
# artifact was built from a different commit than the one on the box. A merge that
# changed no sonar source publishes nothing, so this is a cheap no-op most ticks.
# --dry-run deliberately skips the already-current short-circuit: it never touches the
# live service, so "preview the current release" should stay useful on a current box.
if [ "$MODE" = "--force" ]; then
  reason="forced"
elif [ "$MODE" = "--dry-run" ]; then
  reason="dry run"
elif [ -z "$OLD_SHA" ]; then
  reason="no baseline (first run)"
elif [ "$OLD_SHA" = "$NEW_SHA" ]; then
  log "${OLD_SHA:0:12} -> ${NEW_SHA:0:12} | already current — no-op"
  post_health ok "sonar current"
  exit 0
else
  reason="a newer sonar build is published"
fi
log "${OLD_SHA:-<none>} -> $NEW_SHA | $reason"

# ── 3. download + VERIFY (the trust boundary) ─────────────────────────────────
# The box did not build this binary, so the checksum IS the trust boundary that
# replaces "we compiled it ourselves". A mismatch means the artifact is corrupt or
# tampered with: fail LOUDLY and never, under any mode, put it near the live service.
download_fail() {
  alert "🛰️ sonar-freshen: DOWNLOAD/VERIFY FAILED ($1) for ${NEW_SHA:0:12} on rave-01 — box untouched, staying on the current sonar binary"
  post_health degraded "a sonar update failed download or checksum verification; the live engine is untouched"
  die "download/verify failed: $1"
}

NEW_BIN="$WORK_DIR/sonar"
curl -fsSL --retry 3 --retry-delay 2 -m 600 -o "$NEW_BIN" "$ASSET_BASE/sonar" \
  || download_fail "could not download the binary"
curl -fsSL --retry 3 --retry-delay 2 -m 60 -o "$WORK_DIR/sonar.sha256" "$ASSET_BASE/sonar.sha256" \
  || download_fail "could not download the checksum"

# The checksum file is `<sha256>  sonar` (sha256sum's own format), so `-c` verifies
# the name AND the digest from inside the download dir. shasum is the fallback for a
# box without coreutils' sha256sum.
verify_checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$WORK_DIR" && sha256sum -c sonar.sha256 ) >/dev/null 2>&1
  elif command -v shasum >/dev/null 2>&1; then
    ( cd "$WORK_DIR" && shasum -a 256 -c sonar.sha256 ) >/dev/null 2>&1
  else
    return 2 # no verifier at all — treated as a hard failure below, never a skip
  fi
}
verify_rc=0
verify_checksum || verify_rc=$?
if [ "$verify_rc" -eq 2 ]; then
  download_fail "no sha256sum/shasum available to verify the artifact"
elif [ "$verify_rc" -ne 0 ]; then
  download_fail "CHECKSUM MISMATCH — the downloaded binary is not the published one"
fi
chmod +x "$NEW_BIN"
[ -x "$NEW_BIN" ] || download_fail "the downloaded artifact is not executable"
log "checksum verified for ${NEW_SHA:0:12}"

# ── 4. PRE-SMOKE the new binary in ISOLATION (live service untouched) ─────────
# Boot the new binary on a free high loopback port with TLS DISABLED (no cert/key in
# its env ⇒ sonar serves plain HTTP; see apps/sonar/src/config.rs) and the live env's
# Turso creds, then poll its /health until it answers `"ok":true`. That single call
# proves a lot: the binary runs on this CPU (a bad -C target-cpu would SIGILL right
# here, with the live service untouched), it reaches Turso, decodes the vector blobs,
# builds both in-memory indexes, and serves HTTP.
#
# MEMORY: for the duration of this smoke the box holds TWO full copies of the index —
# the live one and the smoke's. Headroom must exceed 2x the index (see the README).
# The refresh interval is pushed far out so the throwaway process never loads a
# second time; it is reaped the moment the smoke resolves.
presmoke_fail() {
  alert "🛰️ sonar-freshen: PRE-SMOKE FAILED ($1) for ${NEW_SHA:0:12} on rave-01 — box untouched, staying on the current sonar binary"
  post_health degraded "a sonar update failed validation; the live engine is untouched on the current binary"
  die "pre-smoke failed: $1"
}

SMOKE_TURSO_URL="$(env_value TURSO_DATABASE_URL)"
SMOKE_TURSO_TOKEN="$(env_value TURSO_AUTH_TOKEN)"
SMOKE_SECRET="$(env_value SONAR_SECRET)"
[ -n "$SMOKE_TURSO_URL" ] && [ -n "$SMOKE_TURSO_TOKEN" ] && [ -n "$SMOKE_SECRET" ] \
  || presmoke_fail "could not read the Turso creds / secret from the live service env"

# Pick a free high loopback port (bash /dev/tcp probe; no external tool needed).
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
SMOKE_PORT=""
for p in 42480 42481 42482 42483 42484; do
  if port_free "$p"; then SMOKE_PORT="$p"; break; fi
done
[ -n "$SMOKE_PORT" ] || presmoke_fail "no free loopback port for the isolated boot"

SMOKE_LOG="$WORK_DIR/boot.log"
TURSO_DATABASE_URL="$SMOKE_TURSO_URL" TURSO_AUTH_TOKEN="$SMOKE_TURSO_TOKEN" \
  SONAR_SECRET="$SMOKE_SECRET" SONAR_BIND=127.0.0.1 SONAR_PORT="$SMOKE_PORT" \
  SONAR_REFRESH_SECS=86400 SONAR_TLS_CERT='' SONAR_TLS_KEY='' \
  "$NEW_BIN" >"$SMOKE_LOG" 2>&1 &
SMOKE_PID=$!
# Always reap the throwaway server — it holds a second full copy of the index in RAM.
cleanup_smoke() { kill "$SMOKE_PID" >/dev/null 2>&1 || true; wait "$SMOKE_PID" 2>/dev/null || true; }
trap 'cleanup_smoke; rm -rf "$WORK_DIR"' EXIT

# sonar's /health serialises `"ok":true` with no spaces (serde), so one grep is the
# whole assertion: the process is up AND its indexes are built AND it answers HTTP.
smoke_healthy() { curl -fsS -m 10 "http://127.0.0.1:$SMOKE_PORT/health" 2>/dev/null | grep -q '"ok":true'; }

smoked=0
for _ in $(seq 1 "$BOOT_TIMEOUT_SECS"); do
  if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
    # Include only the tail of the boot log: it is sonar's own tracing output (config
    # summary + counts), never a secret value.
    presmoke_fail "the new binary exited during boot ($(tr '\n' ' ' <"$SMOKE_LOG" | tail -c 200))"
  fi
  if smoke_healthy; then smoked=1; break; fi
  sleep 1
done
[ "$smoked" = "1" ] || presmoke_fail "the new binary did not serve a healthy /health within ${BOOT_TIMEOUT_SECS}s"
cleanup_smoke
trap 'rm -rf "$WORK_DIR"' EXIT
log "pre-smoke passed"

if [ "$MODE" = "--dry-run" ]; then
  log "dry-run: ${NEW_SHA:0:12} downloaded, verified and pre-smoked; leaving the live service untouched"
  exit 0
fi

# ── 5. swap (the only moment the live service is touched) ─────────────────────
# Keep the current binary as the rollback target, then atomically replace the live
# binary (rename on the same filesystem) and restart. Replacing the on-disk file under
# the running process is safe on Linux (the old process holds its inode until restart).
command -v systemctl >/dev/null || die "systemctl not found — cannot manage $SERVICE"

# The live listener, read from the service env. Cloudflare proxies to this origin on
# 443 with an Origin Certificate, so TLS is normally on; a cert path in the env is what
# decides http vs https for the smoke below.
LIVE_PORT="$(env_value SONAR_PORT)"
LIVE_PORT="${LIVE_PORT:-443}"
LIVE_CURL=(curl -fsS -m 10)
LIVE_SCHEME="http"
if [ -n "$(env_value SONAR_TLS_CERT)" ]; then
  LIVE_SCHEME="https"
  # `-k` is CORRECT here, not a shortcut: the Origin Certificate's SAN is the public
  # hostname, so a loopback request legitimately mismatches the name. We are proving
  # the service answers, not validating Cloudflare's PKI. Do not "fix" this away.
  LIVE_CURL+=(-k)
fi
LIVE_CURL+=("$LIVE_SCHEME://127.0.0.1:$LIVE_PORT/health")
live_healthy() { "${LIVE_CURL[@]}" 2>/dev/null | grep -q '"ok":true'; }

if [ -f "$APP_BIN" ]; then
  cp -f "$APP_BIN" "$PREV_BIN" || die "could not snapshot the current binary to $PREV_BIN"
fi
install -m 0755 "$NEW_BIN" "$APP_BIN.new"
mv -f "$APP_BIN.new" "$APP_BIN"

log "swapping $SERVICE to ${NEW_SHA:0:12} and restarting"
service_healthy() {
  systemctl restart "$SERVICE" || return 1
  # A restart re-reads the whole corpus out of Turso before /health answers, so poll
  # rather than sleeping a fixed beat.
  local i
  for ((i = 0; i < BOOT_TIMEOUT_SECS; i++)); do
    if ! systemctl is-active --quiet "$SERVICE"; then return 1; fi
    if live_healthy; then return 0; fi
    sleep 1
  done
  return 1
}

# ── 6. post-swap smoke (the `if` keeps set -e from bare-exiting) ──────────────
if service_healthy; then
  log "post-swap smoke passed — deployed ${NEW_SHA:0:12}"
  printf '%s\n' "$NEW_SHA" >"$SHA_FILE"
  rm -f "$PREV_BIN"
  alert "🚀 sonar-freshen: deployed ${NEW_SHA:0:12} to sonar on rave-01 (CI artifact verified + swapped)"
  post_health ok "swapped sonar to the latest published build"
  exit 0
fi

# ── 7. ROLLBACK — the box is never left broken ────────────────────────────────
log "the new binary did not come up healthy — rolling back"
if [ -f "$PREV_BIN" ]; then
  install -m 0755 "$PREV_BIN" "$APP_BIN.rb"
  mv -f "$APP_BIN.rb" "$APP_BIN"
  if service_healthy; then
    rm -f "$PREV_BIN"
    alert "↩️ sonar-freshen: ${NEW_SHA:0:12} failed smoke on rave-01 — ROLLED BACK to the previous sonar binary (running). A human should look."
    post_health degraded "rolled back a failed sonar update; healthy on the previous binary"
    die "rolled back after a failed deploy"
  fi
fi
alert "🔴 sonar-freshen: ROLLBACK ALSO FAILED on rave-01 — sonar is DOWN. Operator needed NOW."
post_health down "the sonar engine is down after a failed update — operator needed"
die "rollback failed — sonar is down"
