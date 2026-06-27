#!/usr/bin/env bash
# fluncle-live.sh — the `fluncle-live` `--no-agent` Hermes cron's job ENTRY.
#
# The poller behind Fluncle's cross-surface live-set callout ("Fluncle is on the
# decks right now"). Version-controlled source; the repo is canonical and the box is
# a deploy target (fluncle-hermes-operator skill). This pair deploys to the box's
# scripts dir and the cron is wired there. See ../cron/README.md § The live cron.
#
# WHAT IT DOES: every ~1m it asks Twitch Helix whether `flunclelive` is streaming
# (a client-credentials app token, public read, no app review), then POSTs the raw
# live state to the agent-tier `POST /api/admin/twitch/live` (oRPC
# `record_live_state`). The Worker stores it, owns the off→on / on→off transition
# (the crew Telegram callout), and every surface reads it. Auto-clear is read-side
# (a stale flag is treated offline), so a dead poller can't strand a "LIVE" banner.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts`
# would be fed to Python. This thin wrapper is the bash entry; the poll + JSON work
# lives in the bun orchestrator beside it. Its stdout is the cron's run output.
#
# PUBLIC-SAFE BY CONSTRUCTION (this repo is open source): this script carries NO
# hostnames, tokens, or secrets. The Twitch credentials + the Worker origin are read
# from a 0600 operator-placed file at ${HOME}/.live.env (sourced below, exactly like
# the healthcheck cron sources its env). Required keys:
#
#   LIVE_WORKER_URL      — the Worker origin, e.g. https://www.fluncle.com (the POST
#                          target for the live state: ${LIVE_WORKER_URL}/api/admin/twitch/live).
#   TWITCH_CLIENT_ID     — the Twitch dev-app client id (dev.twitch.tv/console/apps).
#   TWITCH_CLIENT_SECRET — the Twitch dev-app client secret.
#   TWITCH_USER_LOGIN    — OPTIONAL. The channel login to poll. Defaults to flunclelive.
#
# FLUNCLE_API_TOKEN (the agent-scoped token that authorizes the POST) arrives via the
# CRON ENV — an unrecognized custom var passes Hermes' provider-cred blocklist, same
# as the healthcheck + observe sweeps. TWITCH_CLIENT_SECRET resembles a provider cred,
# so Hermes hard-blocks it from the cron env — that is why it lives in the 0600 file.
#
# Operator wires it on the box (image carries bun + curl):
#   hermes cron create "every 1m" --no-agent --script fluncle-live.sh \
#     --deliver local --name fluncle-live
#
# Confirm with `hermes cron list`; per-run output lands in
# ~/.hermes/cron/output/{job_id}/{timestamp}.md.
set -euo pipefail

# The Hermes cron `--no-agent --script` runner execs this with a minimal PATH that
# omits /usr/local/bin (the bun symlink) and /root/.bun/bin, so a bare `bun` is
# "not found" → exit 127. Prepend the known install dirs so this wrapper's `bun` and
# the orchestrator's `curl` spawns resolve regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: the cron runner's exec context loses the PATH export above,
# so pin the ABSOLUTE interpreter path. The orchestrator reads BUN_BIN.
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

# The Twitch credentials + Worker origin are file-sourced (Hermes blocks
# TWITCH_CLIENT_SECRET from the cron env; the rest are kept out of the repo). A 0600
# ${HOME}/.live.env populated by the operator (see the ops runbook note in 1Password).
# FLUNCLE_API_TOKEN is NOT here — it rides the cron env.
LIVE_ENV_FILE="${LIVE_ENV_FILE:-${HOME:-/opt/data/home}/.live.env}"
if [ -r "${LIVE_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${LIVE_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec "${BUN_BIN}" "${SCRIPT_DIR}/fluncle-live.ts" "$@"
