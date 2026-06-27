#!/usr/bin/env bash
# fluncle-secrets-sync.sh — materialize the box's secrets from 1Password (the single
# source). Reads OP_SERVICE_ACCOUNT_TOKEN from /etc/hermes-bootstrap.env, op-injects
# the gateway env-file + the shared sweep-secrets file (written into the mounted
# state dir the hermes container sees). Atomic (temp -> install) + sanity-checked, so
# an op outage can never leave a partial/empty secrets file. Run at boot + on a timer.
set -euo pipefail
BOOTSTRAP=/etc/hermes-bootstrap.env
TPL_DIR=/etc/hermes
GATEWAY_OUT=/etc/hermes.env
SWEEP_OUT=/home/admin/.hermes/home/.fluncle-secrets.env   # = /opt/data/home/.fluncle-secrets.env in-container
[ -r "$BOOTSTRAP" ] || { echo "fluncle-secrets-sync: missing $BOOTSTRAP" >&2; exit 1; }
set -a; . "$BOOTSTRAP"; set +a
umask 077
tg="$(mktemp)"; ts="$(mktemp)"; trap 'rm -f "$tg" "$ts"' EXIT
op inject -f -i "$TPL_DIR/hermes.env.tpl"          -o "$tg"
op inject -f -i "$TPL_DIR/fluncle-secrets.env.tpl" -o "$ts"
grep -q OPENROUTER_API_KEY "$tg"      || { echo "gateway inject sanity fail" >&2; exit 1; }
grep -q CLAUDE_CODE_OAUTH_TOKEN "$ts" || { echo "sweep inject sanity fail" >&2; exit 1; }
install -m 600 -o root -g root "$tg" "$GATEWAY_OUT"
install -m 600 -o 10000 -g 10000 "$ts" "$SWEEP_OUT"
echo "fluncle-secrets-sync: ok $(date -u +%FT%TZ)"
