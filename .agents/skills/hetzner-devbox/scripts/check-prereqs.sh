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

missing=0

log() {
  printf '==> %s\n' "$*"
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing command: %s\n' "$1" >&2
    missing=1
  fi
}

env_has_key() {
  local key="$1"
  if [[ -n "${!key:-}" ]]; then
    return 0
  fi
  [[ -f "${ENV_FILE}" ]] && grep -Eq "^[[:space:]]*(export[[:space:]]+)?${key}=" "${ENV_FILE}"
}

log "Checking local commands"
need_cmd hcloud
need_cmd jq
need_cmd ssh
need_cmd ssh-add
need_cmd git

log "Checking environment"
if [[ ! -f "${ENV_FILE}" ]]; then
  printf 'no .env found at %s; exported environment values will still be used\n' "${ENV_FILE}" >&2
fi
if ! env_has_key HCLOUD_TOKEN; then
  printf 'missing HCLOUD_TOKEN in environment or %s\n' "${ENV_FILE}" >&2
  missing=1
fi
if ! env_has_key TS_AUTHKEY; then
  printf 'missing TS_AUTHKEY in environment or %s; add a fresh Tailscale auth key before provisioning\n' "${ENV_FILE}" >&2
  missing=1
fi
if ! env_has_key HCLOUD_SSH_KEY_NAME; then
  printf 'missing HCLOUD_SSH_KEY_NAME in environment or %s; required when creating a new server\n' "${ENV_FILE}" >&2
  missing=1
fi

log "Checking SSH agent"
if ! ssh-add -l >/dev/null 2>&1; then
  printf 'no SSH identities available from ssh-agent; add the Hetzner key before provisioning\n' >&2
  missing=1
fi

if [[ "${missing}" -ne 0 ]]; then
  exit 1
fi

log "Prerequisites look ready"

