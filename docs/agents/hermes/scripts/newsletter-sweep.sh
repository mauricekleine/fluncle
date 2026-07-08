#!/usr/bin/env bash
# newsletter-sweep.sh — the `--no-agent` weekly newsletter cron's job ENTRY.
#
# LIVE. Version-controlled source; the repo is canonical and the box is a deploy
# target (fluncle-hermes-operator skill). This pair is BAKED into the image at
# /opt/hermes-scripts/ and auto-updates from main via pin-watch; a rave-02 HOST systemd
# timer docker-execs it — no docker cp. See ../cron/README.md.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`, Python for everything else — so a bare `.ts` would be
# fed to Python. This thin wrapper is the bash entry; all the JSON work lives in the
# bun orchestrator beside it (newsletter-sweep.ts). Its stdout is the one operator line
# (the draft summary + the send command); the .ts also self-POSTs that line to the ops-alert
# Discord webhook, so it no longer depends on the gateway's `--deliver discord` (retired with
# the host-timer migration — see ../newsletter-timer/).
#
# THE HYBRID MODEL (same shape as note/observe — this REPLACED the old agent loop that
# flailed 83 calls / ~$9.61 on a single 2026-06-27 run). Everything is deterministic
# (the window math, the /api/tracks + /api/mixtapes reads, the draft persist) EXCEPT
# ONE `claude -p` authoring call — Claude Code, SUBSCRIPTION auth via
# CLAUDE_CODE_OAUTH_TOKEN, NOT OpenRouter — with READ-ONLY tools so it can load the
# baked `copywriting-fluncle` skill for the voice. One bounded call, not a runaway
# loop; zero OpenRouter tokens.
#
# PRODUCTION PRE-REQS (see ../cron/README.md):
#   - `claude` (Claude Code CLI) + `bun` + the `fluncle` CLI — BAKED into the image.
#   - the `copywriting-fluncle` skill — BAKED at /opt/claude/skills/ (CLAUDE_CONFIG_DIR).
#   - CLAUDE_CODE_OAUTH_TOKEN (+ optional DISCORD_ALERT_WEBHOOK for the auth-failed ping)
#     — the `--no-agent` runner WITHHOLDS recognized provider creds from the script env
#     (GHSA-rhgp-j443-p4rf), so the token is read from the 0600 op-synced shared file at
#     ${HOME}/.fluncle-secrets.env, sourced below.
#
# Scheduled by a repo-checked-in HOST systemd timer (../newsletter-timer/, installed by
# ../install-host-timers.sh), NOT a gateway `hermes cron create` — drafting is AGENT tier (the
# box's agent token drives it; sending stays operator-only). A `--dry-run` arg authors + prints
# without persisting or delivering (manual validation: `bash newsletter-sweep.sh --dry-run`).
set -euo pipefail

# The cron runner execs with a minimal PATH; prepend the known install dirs so this
# wrapper's `bun` AND the orchestrator's `fluncle`/`bun`/`claude`/`curl` spawns resolve.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# The runner WITHHOLDS provider creds (CLAUDE_CODE_OAUTH_TOKEN, DISCORD_*) from
# --no-agent scripts (_HERMES_PROVIDER_ENV_BLOCKLIST), so `claude -p`'s token reaches
# this script only via the 0600 op-synced shared secrets file (mounted ~/.hermes).
NEWSLETTER_ENV_FILE="${NEWSLETTER_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${NEWSLETTER_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${NEWSLETTER_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the
# /status freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) —
# WRAP the payload (never `exec`) so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output newsletter -- "${BUN_BIN}" "${SCRIPT_DIR}/newsletter-sweep.ts" "$@"
