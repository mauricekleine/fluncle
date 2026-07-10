#!/usr/bin/env bash
# fluncle-ssh-freshen — the rave-01 box's self-deploy for the public SSH terminal.
#
# Watches `origin/main` and, when a commit that CHANGES the SSH app's compiled
# sources lands (`apps/ssh/**/*.go`, `apps/ssh/go.mod`, `apps/ssh/go.sum` — e.g. a
# `golang.org/x/crypto` CVE bump), rebuilds the `fluncle-ssh` binary ON THE BOX,
# pre-smokes the new artifact in ISOLATION on a throwaway port BEFORE the live one
# is touched, swaps it into the `fluncle-ssh` systemd service, restarts, post-smokes,
# and auto-rolls-back to the prior binary on any failure. The box is never left broken.
#
# This is the SSH sibling of docs/agents/hermes/pin-watch (the rave-02 Hermes
# self-deploy) and lives beside the rave-01 dead-man's-switch watchdog in
# apps/ssh/watchdog/. It closes the gap where a merge to main — a security bump
# included — did NOT reach the live `ssh rave.fluncle.com` server until an operator
# remembered to re-run deploy-ssh-app-service.sh by hand.
#
# CREDENTIAL-FREE BY DESIGN: the repo is public (the clone needs no key), and the
# swap only REPLACES THE BINARY at /opt/fluncle-ssh/fluncle-ssh and restarts the
# service — the systemd unit + /etc/fluncle-ssh.env (the service contract the deploy
# script established) are left untouched, so it reuses the env already on the box and
# reads nothing from `op`. The optional Discord-alert + /status-post inputs come from
# an operator-placed EnvironmentFile kept OUT of the repo; unset any of them and that
# best-effort visibility is simply skipped (same posture as the watchdog).
#
# Run by fluncle-ssh-freshen.timer (default: --if-changed, a no-op when current). Run
# once by hand with --force to clear accumulated debt and validate the recipe; run
# with --dry-run to build + pre-smoke the new binary and STOP (the live service is
# never touched).
#
# Doctrine: apps/ssh/deploy/README.md + the hetzner-devbox skill.
set -euo pipefail

# ── config (overridable via the env) ──────────────────────────────────────────
REPO_URL="${SSHFRESHEN_REPO_URL:-https://github.com/mauricekleine/fluncle.git}"
REPO_DIR="${SSHFRESHEN_REPO_DIR:-/opt/fluncle-ssh-build}"
STATE_DIR="${SSHFRESHEN_STATE_DIR:-/opt/fluncle-ssh-freshen}"
SHA_FILE="${SSHFRESHEN_SHA_FILE:-$STATE_DIR/deployed-sha}"
LOCK="${SSHFRESHEN_LOCK:-/run/lock/fluncle-ssh-freshen.lock}"

# The live service contract (must match deploy-ssh-app-service.sh + the .service unit).
SERVICE="${SSHFRESHEN_SERVICE:-fluncle-ssh}"
APP_DIR="${SSHFRESHEN_APP_DIR:-/opt/fluncle-ssh}"
APP_BIN="${SSHFRESHEN_APP_BIN:-$APP_DIR/fluncle-ssh}"
PREV_BIN="$APP_BIN.prev"
SERVICE_ENV="${SSHFRESHEN_SERVICE_ENV:-/etc/fluncle-ssh.env}"

# The build source inside the checkout.
APP_SRC="apps/ssh"

# Optional alert/status inputs (operator EnvironmentFile; all best-effort, all optional).
WORKER_URL="${SSHFRESHEN_WORKER_URL:-https://www.fluncle.com}"

MODE="--if-changed"
case "${1:-}" in
  --force) MODE="--force" ;;     # rebuild regardless of the diff (the operator pilot)
  --dry-run) MODE="--dry-run" ;; # build + pre-smoke the new binary, then STOP (never swap)
esac

