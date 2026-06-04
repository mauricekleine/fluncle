#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
if [[ -z "${ENV_FILE:-}" ]]; then
  if [[ -f "${SKILL_DIR}/.env" ]]; then
    ENV_FILE="${SKILL_DIR}/.env"
  elif [[ -f ".env" ]]; then
    ENV_FILE=".env"
  else
    ENV_FILE="${SKILL_DIR}/.env"
  fi
fi

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

SERVER_NAME="${SERVER_NAME:-agent-devbox-01}"
FIREWALL_PROFILE="${FIREWALL_PROFILE:-private}"

case "${FIREWALL_PROFILE}" in
  private)
    FIREWALL_NAME="${FIREWALL_NAME:-agent-devbox-private}"
    ;;
  public-ssh | rave)
    FIREWALL_NAME="${FIREWALL_NAME:-fluncle-rave-public}"
    ;;
  *)
    printf 'Unknown firewall profile: %s. Expected private or public-ssh.\n' "${FIREWALL_PROFILE}" >&2
    exit 1
    ;;
esac

if [[ -z "${HCLOUD_TOKEN:-}" ]]; then
  printf 'HCLOUD_TOKEN is missing in environment or %s\n' "${ENV_FILE}" >&2
  exit 1
fi
export HCLOUD_TOKEN

if ! hcloud firewall describe "${FIREWALL_NAME}" >/dev/null 2>&1; then
  hcloud firewall create \
    --name "${FIREWALL_NAME}" \
    --label managed-by=agent-skill \
    --label "purpose=${FIREWALL_PROFILE}"
fi

rules_json="$(hcloud firewall describe "${FIREWALL_NAME}" -o json)"

has_rule() {
  local protocol="$1"
  local port="${2:-}"
  jq -e --arg protocol "${protocol}" --arg port "${port}" '
    .rules[]
    | select(.direction == "in" and .protocol == $protocol)
    | select(($port == "") or (.port == $port))
    | select((.source_ips | index("0.0.0.0/0")) and (.source_ips | index("::/0")))
  ' <<<"${rules_json}" >/dev/null
}

if ! has_rule icmp; then
  hcloud firewall add-rule \
    --direction in \
    --protocol icmp \
    --source-ips 0.0.0.0/0 \
    --source-ips ::/0 \
    --description "Allow inbound ICMP diagnostics" \
    "${FIREWALL_NAME}"
fi

rules_json="$(hcloud firewall describe "${FIREWALL_NAME}" -o json)"
if ! has_rule udp 41641; then
  hcloud firewall add-rule \
    --direction in \
    --protocol udp \
    --port 41641 \
    --source-ips 0.0.0.0/0 \
    --source-ips ::/0 \
    --description "Allow Tailscale WireGuard direct connections" \
    "${FIREWALL_NAME}"
fi

rules_json="$(hcloud firewall describe "${FIREWALL_NAME}" -o json)"
if [[ "${FIREWALL_PROFILE}" != "private" ]] && ! has_rule tcp 22; then
  hcloud firewall add-rule \
    --direction in \
    --protocol tcp \
    --port 22 \
    --source-ips 0.0.0.0/0 \
    --source-ips ::/0 \
    --description "Allow public SSH app on TCP 22" \
    "${FIREWALL_NAME}"
fi

hcloud firewall apply-to-resource \
  --type server \
  --server "${SERVER_NAME}" \
  "${FIREWALL_NAME}" || true

hcloud firewall describe "${FIREWALL_NAME}"
