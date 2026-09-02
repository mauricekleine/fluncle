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
SOURCE_MANIFEST_FILE="${SSHFRESHEN_SOURCE_MANIFEST_FILE:-$STATE_DIR/deployed-source-manifest.sha256}"
LOCK="${SSHFRESHEN_LOCK:-/run/lock/fluncle-ssh-freshen.lock}"

# GitHub's anonymous smart-HTTP POST can occasionally be challenged as though a public
# repository needed credentials. The read-only API + codeload archive are a second,
# independently configurable public path: no token, credential helper, or SSH key.
PUBLIC_REF_URL="${SSHFRESHEN_PUBLIC_REF_URL:-https://api.github.com/repos/mauricekleine/fluncle/git/ref/heads/main}"
PUBLIC_ARCHIVE_BASE="${SSHFRESHEN_PUBLIC_ARCHIVE_BASE:-https://codeload.github.com/mauricekleine/fluncle/tar.gz}"
GIT_TIMEOUT_SECS="${SSHFRESHEN_GIT_TIMEOUT_SECS:-60}"

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
case "$GIT_TIMEOUT_SECS" in
  '' | *[!0-9]* | 0) die "SSHFRESHEN_GIT_TIMEOUT_SECS must be a positive integer" ;;
esac

# ── single-flight ─────────────────────────────────────────────────────────────
exec 9>"$LOCK"
flock -n 9 || { log "another run holds the lock; exiting"; exit 0; }

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
  local status="$1" esc at producer core digest key body reconcile_body response http_status response_body attempt
  esc="$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  producer="ssh-freshen"
  core="$(printf '{"at":"%s","checks":[{"latencyMs":null,"message":"%s","service":"self-deploy-ssh","status":"%s","transitioned":false}],"producer":"%s"}' \
    "$at" "$esc" "$status" "$producer")"
  if command -v sha256sum >/dev/null 2>&1; then
    digest="$(printf '%s' "$core" | sha256sum | awk '{print $1}')"
  else
    digest="$(printf '%s' "$core" | shasum -a 256 | awk '{print $1}')"
  fi
  key="health.snapshot:${producer}:${at}"
  body="$(printf '{"at":"%s","checks":[{"service":"self-deploy-ssh","status":"%s","message":"%s","latencyMs":null,"transitioned":false}],"operationKey":"%s","producer":"%s","requestDigest":"%s"}' \
    "$at" "$status" "$esc" "$key" "$producer" "$digest")"
  reconcile_body="$(printf '{"operationId":"health.snapshot","operationKey":"%s","requestDigest":"%s"}' "$key" "$digest")"

  for attempt in 1 2; do
    http_status=""
    if http_status="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' \
      -H 'Content-Type: application/json' -H "Authorization: Bearer ${FLUNCLE_API_TOKEN}" \
      -d "$body" "${WORKER_URL%/}/api/v1/admin/health" 2>/dev/null)"; then
      case "$http_status" in
        2??) return 0 ;;
        4??) log "record_health rejected the snapshot (best-effort, not replayed)"; return 0 ;;
      esac
    fi

    if ! response="$(curl -sS -m 10 -w $'\n%{http_code}' \
      -H 'Content-Type: application/json' -H "Authorization: Bearer ${FLUNCLE_API_TOKEN}" \
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
# Prefer the existing full checkout because it gives exact path-level change detection.
# Git is explicitly non-interactive: a public-host auth challenge is a transport failure,
# never a reason for this root service to discover or prompt for credentials. When smart
# HTTP fails, resolve `main` through GitHub's public API and fetch the archive for that EXACT
# 40-character commit. Codeload's root directory repeats that SHA; reject any mismatch before
# using the bytes as source.
mkdir -p "$STATE_DIR"
SOURCE_DIR="$REPO_DIR"
SYNC_KIND="git"
public_git() {
  if command -v timeout >/dev/null 2>&1; then
    timeout --foreground "${GIT_TIMEOUT_SECS}s" env GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false \
      git -c credential.helper= "$@"
  else
    env GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false git -c credential.helper= "$@"
  fi
}
git_sync() {
  local clone_dir
  if [ -d "$REPO_DIR/.git" ]; then
    if ! public_git -C "$REPO_DIR" fetch origin main -q; then
      return 1
    fi
  else
    clone_dir="${REPO_DIR}.next.$$"
    rm -rf "$clone_dir"
    if ! public_git clone "$REPO_URL" "$clone_dir" -q; then
      rm -rf "$clone_dir"
      return 1
    fi
    rm -rf "$REPO_DIR"
    mv "$clone_dir" "$REPO_DIR"
  fi
  git -C "$REPO_DIR" checkout -q -B main origin/main || return 1
  git -C "$REPO_DIR" reset --hard -q origin/main || return 1
}

if command -v git >/dev/null 2>&1 && git_sync; then
  NEW_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
