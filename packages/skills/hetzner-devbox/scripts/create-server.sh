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
SERVER_TYPE="${SERVER_TYPE:-cpx32}"
LOCATION="${LOCATION:-nbg1}"
IMAGE="${IMAGE:-ubuntu-24.04}"
SERVER_PURPOSE="${SERVER_PURPOSE:-devbox}"

if [[ -z "${HCLOUD_TOKEN:-}" ]]; then
  printf 'HCLOUD_TOKEN is missing in environment or %s\n' "${ENV_FILE}" >&2
  exit 1
fi
export HCLOUD_TOKEN

if hcloud server describe "${SERVER_NAME}" >/dev/null 2>&1; then
  printf 'Server already exists: %s\n' "${SERVER_NAME}"
else
  if [[ -z "${HCLOUD_SSH_KEY_NAME:-}" ]]; then
    printf 'HCLOUD_SSH_KEY_NAME is required when creating a new server.\n' >&2
    exit 1
  fi
  hcloud server create \
    --name "${SERVER_NAME}" \
    --type "${SERVER_TYPE}" \
    --image "${IMAGE}" \
    --location "${LOCATION}" \
    --ssh-key "${HCLOUD_SSH_KEY_NAME}" \
    --label managed-by=agent-skill \
    --label "purpose=${SERVER_PURPOSE}"
fi

printf '\nServer details:\n'
hcloud server describe "${SERVER_NAME}"
