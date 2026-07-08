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

# GSC service-account key → a standalone 0600 json file (its json can't be a clean shell env
# var, so it rides alongside the env file rather than inside it). The nightly audit's
# surfaces-seo day points GOOGLE_APPLICATION_CREDENTIALS here. The concrete op:// ref lives in
# the host bootstrap (FLUNCLE_GSC_OP_REF) — never in this public repo. Unset ⇒ skipped cleanly
# (the audit degrades to structural SEO checks, never invents metrics).
if [ -n "${FLUNCLE_GSC_OP_REF:-}" ]; then
  GSC_OUT=/home/admin/.hermes/home/.fluncle-gsc.json   # = /opt/data/home/.fluncle-gsc.json in-container
  tj="$(mktemp)"; trap 'rm -f "$tg" "$ts" "$tj"' EXIT
  if op read "$FLUNCLE_GSC_OP_REF" >"$tj" 2>/dev/null && grep -q '"private_key"' "$tj"; then
    install -m 600 -o 10000 -g 10000 "$tj" "$GSC_OUT"
  else
    echo "fluncle-secrets-sync: GSC key sync failed (audit surfaces-seo will degrade)" >&2
  fi
fi
echo "fluncle-secrets-sync: ok $(date -u +%FT%TZ)"