log() { printf '[ssh-freshen] %s\n' "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

# ── single-flight ─────────────────────────────────────────────────────────────
exec 9>"$LOCK"
flock -n 9 || { log "another run holds the lock; exiting"; exit 0; }

command -v git >/dev/null || die "git not found"
command -v go  >/dev/null || die "go toolchain not found — install it (the one provisioning pre-req; see apps/ssh/deploy/README.md)"

# ── Discord alert (best-effort; webhook from the operator EnvironmentFile). Never throws. ──
alert() {
  [ -n "${DISCORD_ALERT_WEBHOOK:-}" ] || return 0
  curl -fsS -m 10 -H 'Content-Type: application/json' \
    -d "$(printf '{"content":%s}' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')")" \
    "${DISCORD_ALERT_WEBHOOK}" >/dev/null 2>&1 || true
}

# Self-deploy health → the public /status board (the `self-deploy-ssh` row, the rave-01
# parallel to pin-watch's `self-deploy`). Best-effort, never throws; the message is
# public-safe and deliberately vague (no host, no raw error). status ∈ ok|degraded|down.
# Needs the agent token + worker URL from the operator EnvironmentFile; unset → skipped.
post_health() {
  [ -n "${FLUNCLE_API_TOKEN:-}" ] || return 0
  local status="$1" esc
  esc="$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  curl -fsS -m 10 \
    -H 'Content-Type: application/json' -H "Authorization: Bearer ${FLUNCLE_API_TOKEN}" \
    -d "$(printf '{"at":"%s","checks":[{"service":"self-deploy-ssh","status":"%s","message":"%s","latencyMs":null,"transitioned":false}]}' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$status" "$esc")" \
    "${WORKER_URL%/}/api/admin/health" >/dev/null 2>&1 || true
}

# ── 1. sync the build context (public repo, no credential) ────────────────────
# NOT a shallow clone: the change-detection diff below needs the previously-deployed
# commit reachable, so we keep full history (the repo is small).
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" fetch origin main -q
else
  log "cloning the public repo into $REPO_DIR"
  rm -rf "$REPO_DIR"
  git clone "$REPO_URL" "$REPO_DIR" -q
fi
git -C "$REPO_DIR" checkout -q -B main origin/main
git -C "$REPO_DIR" reset --hard -q origin/main

NEW_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
OLD_SHA="$(cat "$SHA_FILE" 2>/dev/null || true)"

# ── 2. decide whether to rebuild ──────────────────────────────────────────────
# Rebuild when: --force; OR no recorded baseline (first run); OR the recorded SHA is
# unreachable (history rewrite / pruned) — a safe rebuild re-baselines; OR the diff
# from the deployed SHA to HEAD touches a COMPILED source (a .go file, or go.mod /
# go.sum). A docs-only, unit-only (apps/ssh/deploy, apps/ssh/watchdog, *.md) or
# web-only merge changes no compiled source → no rebuild, no restart.
should_build=0
reason=""
if [ "$MODE" = "--force" ]; then
  should_build=1; reason="forced"
elif [ -z "$OLD_SHA" ]; then
  should_build=1; reason="no baseline (first run)"
elif ! git -C "$REPO_DIR" cat-file -e "${OLD_SHA}^{commit}" 2>/dev/null; then
  should_build=1; reason="recorded baseline $OLD_SHA unreachable — re-baselining"
elif [ "$OLD_SHA" = "$NEW_SHA" ]; then
  should_build=0; reason="already at $NEW_SHA"
else
  changed="$(git -C "$REPO_DIR" diff --name-only "$OLD_SHA" "$NEW_SHA" -- "$APP_SRC" \
    | grep -E '\.go$|/go\.(mod|sum)$' || true)"
  if [ -n "$changed" ]; then
    should_build=1; reason="apps/ssh sources changed: $(printf '%s' "$changed" | tr '\n' ' ')"
  else
    should_build=0; reason="no compiled-source change in $OLD_SHA..$NEW_SHA"
  fi
fi

log "$OLD_SHA -> $NEW_SHA | $reason"
if [ "$should_build" != "1" ]; then
  log "no rebuild needed — no-op"
  post_health ok "SSH terminal current"
  exit 0
fi

# ── 3. build the new binary (on-box, throwaway output) ────────────────────────
BUILD_OUT="$(mktemp -d "${TMPDIR:-/tmp}/ssh-freshen.XXXXXX")"
trap 'rm -rf "$BUILD_OUT"' EXIT
NEW_BIN="$BUILD_OUT/fluncle-ssh"
# `go build` runs under a ROOT systemd oneshot, which sets no $HOME — so Go cannot derive
# a module/build cache path and dies with "module cache not found: neither GOMODCACHE nor
# GOPATH is set", never touching the box. Point Go at an explicit, persistent cache under
# the state dir (outside the git checkout, so `git reset` never wipes it, and modules are
# not re-downloaded every tick). Both are needed: GOPATH covers the module cache, GOCACHE
# the build cache — with $HOME unset, GOCACHE would otherwise resolve under a missing home.
GO_CACHE_ROOT="${SSHFRESHEN_GO_CACHE:-$STATE_DIR/go}"
mkdir -p "$GO_CACHE_ROOT/path" "$GO_CACHE_ROOT/build"
log "building $NEW_BIN from $REPO_DIR/$APP_SRC (commit ${NEW_SHA:0:12})"
if ! ( cd "$REPO_DIR/$APP_SRC" \
    && CGO_ENABLED=0 GOPATH="$GO_CACHE_ROOT/path" GOCACHE="$GO_CACHE_ROOT/build" \
       go build -o "$NEW_BIN" . ); then
  alert "🛰️ ssh-freshen: BUILD FAILED for ${NEW_SHA:0:12} on rave-01 — box untouched, staying on the current SSH binary"
  post_health degraded "an SSH terminal update failed to build; staying on the current binary"
  die "go build failed"
fi
[ -x "$NEW_BIN" ] || die "build produced no executable at $NEW_BIN"

# ── 4. PRE-SMOKE the new binary in ISOLATION (live service untouched) ─────────
# Boot the new binary on a throwaway loopback port + temp data dir (no GeoIP — the
# app treats an empty FLUNCLE_GEOIP_DB as "skip"), then prove it completes a real SSH
# key exchange (ssh-keyscan returns the freshly-generated host key). This exercises
# the exact failure a bad crypto/wish bump would cause — the server not speaking SSH —
# BEFORE the live one is touched. A boot-then-handshake smoke needs no network (the
# app only calls the API per-session, not at boot).
presmoke_fail() {
  alert "🛰️ ssh-freshen: PRE-SMOKE FAILED ($1) for ${NEW_SHA:0:12} on rave-01 — box untouched, staying on the current SSH binary"
  post_health degraded "an SSH terminal update failed validation; box untouched on the current binary"
  die "pre-smoke failed: $1"
}

# Pick a free high loopback port (bash /dev/tcp probe; no external tool needed).
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
SMOKE_PORT=""
for p in 42422 42423 42424 42425 42426; do
  if port_free "$p"; then SMOKE_PORT="$p"; break; fi
done
[ -n "$SMOKE_PORT" ] || presmoke_fail "no free loopback port for the isolated boot"

SMOKE_DATA="$BUILD_OUT/data"
mkdir -p "$SMOKE_DATA"
SMOKE_LOG="$BUILD_OUT/boot.log"
FLUNCLE_SSH_HOST=127.0.0.1 FLUNCLE_SSH_PORT="$SMOKE_PORT" \
  FLUNCLE_SSH_DATA_DIR="$SMOKE_DATA" FLUNCLE_GEOIP_DB="" \
  "$NEW_BIN" >"$SMOKE_LOG" 2>&1 &
SMOKE_PID=$!
# Ensure the throwaway server is always reaped, even on an early die/return.
cleanup_smoke() { kill "$SMOKE_PID" >/dev/null 2>&1 || true; wait "$SMOKE_PID" 2>/dev/null || true; }
trap 'cleanup_smoke; rm -rf "$BUILD_OUT"' EXIT

# Wait up to ~10s for the port to accept (or the process to die).
booted=0
for _ in $(seq 1 50); do
  if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
    presmoke_fail "new binary exited during boot ($(tr -d '\n' <"$SMOKE_LOG" | tail -c 200))"
  fi
  if ! port_free "$SMOKE_PORT"; then booted=1; break; fi
  sleep 0.2
done
[ "$booted" = "1" ] || presmoke_fail "new binary did not open $SMOKE_PORT within ~10s"

# Prove it speaks SSH: a completed key exchange returns the host key. ssh-keyscan ships
# with openssh (rave-01 runs OpenSSH admin on the private port). Fall back to the boot
# proof (port open + the "listening" line) if ssh-keyscan is somehow absent.
if command -v ssh-keyscan >/dev/null 2>&1; then
  if ! ssh-keyscan -T 8 -p "$SMOKE_PORT" 127.0.0.1 2>/dev/null | grep -q .; then
    presmoke_fail "new binary did not complete an SSH key exchange on $SMOKE_PORT"
  fi
elif ! grep -q 'listening on' "$SMOKE_LOG"; then
  presmoke_fail "new binary did not report listening (ssh-keyscan unavailable for a full handshake smoke)"
fi
cleanup_smoke
trap 'rm -rf "$BUILD_OUT"' EXIT
log "pre-smoke passed"

if [ "$MODE" = "--dry-run" ]; then
  log "dry-run: ${NEW_SHA:0:12} built and pre-smoke passed; leaving the live service untouched"
  exit 0
fi

# ── 5. swap (the only moment the live service is touched) ─────────────────────
# Keep the current binary as the rollback target, then atomically replace the live
# binary (rename on the same filesystem) and restart. Replacing the on-disk file under
# the running process is safe on Linux (the old process holds its inode until restart).
command -v systemctl >/dev/null || die "systemctl not found — cannot manage $SERVICE"
mkdir -p "$STATE_DIR"

# Read the live service port for the post-swap smoke (default 22 per the deploy script).
LIVE_PORT="$(sed -n 's/^FLUNCLE_SSH_PORT=//p' "$SERVICE_ENV" 2>/dev/null | head -1)"
LIVE_PORT="${LIVE_PORT:-22}"

if [ -f "$APP_BIN" ]; then
  cp -f "$APP_BIN" "$PREV_BIN" || die "could not snapshot the current binary to $PREV_BIN"
fi
install -m 0755 "$NEW_BIN" "$APP_BIN.new"
mv -f "$APP_BIN.new" "$APP_BIN"

log "swapping $SERVICE to ${NEW_SHA:0:12} and restarting"
service_healthy() {
  systemctl restart "$SERVICE" || return 1
  sleep 3
  systemctl is-active --quiet "$SERVICE" || return 1
  # Prove the LIVE service speaks SSH on its real port (loopback).
  if command -v ssh-keyscan >/dev/null 2>&1; then
    ssh-keyscan -T 8 -p "$LIVE_PORT" 127.0.0.1 2>/dev/null | grep -q .
  else
    systemctl is-active --quiet "$SERVICE"
  fi
}

# ── 6. post-swap smoke (the `if` keeps set -e from bare-exiting) ──────────────
if service_healthy; then
  log "post-swap smoke passed — deployed ${NEW_SHA:0:12}"
  printf '%s\n' "$NEW_SHA" >"$SHA_FILE"
  rm -f "$PREV_BIN"
  alert "🚀 ssh-freshen: deployed ${NEW_SHA:0:12} to fluncle-ssh on rave-01 (apps/ssh rebuilt + swapped)"
  post_health ok "rebuilt the SSH terminal from the latest apps/ssh"
  exit 0
fi

# ── 7. ROLLBACK — the box is never left broken ────────────────────────────────
log "new binary did not come up healthy — rolling back"
if [ -f "$PREV_BIN" ]; then
  install -m 0755 "$PREV_BIN" "$APP_BIN.rb"
  mv -f "$APP_BIN.rb" "$APP_BIN"
  if service_healthy; then
    rm -f "$PREV_BIN"
    alert "↩️ ssh-freshen: ${NEW_SHA:0:12} failed smoke on rave-01 — ROLLED BACK to the previous SSH binary (running). A human should look."
    post_health degraded "rolled back a failed SSH terminal update; healthy on the previous binary"
    die "rolled back after a failed deploy"
  fi
fi
alert "🔴 ssh-freshen: ROLLBACK ALSO FAILED on rave-01 — the SSH terminal is DOWN. Operator needed NOW."
post_health down "SSH terminal down after a failed update — operator needed"
die "rollback failed — the SSH terminal is down"
