#!/usr/bin/env bash
# provision-rave-03.sh — create a fresh box.ascii render box from clean `main` and
# print its box id on STDOUT (the only thing on stdout; all progress -> stderr).
#
# Called by render-conductor.sh when `box resume` 404s — box.ascii reclaims idle
# boxes AND their snapshots past the archive window, so a render box is not durable
# state. This makes a purge a ~5-min non-event: the box is reproducible from main +
# the conductor's own baked CLI, no golden snapshot to babysit.
#
# Reproduces exactly what shipped 019.1.7X by hand: clone main, install, add the
# fluncle-video skill, lay down the bun-wrapped `fluncle` CLI (the upload uses
# Bun-runtime APIs, so it must run under bun) and the detached-render entry.
set -uo pipefail
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
BOX_BIN="${BOX_BIN:-/usr/local/bin/box}"
BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}" # the conductor's bundled CLI, copied onto the box
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="${FLUNCLE_REPO_URL:-https://github.com/mauricekleine/fluncle}"
TTL="${BOX_TTL:-6h}" # backstop: box.ascii archives the box after TTL if a crashed conductor never parks it

err() { printf '%s\n' "$*" >&2; }

# 1. Create the box. --no-auto-stop: the CONDUCTOR owns stop/resume (idle
#    auto-stop could fire during a claude-thinking gap and kill a render). --ttl
#    is the only backstop for a conductor that dies entirely mid-render; a
#    premature archive is recoverable (the next tick reprovisions).
new_json="$("$BOX_BIN" new --json --no-auto-stop --ttl "$TTL" 2>&1)" || {
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
if ! "$BOX_BIN" ssh "$id" 'bash -s' >&2 <<PROV
set -e
cd ~ && rm -rf fluncle
git clone --depth 1 $REPO fluncle
cd fluncle && bun install >/dev/null 2>&1
npx -y skills add ./packages/skills/fluncle-video -y -a claude-code >/dev/null 2>&1
mkdir -p ~/.local/bin ~/.local/lib
printf '#!/bin/sh\nexec bun "\$HOME/.local/lib/fluncle.mjs" "\$@"\n' > ~/.local/bin/fluncle
chmod +x ~/.local/bin/fluncle
PROV
then
  err "box setup failed"
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
