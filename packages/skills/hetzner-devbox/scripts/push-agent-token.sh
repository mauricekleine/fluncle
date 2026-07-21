#!/usr/bin/env bash
# push-agent-token.sh — refresh rave-01's agent token WITHOUT putting `op` on the
# public edge.
#
# rave-01 is the PUBLIC-access box, so it deliberately holds NO `op` / 1Password
# service account — a credential there would put the keys to the vault on the most
# exposed surface (a conscious decision; see AGENTS.md "Which machine am I on" and the
# ssh-self-deploy design). The cost of that choice: rave-01's agent token is placed by
# hand, so an agent-token rotation does NOT auto-reach it and drifts silently (a stale
# token 401s every `record_health` post — the watchdog's `onion` row AND the
# `self-deploy-ssh` row go stale on /status).
#
# This closes that gap the right way: PUSH, never pull. It reads the agent-scoped token
# from 1Password ON THIS TRUSTED MACHINE (the Mac or rave-02 — wherever `op` is), and
# pipes it over SSH into rave-01's env file IN PLACE. The value travels
# op -> pipe -> box file: never printed, never on a command line, never in a log. Run it
# as the LAST step of an agent-token rotation.
#
# CONFIG — from the environment or ${SKILL_DIR}/.env (like deploy-ssh-app-service.sh).
# NOTHING secret or topological is committed in this file:
#   OP_AGENT_TOKEN_REF   (required)  op:// ref to the agent token's credential field,
#                                    e.g. op://<vault>/FLUNCLE_AGENT_TOKEN/credential.
#                                    The concrete ref lives in the private ops note.
#   SERVER_NAME          fluncle-rave-01     the box (Tailscale name / ssh host)
#   USERNAME             admin               the admin ssh user
#   ADMIN_SSH_PORT       2222                the admin ssh port
#   REMOTE_ENV_FILE      /etc/fluncle/rave-watchdog.env   the file to patch
#   TOKEN_KEY            FLUNCLE_API_TOKEN   the key in it holding the agent token
#                                            (ssh-freshen.env symlinks to this file, so
#                                            one refresh heals both the watchdog + the
#                                            self-deploy /status posts)
#
# USAGE
#   OP_AGENT_TOKEN_REF='op://<vault>/FLUNCLE_AGENT_TOKEN/credential' \
#     packages/skills/hetzner-devbox/scripts/push-agent-token.sh
#   ... --no-verify   # skip the post-push service restart + /status check
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

die() { printf 'push-agent-token: %s\n' "$*" >&2; exit 1; }

command -v op >/dev/null 2>&1 || die "op (1Password CLI) not on PATH — run this from the Mac or rave-02, never rave-01"
[[ -n "${OP_AGENT_TOKEN_REF:-}" ]] || die "OP_AGENT_TOKEN_REF is required (the op:// ref to the agent token; see the ops note)"

SSH=(ssh -p "${ADMIN_SSH_PORT}" -o BatchMode=yes -o ConnectTimeout=30 "${USERNAME}@${SERVER_NAME}")

# The box-side writer: reads the NEW token from stdin (arg1=env file, arg2=key) and
# swaps the `KEY=` line in place, preserving every other line + 0600 root:root perms.
# No secret is embedded — the value only ever arrives on stdin. Shipped fresh each run
# and removed after, so it never lingers on the box.
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

# Ship the writer (no secret), then pipe the token straight into it (value never printed),
# then remove it. Three cheap steps; keeps the box stateless between rotations.
WRITER_PATH="/tmp/.push-agent-token-writer.$$.sh"
printf '%s' "${REMOTE_WRITER}" | "${SSH[@]}" "cat > ${WRITER_PATH} && chmod 700 ${WRITER_PATH}" \
  || die "could not stage the box-side writer over ssh"
cleanup() { "${SSH[@]}" "rm -f ${WRITER_PATH}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

op read "${OP_AGENT_TOKEN_REF}" \
  | "${SSH[@]}" "sudo bash ${WRITER_PATH} '${REMOTE_ENV_FILE}' '${TOKEN_KEY}'" \
  || die "the push failed (op read or the box-side write) — token NOT refreshed"

if [[ "${VERIFY}" -eq 1 ]]; then
  printf 'push-agent-token: restarting the watchdog + self-deploy so both re-post with the fresh token …\n' >&2
  "${SSH[@]}" 'sudo systemctl start fluncle-rave-watchdog.service 2>/dev/null || true; sudo systemctl start fluncle-ssh-freshen.service 2>/dev/null || true' || true
  sleep 6
  printf 'push-agent-token: /status rows (expect ok, freshly posted):\n' >&2
  status_json="$(curl -fsS "${WORKER_URL%/}/api/v1/status?cb=$(date +%s)" 2>/dev/null || true)"
  for svc in onion self-deploy-ssh; do
    # service and status are not adjacent in the JSON (alphabetical keys put `since`
    # between them), so match within the object: service…status, no `}` crossed.
    st="$(printf '%s' "${status_json}" \
      | grep -oE "\"service\":\"${svc}\"[^}]*\"status\":\"[a-z]+\"" \
      | grep -oE '"status":"[a-z]+"' | tail -1 | cut -d'"' -f4)"
    printf '  %-16s %s\n' "${svc}" "${st:-<not found>}" >&2
  done
fi

printf 'push-agent-token: done — %s refreshed on %s (value never printed).\n' "${TOKEN_KEY}" "${SERVER_NAME}" >&2
