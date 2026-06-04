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
SERVER_IPV4="${SERVER_IPV4:-}"
USERNAME="${USERNAME:-admin}"
TS_HOSTNAME="${TS_HOSTNAME:-${SERVER_NAME}}"
PROFILE="${PROFILE:-private}"

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="${2:-}"
      if [[ -z "${PROFILE}" ]]; then
        printf 'Missing value for --profile\n' >&2
        exit 1
      fi
      shift 2
      ;;
    private | public-ssh | rave)
      PROFILE="$1"
      shift
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 1
      ;;
  esac
done

case "${PROFILE}" in
  private)
    BOOTSTRAP_SCRIPT="${BOOTSTRAP_SCRIPT:-${SCRIPT_DIR}/bootstrap-private-vps.sh}"
    ;;
  public-ssh | rave)
    BOOTSTRAP_SCRIPT="${BOOTSTRAP_SCRIPT:-${SCRIPT_DIR}/bootstrap-rave-vps.sh}"
    ;;
  *)
    printf 'Unknown bootstrap profile: %s. Expected private or public-ssh.\n' "${PROFILE}" >&2
    exit 1
    ;;
esac

if [[ -z "${TS_AUTHKEY:-}" ]]; then
  printf 'TS_AUTHKEY is missing in environment or %s. Add a fresh Tailscale auth key before running bootstrap.\n' "${ENV_FILE}" >&2
  exit 1
fi

if [[ ! -f "${BOOTSTRAP_SCRIPT}" ]]; then
  printf 'bootstrap script not found: %s\n' "${BOOTSTRAP_SCRIPT}" >&2
  exit 1
fi

if [[ -z "${SERVER_IPV4}" ]]; then
  if [[ -z "${HCLOUD_TOKEN:-}" ]]; then
    printf 'SERVER_IPV4 is unset and HCLOUD_TOKEN is unavailable for lookup.\n' >&2
    exit 1
  fi
  export HCLOUD_TOKEN
  SERVER_IPV4="$(hcloud server describe "${SERVER_NAME}" -o json | jq -r '.public_net.ipv4.ip')"
fi

printf 'Streaming %s hardening script to root@%s\n' "${PROFILE}" "${SERVER_IPV4}"
{
  printf 'export USERNAME=%q\n' "${USERNAME}"
  printf 'export TS_AUTHKEY=%q\n' "${TS_AUTHKEY}"
  printf 'export TS_HOSTNAME=%q\n' "${TS_HOSTNAME}"
  cat "${BOOTSTRAP_SCRIPT}"
} | ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 "root@${SERVER_IPV4}" 'bash -s'

printf '\nBootstrap complete. Verify with:\n'
if [[ "${PROFILE}" == "private" ]]; then
  printf '  ssh %s@%s\n' "${USERNAME}" "${TS_HOSTNAME}"
else
  printf '  ssh -p 2222 %s@%s\n' "${USERNAME}" "${TS_HOSTNAME}"
fi
