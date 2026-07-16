#!/usr/bin/env bash
# provision-rave-03.sh — create a fresh box.ascii render box from clean `main` and
# print its box id on STDOUT (the only thing on stdout; all progress -> stderr).
#
# Called by render-conductor.sh when `box resume` 404s — box.ascii reclaims idle
# boxes AND their snapshots past the archive window, so a render box is not durable
# state. This makes a purge a ~5-min non-event: the box is reproducible from main +
# the conductor's own baked CLI, no golden snapshot to babysit. This is the COLD-START
# path only: a *resumed* snapshot (the common path) self-updates instead — the
# conductor's `freshen_checkout` git-resets its stale checkout to current `main` at wake.
#
# Reproduces exactly what shipped 019.1.7X by hand: clone main, install, add the
# fluncle-video skill, lay down the bun-wrapped `fluncle` CLI (the upload uses
# Bun-runtime APIs, so it must run under bun) and the detached-render entry.
#
# CLAUDE: the box.ascii base image ships a GLOBAL npm claude under /usr/local (root-
# owned), which the render user cannot auto-update ("insufficient permissions") — so it
# freezes at whatever the base baked (2.1.145, 2026-05, which stopped rendering). We do
# NOT own the base image, so we install a NATIVE claude into the user-owned ~/.local/bin
# (self-updating, and render-detached.sh already puts ~/.local/bin first on PATH so it
# SHADOWS the stale global). A native box then tracks current claude on its own at each
# launch. This is required, not best-effort: a box that can't render is not worth keeping.
set -uo pipefail
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
BOX_BIN="${BOX_BIN:-/usr/local/bin/box}"
BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}" # the conductor's bundled CLI, copied onto the box
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="${FLUNCLE_REPO_URL:-https://github.com/mauricekleine/fluncle}"

err() { printf '%s\n' "$*" >&2; }

# 1. Create the box. --no-auto-stop is REQUIRED, for two reasons: idle auto-stop
#    could fire during a claude-thinking gap and kill a render, AND the conductor
#    poll-detects "done" by ssh'ing the RUNNING box — a parked/auto-stopped box
#    isn't reachable, so it must stay up until the conductor explicitly stops it.
#    box.ascii REJECTS --no-auto-stop combined with --ttl ("use --no-auto-stop by
#    itself"), so there is NO box-side lifetime backstop: the conductor is the sole
#    stop authority (its per-tick stop + the MAX_RENDER stuck-guard force-stop). A
#    conductor that dies ENTIRELY mid-render leaves a running box — mitigated by the
#    container's restart policy + the hourly stuck-guard, else an operator cleanup.
new_json="$("$BOX_BIN" new --json --no-auto-stop 2>&1)" || {
  err "box new failed: $new_json"
  exit 1
}
id="$(printf '%s' "$new_json" | "$BUN_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.trim().split("\n")){try{const j=JSON.parse(l);if(j&&j.id){process.stdout.write(j.id);break}}catch(e){}}})')"
if [ -z "$id" ]; then
  err "could not parse a box id from: $new_json"
  exit 1
fi
err "provisioning render box $id from $REPO ..."

# 2. Clone clean main + install + the fluncle-video skill + the bun-wrapper. The
#    wrapper dir is created BEFORE the scp in step 3 (the scp target must exist).
#    EVERY step gets </dev/null: this runs via `bash -s` (the script is on stdin), and
#    `npx skills add` (interactive) otherwise READS that stdin and eats the rest of the
#    script — silently skipping the mkdir, so the step-3 scp then fails on a missing dir.
#    box ssh returns non-zero on remote failure (set -e), so the check catches a real one.
if ! "$BOX_BIN" ssh "$id" 'bash -s' >&2 <<PROV
set -e
cd ~ && rm -rf fluncle
git clone --depth 1 $REPO fluncle </dev/null
cd fluncle && bun install </dev/null >/dev/null 2>&1
npx -y skills add ./packages/skills/fluncle-video -y -a claude-code </dev/null >/dev/null 2>&1
# Native, self-updating claude into ~/.local/bin (shadows the un-updatable global base
# claude; render-detached.sh's PATH puts ~/.local/bin first). set -e aborts provisioning
# on failure — a box without a current claude cannot render, so fail loud and reprovision.
claude install stable </dev/null >&2
mkdir -p ~/.local/bin ~/.local/lib
printf '#!/bin/sh\nexec bun "\$HOME/.local/lib/fluncle.mjs" "\$@"\n' > ~/.local/bin/fluncle
chmod +x ~/.local/bin/fluncle
PROV
then
  err "box setup failed"
  exit 1
fi

# Belt-and-suspenders: confirm setup actually produced the wrapper dir before the scp
# (the stdin-eating bug failed silently with box ssh still returning 0).
if ! "$BOX_BIN" ssh "$id" 'test -d "$HOME/.local/lib"' </dev/null >/dev/null 2>&1; then
  err "box setup incomplete — no ~/.local/lib after setup"
  exit 1
fi

# 3. Copy the bundled fluncle CLI (run under bun via the wrapper) + the detached
#    render entry onto the box (~/.local/lib exists from step 2).
if ! "$BOX_BIN" scp "$FLUNCLE_BIN" "$id:/home/user/.local/lib/fluncle.mjs" >&2; then
  err "fluncle CLI copy failed"
  exit 1
fi
if ! "$BOX_BIN" scp "$SCRIPT_DIR/render-detached.sh" "$id:/home/user/render-detached.sh" >&2; then
  err "render-detached.sh copy failed"
  exit 1
fi
"$BOX_BIN" ssh "$id" 'chmod +x ~/render-detached.sh' >&2 || true

err "provisioned render box $id"
# stdout = JUST the box id (render-conductor.sh captures it)
printf '%s' "$id"
