#!/usr/bin/env bash
#
# delegate.sh — create the Cloudflare DNS records that delegate the
# `dig.fluncle.com` zone to the fluncle-dns server running on the rave VPS.
#
# It creates two records in the `fluncle.com` zone:
#   1. dig.fluncle.com   NS  ns1.dig.fluncle.com   (the delegation)
#   2. ns1.dig.fluncle.com  A  <VPS_IP>            (the in-bailiwick glue)
#
# Both are unproxied (grey cloud): DNS delegation and glue must point at the
# real nameserver IP, not a Cloudflare proxy.
#
# This is an OPERATOR script. It performs a live, production DNS change. Run it
# yourself, with eyes open. It is idempotent: re-running updates the records in
# place instead of duplicating them.
#
# Usage:
#   apps/dns/scripts/delegate.sh <VPS_IP>          # apply
#   apps/dns/scripts/delegate.sh --dry-run <VPS_IP> # print what it would do
#
# Credentials are read from 1Password at call time (nothing is stored):
#   op://Fluncle/Cloudflare DNS/CLOUDFLARE_ACCOUNT_ID
#   op://Fluncle/Cloudflare DNS/CLOUDFLARE_API_KEY
# If the secret is a Global API Key (not a scoped API Token), also expose the
# account email so the legacy auth headers can be used:
#   op://Fluncle/Cloudflare DNS/CLOUDFLARE_EMAIL   (optional)

set -euo pipefail

ZONE_NAME="fluncle.com"
DELEGATED_ZONE="dig.fluncle.com"
NS_HOST="ns1.dig.fluncle.com"
TTL=300
API="https://api.cloudflare.com/client/v4"

DRY_RUN=0
VPS_IP=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    -*)
      echo "unknown flag: $arg" >&2
      exit 2
      ;;
    *) VPS_IP="$arg" ;;
  esac
done

if [[ -z "$VPS_IP" ]]; then
  echo "usage: $0 [--dry-run] <VPS_IP>" >&2
  exit 2
fi

if ! [[ "$VPS_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "error: <VPS_IP> must be an IPv4 address, got: $VPS_IP" >&2
  exit 2
fi

for bin in op curl jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "error: '$bin' not found on PATH" >&2; exit 1; }
done

echo "Reading Cloudflare credentials from 1Password…" >&2
ACCOUNT_ID="$(op read 'op://Fluncle/Cloudflare DNS/CLOUDFLARE_ACCOUNT_ID')"
API_KEY="$(op read 'op://Fluncle/Cloudflare DNS/CLOUDFLARE_API_KEY')"
# Optional: only present when the secret is a Global API Key.
CF_EMAIL="$(op read 'op://Fluncle/Cloudflare DNS/CLOUDFLARE_EMAIL' 2>/dev/null || true)"

if [[ -z "$ACCOUNT_ID" || -z "$API_KEY" ]]; then
  echo "error: missing Cloudflare account id or api key in 1Password" >&2
  exit 1
fi

# Pick the auth scheme. A scoped API Token uses Bearer; a Global API Key needs
# the account email and the legacy X-Auth-* headers.
auth_headers() {
  if [[ -n "$CF_EMAIL" ]]; then
    printf '%s\n' "-H" "X-Auth-Email: $CF_EMAIL" "-H" "X-Auth-Key: $API_KEY"
  else
    printf '%s\n' "-H" "Authorization: Bearer $API_KEY"
  fi
}

cf() {
  # cf METHOD PATH [JSON_BODY]
  local method="$1" path="$2" body="${3:-}"
  local -a hdrs
  mapfile -t hdrs < <(auth_headers)
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "${API}${path}" \
      "${hdrs[@]}" -H "Content-Type: application/json" --data "$body"
  else
    curl -fsS -X "$method" "${API}${path}" "${hdrs[@]}"
  fi
}

echo "Resolving zone id for ${ZONE_NAME}…" >&2
ZONE_ID="$(cf GET "/zones?name=${ZONE_NAME}&account.id=${ACCOUNT_ID}" \
  | jq -r '.result[0].id // empty')"
if [[ -z "$ZONE_ID" ]]; then
  echo "error: could not find zone ${ZONE_NAME} (check creds + account)" >&2
  exit 1
fi
echo "  zone id: ${ZONE_ID}" >&2

# upsert TYPE NAME CONTENT — create the record, or update it if it already
# exists (matched on name+type), so the script is safe to re-run.
upsert() {
  local type="$1" name="$2" content="$3"
  local payload
  payload="$(jq -n --arg type "$type" --arg name "$name" \
    --arg content "$content" --argjson ttl "$TTL" \
    '{type:$type, name:$name, content:$content, ttl:$ttl, proxied:false,
      comment:"fluncle-dns delegation (apps/dns/scripts/delegate.sh)"}')"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "DRY-RUN would upsert: ${type} ${name} -> ${content}" >&2
    echo "$payload" | jq . >&2
    return
  fi

  local existing
  existing="$(cf GET "/zones/${ZONE_ID}/dns_records?type=${type}&name=${name}" \
    | jq -r '.result[0].id // empty')"

  if [[ -n "$existing" ]]; then
    echo "  updating ${type} ${name} (${existing})…" >&2
    cf PUT "/zones/${ZONE_ID}/dns_records/${existing}" "$payload" >/dev/null
  else
    echo "  creating ${type} ${name}…" >&2
    cf POST "/zones/${ZONE_ID}/dns_records" "$payload" >/dev/null
  fi
  echo "  ok: ${type} ${name} -> ${content}" >&2
}

# Glue first (the A record the NS delegation points at), then the delegation.
upsert "A"  "$NS_HOST"        "$VPS_IP"
upsert "NS" "$DELEGATED_ZONE" "$NS_HOST"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY-RUN complete; no records changed." >&2
else
  echo "Delegation in place. Verify once DNS propagates:" >&2
  echo "  dig NS ${DELEGATED_ZONE} +short" >&2
  echo "  dig @${NS_HOST} random.${DELEGATED_ZONE} TXT +short" >&2
fi
