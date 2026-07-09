#!/usr/bin/env bash
# triage-sweep.sh — the `--no-agent` submission-triage cron's job ENTRY.
#
# Version-controlled source; the repo is canonical and the box is a deploy target
# (fluncle-hermes-operator skill). This pair is BAKED into the image at
# /opt/hermes-scripts/ and auto-updates from main via pin-watch; a rave-02 HOST systemd
# timer docker-execs it — no docker cp. See ../triage-timer/README.md.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python otherwise — so a bare `.ts` would be fed to
# Python. This thin wrapper is the bash entry; all the JSON work lives in the bun
# orchestrator beside it. Its stdout is the cron's run output.
#
# THE HYBRID MODEL (same shape as note-sweep): NOT a pure trigger — it has ONE agentic
# step in the middle. The queue read, the archive dedupe, and the verdict delivery are
# all DETERMINISTIC (the `fluncle` CLI). Only the verdict PHRASING runs `claude -p`
# (Claude Code, SUBSCRIPTION auth via CLAUDE_CODE_OAUTH_TOKEN, NOT OpenRouter) with
# READ-ONLY tools. The SCRIPT posts the authored verdict to the triage endpoint; the
# Worker length-gates it (advisory only, no public voice gate) + stores it onto the
# PENDING submission. Approve/reject authority never moves — the sweep only pre-chews.
#
# PRODUCTION PRE-REQS (see ../triage-timer/README.md):
#   - `claude` (Claude Code CLI) — BAKED into the image; authed via subscription
#     CLAUDE_CODE_OAUTH_TOKEN. The `--no-agent` runner does NOT pass provider secrets
#     to this script, so the token is read from the SHARED 0600 operator-placed file at
#     ${HOME}/.fluncle-secrets.env (mounted ~/.hermes) — the SAME file note-sweep sources.
#     No new secret is introduced.
#   - the `copywriting-fluncle` skill — BAKED at /opt/claude/skills/ (via
#     CLAUDE_CONFIG_DIR=/opt/claude), readable by the non-root cron user.
#   - optional DISCORD_ALERT_WEBHOOK / TRIAGE_CLAUDE_MODEL / TRIAGE_CLAUDE_EFFORT in the
#     same file.
#
# Scheduled by a repo-checked-in HOST systemd timer (../triage-timer/, installed by
# ../install-host-timers.sh), NOT a gateway `hermes cron create`. `triage_submission` is
# AGENT tier, so the box's existing agent-scoped token drives it — no operator token.
# Per-run output is a freshness marker the sweep self-writes via cron-output.sh under
# ~/.hermes/cron/output/fluncle-triage/ (read by the /status prober once its CRON_SPEC is
# added at activation — see the timer README). See ../cron/README.md.
set -euo pipefail

# The cron runner execs this with a minimal PATH; prepend the known install dirs so the
# wrapper's `bun` AND the orchestrator's `fluncle`/`bun`/`claude` spawns resolve.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Pin ABSOLUTE paths for the interpreter + the CLI (the orchestrator reads BUN_BIN /
# FLUNCLE_BIN, so its spawns resolve with zero PATH dependence).
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# The cron runner WITHHOLDS provider credentials (CLAUDE_CODE_OAUTH_TOKEN, DISCORD_*)
# from --no-agent scripts (a HARD security blocklist). So `claude -p`'s token can ONLY
# reach this script via the operator-placed file — sourced here: the SHARED 0600
# ${HOME}/.fluncle-secrets.env (mounted ~/.hermes) note-sweep already relies on.
TRIAGE_ENV_FILE="${TRIAGE_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${TRIAGE_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${TRIAGE_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the gateway runner's stdout capture, so self-report the /status
# freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) — WRAP the
# payload (never `exec`) so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output triage -- "${BUN_BIN}" "${SCRIPT_DIR}/triage-sweep.ts" "$@"
