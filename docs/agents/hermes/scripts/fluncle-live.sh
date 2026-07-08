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
# hostnames, tokens, or secrets. The Twitch credentials are read from the SHARED,
# op-injected ${HOME}/.fluncle-secrets.env (sourced below, exactly like the other
# sweeps — note/observe/newsletter/render). That file is rendered from the box's
# 1Password secrets vault by the host `fluncle-secrets-sync` timer
# (docs/agents/hermes/secrets/), so a credential is added by editing 1Password + the
# inject template, never by hand-placing a per-sweep file. Keys it must carry:
#
#   TWITCH_CLIENT_ID     — the Twitch dev-app client id (dev.twitch.tv/console/apps).
#   TWITCH_CLIENT_SECRET — the Twitch dev-app client secret.
#
# Optional, both with safe defaults in the orchestrator (set only to override):
#   LIVE_WORKER_URL   — the Worker origin. Defaults to https://www.fluncle.com.
#   TWITCH_USER_LOGIN — the channel login to poll. Defaults to flunclelive.
#
# FLUNCLE_API_TOKEN (the agent-scoped token that authorizes the POST) arrives via the
# CRON ENV — an unrecognized custom var passes Hermes' provider-cred blocklist, same
# as the other sweeps. TWITCH_CLIENT_SECRET resembles a provider cred, so Hermes
# hard-blocks it from the cron env — that is why it rides the op-injected file.
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

# The Twitch credentials ride the SHARED op-injected secrets file (Hermes blocks
# TWITCH_CLIENT_SECRET from the cron env). Rendered from the box's 1Password secrets
# vault by the host fluncle-secrets-sync timer (docs/agents/hermes/secrets/); the same
# file every other sweep sources. FLUNCLE_API_TOKEN is NOT here — it rides the cron env.
LIVE_ENV_FILE="${LIVE_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${LIVE_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${LIVE_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the
# /status freshness marker (see cron-output.sh) — WRAP the payload (never `exec`) so the
# marker is written even on a nonzero run. (fluncle-live is not yet in the prober's
# AUTOMATION_CRONS, so this marker is written for future prober support — harmless today.)
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output live -- "${BUN_BIN}" "${SCRIPT_DIR}/fluncle-live.ts" "$@"
