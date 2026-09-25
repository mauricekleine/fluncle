#!/usr/bin/env bash

set -uo pipefail
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

BOAT_BIN="${BOAT_BIN:-${BOX_BIN:-/usr/local/bin/boat}}"
BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="${FLUNCLE_REPO_URL:-https://github.com/mauricekleine/fluncle}"

err() { printf '%s\n' "$*" >&2; }

boat_cli() { "$BOAT_BIN" --no-update "$@"; }

new_json="$(boat_cli new --json --no-auto-stop 2>&1)" || {
	err "boat new failed: $new_json"
	exit 1
}

id="$(printf '%s' "$new_json" | "$BUN_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let ready="",first="",last=null;for(const l of s.trim().split("\n")){let j;try{j=JSON.parse(l)}catch{continue}if(!j||typeof j!=="object")continue;last=j;const id=typeof j.id==="string"?j.id:"";if(!id)continue;if(!first)first=id;if(j.event==="ready")ready=id}if(last&&last.event==="error")process.exit(0);process.stdout.write(ready||first)})')"
if [ -z "$id" ]; then
	err "could not parse a sandbox id from: $new_json"
	exit 1
fi
err "provisioning render box $id from $REPO ..."

abandon() {
	err "$1"
	boat_cli stop "$id" >/dev/null 2>&1 || true
	boat_cli extend "$id" --ttl "${CONDEMN_TTL:-60}" >/dev/null 2>&1 || true
	err "abandoned render box $id — parked, reclaimed in ${CONDEMN_TTL:-60}s"
	exit 1
}

if ! boat_cli ssh "$id" 'bash -s' >&2 <<PROV
set -e
cd ~ && rm -rf fluncle
git clone --depth 1 $REPO fluncle </dev/null
cd fluncle
# The box image's bun may predate the lockfile format the repo pins (packageManager in
# package.json); hold it at the pin before the install, as the conductor's freshen does.
# The installer is \`bash -s\` reading its script from the curl pipe — the one step here that
# must NOT get </dev/null, or it reads nothing and exits.
want=\$(sed -n 's/.*"packageManager": *"bun@\([0-9][0-9.]*\)".*/\1/p' package.json | head -1)
if [ -n "\$want" ] && [ "\$want" != "\$(bun --version)" ]; then
  if ! curl -fsSL https://bun.sh/install | BUN_INSTALL="\$HOME/.bun" bash -s "bun-v\$want" >"\$HOME/.provision-bun.log" 2>&1 \
    || ! install -m 0755 "\$HOME/.bun/bin/bun" /usr/local/bin/bun; then
    echo "bun toolchain: the repo pins \$want, the box has \$(bun --version), and the pinned install failed:" >&2
    tail -c 600 "\$HOME/.provision-bun.log" >&2
    exit 1
  fi
fi
bun install --frozen-lockfile </dev/null >/dev/null 2>&1
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
	abandon "box setup failed"
fi

if ! boat_cli ssh "$id" 'test -d "$HOME/.local/lib"' </dev/null >/dev/null 2>&1; then
	abandon "box setup incomplete — no ~/.local/lib after setup"
fi

if ! boat_cli scp "$FLUNCLE_BIN" "$id:~/.local/lib/fluncle.mjs" >&2; then
	abandon "fluncle CLI copy failed"
fi
if ! boat_cli scp "$SCRIPT_DIR/render-detached.sh" "$id:~/render-detached.sh" >&2; then
	abandon "render-detached.sh copy failed"
fi
boat_cli ssh "$id" 'chmod +x ~/render-detached.sh' >&2 || true

err "provisioned render box $id"

printf '%s' "$id"