else
  log "anonymous git sync failed; falling back to the public commit archive"
  command -v curl >/dev/null 2>&1 || die "curl not found for public archive fallback"
  command -v tar >/dev/null 2>&1 || die "tar not found for public archive fallback"
  ARCHIVE_WORK="$(mktemp -d "${TMPDIR:-/tmp}/ssh-source.XXXXXX")"
  REF_JSON="$ARCHIVE_WORK/ref.json"
  ARCHIVE="$ARCHIVE_WORK/source.tar.gz"
  ARCHIVE_LIST="$ARCHIVE_WORK/source.list"
  if ! curl -fsSL --retry 2 --retry-all-errors --retry-delay 2 \
      --connect-timeout 10 --max-time 30 -H 'Accept: application/vnd.github+json' \
      -o "$REF_JSON" "$PUBLIC_REF_URL"; then
    rm -rf "$ARCHIVE_WORK"
    die "could not resolve the public main commit"
  fi
  NEW_SHA="$(sed -n 's/^[[:space:]]*"sha":[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' "$REF_JSON" | sed -n '1p')"
  if ! printf '%s' "$NEW_SHA" | grep -Eq '^[0-9a-f]{40}$'; then
    rm -rf "$ARCHIVE_WORK"
    die "the public main ref did not resolve to a commit SHA"
  fi
  if ! curl -fsSL --retry 2 --retry-all-errors --retry-delay 2 \
      --connect-timeout 10 --max-time 90 -o "$ARCHIVE" \
      "$PUBLIC_ARCHIVE_BASE/$NEW_SHA"; then
    rm -rf "$ARCHIVE_WORK"
    die "could not fetch the public source archive for ${NEW_SHA:0:12}"
  fi
  if ! tar -tzf "$ARCHIVE" >"$ARCHIVE_LIST"; then
    rm -rf "$ARCHIVE_WORK"
    die "public source archive is not a readable tarball"
  fi
  ARCHIVE_ROOT="$(sed -n '1p' "$ARCHIVE_LIST")"
  case "$ARCHIVE_ROOT" in
    *-"$NEW_SHA"/) ;;
    *) rm -rf "$ARCHIVE_WORK"; die "public source archive identity did not match ${NEW_SHA:0:12}" ;;
  esac
  if grep -Eq '(^/|(^|/)\.\.(/|$))' "$ARCHIVE_LIST"; then
    rm -rf "$ARCHIVE_WORK"
    die "public source archive contains an unsafe path"
  fi
  ARCHIVE_SOURCE="$STATE_DIR/source.next.$$"
  rm -rf "$ARCHIVE_SOURCE"
  mkdir -p "$ARCHIVE_SOURCE"
  if ! tar -xzf "$ARCHIVE" --strip-components=1 -C "$ARCHIVE_SOURCE"; then
    rm -rf "$ARCHIVE_SOURCE" "$ARCHIVE_WORK"
    die "could not unpack the public source archive"
  fi
  rm -rf "$ARCHIVE_WORK"
  [ -f "$ARCHIVE_SOURCE/$APP_SRC/go.mod" ] || {
    rm -rf "$ARCHIVE_SOURCE"
    die "public source archive is missing the SSH build context"
  }
  rm -rf "$STATE_DIR/source"
  mv "$ARCHIVE_SOURCE" "$STATE_DIR/source"
  SOURCE_DIR="$STATE_DIR/source"
  SYNC_KIND="archive"
fi

printf '%s' "$NEW_SHA" | grep -Eq '^[0-9a-f]{40}$' || die "synced source has no full commit SHA"
OLD_SHA="$(cat "$SHA_FILE" 2>/dev/null || true)"

# A persisted manifest keeps archive-mode change detection as precise as `git diff`: only
# Go sources and module locks affect the binary. It is written only after a successful swap,
# beside the deployed SHA, so rollback never advances either identity.
compiled_manifest() {
  local root="$1" file digest
  (
    cd "$root"
    while IFS= read -r -d '' file; do
      if command -v sha256sum >/dev/null 2>&1; then
        digest="$(sha256sum "$file" | awk '{print $1}')"
      else
        digest="$(shasum -a 256 "$file" | awk '{print $1}')"
      fi
      printf '%s  %s\n' "$digest" "$file"
    done < <(find "$APP_SRC" -type f \( -name '*.go' -o -name go.mod -o -name go.sum \) -print0 | sort -z)
  )
}
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 \
  || die "sha256sum/shasum not found for source identity"
NEW_MANIFEST="$(compiled_manifest "$SOURCE_DIR")"
[ -n "$NEW_MANIFEST" ] || die "synced source contains no compiled SSH inputs"

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
elif [ "$SYNC_KIND" = "git" ] && ! git -C "$REPO_DIR" cat-file -e "${OLD_SHA}^{commit}" 2>/dev/null; then
  should_build=1; reason="recorded baseline $OLD_SHA unreachable — re-baselining"
elif [ "$OLD_SHA" = "$NEW_SHA" ]; then
  should_build=0; reason="already at $NEW_SHA"
elif [ "$SYNC_KIND" = "git" ]; then
  changed="$(git -C "$REPO_DIR" diff --name-only "$OLD_SHA" "$NEW_SHA" -- "$APP_SRC" \
    | grep -E '\.go$|/go\.(mod|sum)$' || true)"
  if [ -n "$changed" ]; then
    should_build=1; reason="apps/ssh sources changed: $(printf '%s' "$changed" | tr '\n' ' ')"
  else
    should_build=0; reason="no compiled-source change in $OLD_SHA..$NEW_SHA"
  fi
elif [ ! -f "$SOURCE_MANIFEST_FILE" ]; then
  should_build=1; reason="no deployed source manifest — safely re-baselining from the public archive"
elif [ "$(cat "$SOURCE_MANIFEST_FILE")" = "$NEW_MANIFEST" ]; then
  should_build=0; reason="no compiled-source change in $OLD_SHA..$NEW_SHA"
else
  should_build=1; reason="apps/ssh compiled sources changed in $OLD_SHA..$NEW_SHA"
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
log "building $NEW_BIN from $SOURCE_DIR/$APP_SRC (commit ${NEW_SHA:0:12})"
if ! ( cd "$SOURCE_DIR/$APP_SRC" \
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
  printf '%s\n' "$NEW_MANIFEST" >"$SOURCE_MANIFEST_FILE"
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
