#!/usr/bin/env bash

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
	-h | --help)
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
	command -v "$bin" >/dev/null 2>&1 || {
		echo "error: '$bin' not found on PATH" >&2
		exit 1
	}
done

CF_DNS_ITEM="${FLUNCLE_CF_DNS_OP_ITEM:?set to your 1Password item holding the Cloudflare DNS credentials — see the ops runbook note}"
echo "Reading Cloudflare credentials from 1Password…" >&2
ACCOUNT_ID="$(op read "${CF_DNS_ITEM}/CLOUDFLARE_ACCOUNT_ID")"
API_KEY="$(op read "${CF_DNS_ITEM}/CLOUDFLARE_API_KEY")"

CF_EMAIL="$(op read "${CF_DNS_ITEM}/CLOUDFLARE_EMAIL" 2>/dev/null || true)"

if [[ -z "$API_KEY" ]]; then
	echo "error: missing Cloudflare api key in 1Password" >&2
	exit 1
fi

auth_headers() {
	if [[ -n "$CF_EMAIL" ]]; then
		printf '%s\n' "-H" "X-Auth-Email: $CF_EMAIL" "-H" "X-Auth-Key: $API_KEY"
	else
		printf '%s\n' "-H" "Authorization: Bearer $API_KEY"
	fi
}

cf() {

	local method="$1" path="$2" body="${3:-}"
	local -a hdrs=()
	local line
	while IFS= read -r line; do
		hdrs+=("$line")
	done < <(auth_headers)
	if [[ -n "$body" ]]; then
		curl -fsS -X "$method" "${API}${path}" \
			"${hdrs[@]}" -H "Content-Type: application/json" --data "$body"
	else
		curl -fsS -X "$method" "${API}${path}" "${hdrs[@]}"
	fi
}

if [[ -n "${CLOUDFLARE_ZONE_ID:-}" ]]; then
	ZONE_ID="$CLOUDFLARE_ZONE_ID"
	echo "Using CLOUDFLARE_ZONE_ID override: ${ZONE_ID}" >&2
else
	echo "Resolving zone id for ${ZONE_NAME}…" >&2
	ZONE_ID="$(cf GET "/zones?name=${ZONE_NAME}" | jq -r '.result[0].id // empty')"
	if [[ -z "$ZONE_ID" ]]; then
		echo "error: could not find zone ${ZONE_NAME}. The API token must have" >&2
		echo "       Zone:Read + DNS:Edit on ${ZONE_NAME}, or pass CLOUDFLARE_ZONE_ID." >&2
		exit 1
	fi
	echo "  zone id: ${ZONE_ID}" >&2
fi

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
	existing="$(cf GET "/zones/${ZONE_ID}/dns_records?type=${type}&name=${name}" |
		jq -r '.result[0].id // empty')"

	if [[ -n "$existing" ]]; then
		echo "  updating ${type} ${name} (${existing})…" >&2
		cf PUT "/zones/${ZONE_ID}/dns_records/${existing}" "$payload" >/dev/null
	else
		echo "  creating ${type} ${name}…" >&2
		cf POST "/zones/${ZONE_ID}/dns_records" "$payload" >/dev/null
	fi
	echo "  ok: ${type} ${name} -> ${content}" >&2
}

upsert "A" "$NS_HOST" "$VPS_IP"
upsert "NS" "$DELEGATED_ZONE" "$NS_HOST"

if [[ "$DRY_RUN" -eq 1 ]]; then
	echo "DRY-RUN complete; no records changed." >&2
else
	echo "Delegation in place. Verify once DNS propagates:" >&2
	echo "  dig NS ${DELEGATED_ZONE} +short" >&2
	echo "  dig @${NS_HOST} random.${DELEGATED_ZONE} TXT +short" >&2
fi
