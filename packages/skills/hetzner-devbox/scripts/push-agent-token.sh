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
REMOTE_ENV_FILE="${REMOTE_ENV_FILE:-/etc/fluncle/rave-watchdog.env}"
TOKEN_KEY="${TOKEN_KEY:-FLUNCLE_API_TOKEN}"
WORKER_URL="${WORKER_URL:-https://www.fluncle.com}"

VERIFY=1
[[ "${1:-}" == "--no-verify" ]] && VERIFY=0

die() {
	printf 'push-agent-token: %s\n' "$*" >&2
	exit 1
}

command -v op >/dev/null 2>&1 || die "op (1Password CLI) not on PATH — run this from the Mac or rave-02, never rave-01"
[[ -n "${OP_AGENT_TOKEN_REF:-}" ]] || die "OP_AGENT_TOKEN_REF is required (the op:// ref to the agent token; see the ops note)"

SSH=(ssh -p "${ADMIN_SSH_PORT}" -o BatchMode=yes -o ConnectTimeout=30 "${USERNAME}@${SERVER_NAME}")

# shellcheck disable=SC2016  # $1/$2/$newtok must expand on the BOX, not locally — single quotes are intentional.
REMOTE_WRITER='set -uo pipefail
env_file="$1"; key="$2"
newtok="$(cat)"
[ -n "$newtok" ] || { echo "empty token on stdin — aborting, ${env_file} untouched" >&2; exit 1; }
[ -f "$env_file" ] || { echo "no ${env_file} on the box — bootstrap it first (watchdog README)" >&2; exit 1; }
tmp="$(mktemp)"
grep -v "^${key}=" "$env_file" > "$tmp" || true
printf "%s=%s\n" "$key" "$newtok" >> "$tmp"
install -m 0600 -o root -g root "$tmp" "$env_file"
rm -f "$tmp"
echo "refreshed ${key} in ${env_file} (value not shown)"'

printf 'push-agent-token: reading %s and pushing to %s@%s:%s …\n' \
	"${OP_AGENT_TOKEN_REF}" "${USERNAME}" "${SERVER_NAME}" "${REMOTE_ENV_FILE}" >&2

WRITER_PATH="/tmp/.push-agent-token-writer.$$.sh"
printf '%s' "${REMOTE_WRITER}" | "${SSH[@]}" "cat > ${WRITER_PATH} && chmod 700 ${WRITER_PATH}" ||
	die "could not stage the box-side writer over ssh"
cleanup() { "${SSH[@]}" "rm -f ${WRITER_PATH}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

op read "${OP_AGENT_TOKEN_REF}" |
	"${SSH[@]}" "sudo bash ${WRITER_PATH} '${REMOTE_ENV_FILE}' '${TOKEN_KEY}'" ||
	die "the push failed (op read or the box-side write) — token NOT refreshed"

if [[ "${VERIFY}" -eq 1 ]]; then
	printf 'push-agent-token: restarting the watchdog + self-deploy so both re-post with the fresh token …\n' >&2
	"${SSH[@]}" 'sudo systemctl start fluncle-rave-watchdog.service 2>/dev/null || true; sudo systemctl start fluncle-ssh-freshen.service 2>/dev/null || true' || true
	sleep 6
	printf 'push-agent-token: /status rows (expect ok, freshly posted):\n' >&2
	status_json="$(curl -fsS "${WORKER_URL%/}/api/v1/status?cb=$(date +%s)" 2>/dev/null || true)"
	for svc in onion self-deploy-ssh; do

		st="$(printf '%s' "${status_json}" |
			grep -oE "\"service\":\"${svc}\"[^}]*\"status\":\"[a-z]+\"" |
			grep -oE '"status":"[a-z]+"' | tail -1 | cut -d'"' -f4)"
		printf '  %-16s %s\n' "${svc}" "${st:-<not found>}" >&2
	done
fi

printf 'push-agent-token: done — %s refreshed on %s (value never printed).\n' "${TOKEN_KEY}" "${SERVER_NAME}" >&2
