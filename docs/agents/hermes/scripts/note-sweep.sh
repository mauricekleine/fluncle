#!/usr/bin/env bash
# note-sweep.sh — the `--no-agent` auto-note cron's job ENTRY.
#
# LIVE. Version-controlled source; the repo is canonical and the box is a
# deploy target (fluncle-hermes-operator skill). This pair deploys to
# ~/.hermes/scripts/ on the devbox and the cron is wired there. See ../cron/README.md.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts`
# would be fed to Python. This thin wrapper is the bash entry; all the JSON work
# lives in the bun orchestrator beside it. Its stdout is the cron's run output.
#
# THE HYBRID MODEL (same shape as observe-sweep): this is NOT a pure trigger like
# enrich/context/backfill — it has ONE agentic step in the middle. The queue read,
# the per-finding metadata + context-note gather, and the note delivery are all
# DETERMINISTIC (the `fluncle` CLI). Only the creative authoring — turning a
# finding's facts into a one-line editorial note in Fluncle's voice — runs `claude -p`
# (Claude Code, SUBSCRIPTION auth via CLAUDE_CODE_OAUTH_TOKEN, NOT OpenRouter) with
# READ-ONLY tools. The SCRIPT posts the authored note to the note endpoint; the Worker
# re-scans (the voice gate) + FILLS AN EMPTY NOTE ONLY (an operator note is never
# clobbered) + stores. This is the written-note sibling of the observation cron.
#
# PRODUCTION PRE-REQS (see ../cron/README.md):
#   - `claude` (Claude Code CLI) — BAKED into the image; authed via subscription
#     CLAUDE_CODE_OAUTH_TOKEN (zero OpenRouter tokens). The `--no-agent` runner does
#     NOT pass --env-file secrets beyond FLUNCLE_API_TOKEN, so the token does NOT reach
#     this script via the container env — it is read from a 0600 operator-placed file
#     at ${HOME}/.note-sweep.env (mounted ~/.hermes), sourced below.
#   - the `copywriting-fluncle` skill — BAKED into the image at /opt/claude/skills/
#     (discovered via CLAUDE_CONFIG_DIR=/opt/claude, readable by the non-root cron user).
#   - optional DISCORD_ALERT_WEBHOOK for the claude-auth-failed ping (in the same file —
#     it too is dropped by the runner's curated env).
#
# Operator wires it on the devbox (the image already carries bun + the fluncle CLI +
# claude + the skill; `note_track` is AGENT tier, so the box's existing agent-scoped
# token drives it — no operator token needed):
#
#   hermes cron create "every 30m" --no-agent --script note-sweep.sh --deliver local --name fluncle-note
#
# Confirm with `hermes cron list`; per-run output lands in
# ~/.hermes/cron/output/{job_id}/{timestamp}.md.
set -euo pipefail

# The Hermes cron `--no-agent --script` runner execs this with a minimal PATH that
# omits /usr/local/bin (the bun + fluncle symlinks) and /root/.bun/bin, so a bare
# `bun`/`fluncle` is "not found" → exit 127 (the runner's env, not the image's; a
# manual `bash note-sweep.sh` works because it inherits the container's full PATH).
# Prepend the known install dirs so this wrapper's `bun` AND the orchestrator's
# `fluncle`/`bun`/`claude` spawns resolve regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: the cron runner's exec context loses the PATH export above,
# so pin ABSOLUTE paths for the interpreter + the CLI. The orchestrator reads
# BUN_BIN/FLUNCLE_BIN, so its `bun`/`fluncle` spawns resolve with zero PATH
# dependence; the wrapper itself execs bun by absolute path too.
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# The cron runner WITHHOLDS Hermes' recognized PROVIDER CREDENTIALS (CLAUDE_CODE_OAUTH_TOKEN,
# OPENROUTER_API_KEY, DISCORD_*) from --no-agent scripts — a HARD security blocklist
# (`_HERMES_PROVIDER_ENV_BLOCKLIST`, GHSA-rhgp-j443-p4rf) that config.yaml's
# `terminal.env_passthrough` CANNOT override (it logs "refusing to register … blocked by
# _HERMES_PROVIDER_ENV_BLOCKLIST" and drops it). Only UNRECOGNIZED custom vars
# (FLUNCLE_API_TOKEN) pass. So `claude -p`'s token can ONLY reach this script via a file the
# operator places — sourced here: a 0600 ${HOME}/.note-sweep.env (mounted ~/.hermes)
# holding CLAUDE_CODE_OAUTH_TOKEN (required) + optionally DISCORD_ALERT_WEBHOOK /
# NOTE_CLAUDE_MODEL. Written via `op read op://Fluncle/CLAUDE_CODE_OAUTH_TOKEN/credential`.
NOTE_ENV_FILE="${NOTE_ENV_FILE:-${HOME:-/opt/data/home}/.note-sweep.env}"
if [ -r "${NOTE_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${NOTE_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec "${BUN_BIN}" "${SCRIPT_DIR}/note-sweep.ts" "$@"
