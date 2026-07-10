#!/usr/bin/env bash
# logbook-sweep.sh — the `--no-agent` Logbook cron's job ENTRY (`fluncle-logbook`).
#
# Version-controlled source; the repo is canonical and the box is a deploy target
# (fluncle-hermes-operator skill). This pair is BAKED into the image at
# /opt/hermes-scripts/ and auto-updates from main via pin-watch; a rave-02 HOST systemd
# timer docker-execs it once a day — no docker cp. See ../logbook-timer/README.md. Box
# activation is OPERATOR-GATED (a new cron; nothing to retire).
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`, so this thin wrapper is the bash entry; all the JSON work
# lives in the bun orchestrator beside it. Its stdout is the cron's run output.
#
# THE HYBRID MODEL (same shape as note-sweep): NOT a pure trigger — one `claude -p`
# authoring call per day sits in the middle. The gap read (the self-healing window +
# the day's material) and the entry delivery are DETERMINISTIC (the `fluncle` CLI).
# Only the creative authoring — turning a day's findings into a first-person logbook
# entry in Fluncle's voice — runs `claude -p` (Claude Code, SUBSCRIPTION auth via
# CLAUDE_CODE_OAUTH_TOKEN, NOT OpenRouter) with READ-ONLY tools. The SCRIPT posts the
# authored entry to the fill-empty-only endpoint; the Worker voice-gates + stores.
#
# PRODUCTION PRE-REQS (see ../logbook-timer/README.md):
#   - `claude` (Claude Code CLI) — BAKED into the image; authed via subscription
#     CLAUDE_CODE_OAUTH_TOKEN. The `--no-agent` runner does NOT pass provider secrets,
#     so the token is read from a 0600 operator-placed file at
#     ${HOME}/.fluncle-secrets.env (mounted ~/.hermes), sourced below.
#   - the `copywriting-fluncle` skill — BAKED into the image at /opt/claude/skills/
#     (discovered via CLAUDE_CONFIG_DIR=/opt/claude, readable by the cron user).
#   - optional DISCORD_ALERT_WEBHOOK / LOGBOOK_CLAUDE_MODEL / LOGBOOK_CLAUDE_EFFORT in
#     the same file.
#
# Scheduled by a repo-checked-in HOST systemd timer (../logbook-timer/, installed by
# ../install-host-timers.sh). `create_logbook_entry` is AGENT tier, so the box's
# existing agent-scoped token drives it — no operator token needed. Per-run output is a
# freshness marker the sweep self-writes via cron-output.sh under
# ~/.hermes/cron/output/fluncle-logbook/ (read by the /status prober).
set -euo pipefail

# The Hermes runner execs this with a minimal PATH; prepend the known install dirs so
# this wrapper's `bun` AND the orchestrator's `fluncle`/`bun`/`claude` spawns resolve.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: pin ABSOLUTE paths for the interpreter + the CLI so the spawns
# resolve with zero PATH dependence.
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# The runner WITHHOLDS provider credentials (CLAUDE_CODE_OAUTH_TOKEN, etc.) from
# --no-agent scripts (the _HERMES_PROVIDER_ENV_BLOCKLIST hard blocklist), so `claude -p`'s
# token can ONLY reach this script via a file the operator places — sourced here: a 0600
# ${HOME}/.fluncle-secrets.env holding CLAUDE_CODE_OAUTH_TOKEN (required) + optionally
# DISCORD_ALERT_WEBHOOK / LOGBOOK_CLAUDE_MODEL / LOGBOOK_CLAUDE_EFFORT. Written from the
# configured 1Password item (see the ops runbook note).
LOGBOOK_ENV_FILE="${LOGBOOK_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${LOGBOOK_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${LOGBOOK_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the gateway runner's stdout capture, so self-report the /status
# freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) — WRAP the
# payload (never `exec`) so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output logbook -- "${BUN_BIN}" "${SCRIPT_DIR}/logbook-sweep.ts" "$@"
