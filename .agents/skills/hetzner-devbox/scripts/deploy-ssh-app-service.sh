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

SERVER_NAME="${SERVER_NAME:-fluncle-rave-01}"
USERNAME="${USERNAME:-admin}"
ADMIN_SSH_PORT="${ADMIN_SSH_PORT:-2222}"
BINARY_PATH="${BINARY_PATH:-}"
REMOTE_TMP="/tmp/fluncle-ssh.$$"
FLUNCLE_API_URL="${FLUNCLE_API_URL:-https://www.fluncle.com}"
FLUNCLE_SSH_HOST="${FLUNCLE_SSH_HOST:-0.0.0.0}"
FLUNCLE_SSH_PORT="${FLUNCLE_SSH_PORT:-22}"
FLUNCLE_SSH_DATA_DIR="${FLUNCLE_SSH_DATA_DIR:-/var/lib/fluncle-ssh}"
FLUNCLE_GEOIP_DB="${FLUNCLE_GEOIP_DB:-}"

if [[ -z "${BINARY_PATH}" ]]; then
  printf 'BINARY_PATH is required, for example ./apps/ssh-rave/dist/fluncle-ssh\n' >&2
  exit 1
fi

if [[ ! -f "${BINARY_PATH}" ]]; then
  printf 'BINARY_PATH does not exist: %s\n' "${BINARY_PATH}" >&2
  exit 1
fi

printf 'Uploading %s to %s@%s:%s\n' "${BINARY_PATH}" "${USERNAME}" "${SERVER_NAME}" "${REMOTE_TMP}"
scp -P "${ADMIN_SSH_PORT}" "${BINARY_PATH}" "${USERNAME}@${SERVER_NAME}:${REMOTE_TMP}"

remote_env=$(printf 'REMOTE_TMP=%q FLUNCLE_API_URL=%q FLUNCLE_SSH_HOST=%q FLUNCLE_SSH_PORT=%q FLUNCLE_SSH_DATA_DIR=%q FLUNCLE_GEOIP_DB=%q' \
  "${REMOTE_TMP}" \
  "${FLUNCLE_API_URL}" \
  "${FLUNCLE_SSH_HOST}" \
  "${FLUNCLE_SSH_PORT}" \
  "${FLUNCLE_SSH_DATA_DIR}" \
  "${FLUNCLE_GEOIP_DB}")

ssh -p "${ADMIN_SSH_PORT}" -o BatchMode=yes -o ConnectTimeout=30 "${USERNAME}@${SERVER_NAME}" "${remote_env} bash -s" <<'REMOTE'
set -Eeuo pipefail

APP_USER="fluncle-ssh"
APP_GROUP="fluncle-ssh"
APP_DIR="/opt/fluncle-ssh"
APP_BIN="${APP_DIR}/fluncle-ssh"
ENV_FILE="/etc/fluncle-ssh.env"
SERVICE_FILE="/etc/systemd/system/fluncle-ssh.service"

sudo install -d -m 0755 -o root -g root "${APP_DIR}"
sudo install -m 0755 -o root -g root "${REMOTE_TMP}" "${APP_BIN}"
rm -f "${REMOTE_TMP}"

sudo install -d -m 0750 -o "${APP_USER}" -g "${APP_GROUP}" "${FLUNCLE_SSH_DATA_DIR}"

tmp_env="$(mktemp)"
cat >"${tmp_env}" <<ENV
FLUNCLE_API_URL=${FLUNCLE_API_URL}
FLUNCLE_SSH_HOST=${FLUNCLE_SSH_HOST}
FLUNCLE_SSH_PORT=${FLUNCLE_SSH_PORT}
FLUNCLE_SSH_DATA_DIR=${FLUNCLE_SSH_DATA_DIR}
FLUNCLE_GEOIP_DB=${FLUNCLE_GEOIP_DB}
ENV
sudo install -m 0640 -o root -g "${APP_GROUP}" "${tmp_env}" "${ENV_FILE}"
rm -f "${tmp_env}"

tmp_service="$(mktemp)"
cat >"${tmp_service}" <<SERVICE
[Unit]
Description=Fluncle SSH Rave Terminal
After=network-online.target
Wants=network-online.target

[Service]
User=${APP_USER}
Group=${APP_GROUP}
ExecStart=${APP_BIN}
Restart=always
RestartSec=3
EnvironmentFile=${ENV_FILE}
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${FLUNCLE_SSH_DATA_DIR}

[Install]
WantedBy=multi-user.target
SERVICE
sudo install -m 0644 -o root -g root "${tmp_service}" "${SERVICE_FILE}"
rm -f "${tmp_service}"

sudo systemctl daemon-reload
sudo systemctl enable fluncle-ssh
sudo systemctl restart fluncle-ssh
sudo systemctl status --no-pager fluncle-ssh
REMOTE
