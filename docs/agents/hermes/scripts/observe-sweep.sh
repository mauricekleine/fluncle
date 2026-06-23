#!/usr/bin/env bash
# observe-sweep.sh — the `--no-agent` observation cron's job ENTRY.
#
# PREPARED. Version-controlled source; the repo is canonical and the box is a
# deploy target (fluncle-hermes-operator skill). This pair deploys to
# ~/.hermes/scripts/ on the devbox and the cron is wired there. See ../cron/README.md.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts`
# would be fed to Python. This thin wrapper is the bash entry; all the JSON work
# lives in the bun orchestrator beside it. Its stdout is the cron's run output.
#
# THE HYBRID MODEL: this is NOT a pure trigger like enrich/context/backfill — it has
# ONE agentic step in the middle. The queue read, the per-finding metadata gather,
# and the render delivery are all DETERMINISTIC (the `fluncle` CLI). Only the creative
# authoring — turning a finding's facts into a recovered-audio script in Fluncle's
# voice — runs `claude -p` (Claude Code, SUBSCRIPTION auth via CLAUDE_CODE_OAUTH_TOKEN,
# NOT OpenRouter) with READ-ONLY tools. The SCRIPT posts the authored text to the
# observe endpoint; the Worker re-scans (the voice gate) + renders ElevenLabs + stores.
# This replaces the old full-agent `fluncle-observation` cron (a whole Sonnet session
# per tick just to drain a queue) with a deterministic wrapper around the one creative
# step that genuinely needs a model.
#
# PRODUCTION PRE-REQS (see ../cron/README.md):
#   - `claude` (Claude Code CLI) — BAKED into the image; authed via subscription
#     CLAUDE_CODE_OAUTH_TOKEN (zero OpenRouter tokens). The runner WITHHOLDS Hermes' own
#     recognized secrets from --no-agent scripts, so the token is ALLOWLISTED via
#     `terminal.env_passthrough` in config.yaml; it arrives from /etc/hermes.env
#     (op://Fluncle/CLAUDE_CODE_OAUTH_TOKEN/credential).
#   - the `copywriting-fluncle` skill — BAKED into the image at /opt/claude/skills/
#     (discovered via CLAUDE_CONFIG_DIR=/opt/claude, readable by the non-root cron user).
#   - DISCORD_ALERT_WEBHOOK for the claude-auth-failed ping — also allowlisted in
#     config.yaml's `terminal.env_passthrough` (from /etc/hermes.env).
#
# Operator wires it on the devbox (the image already carries bun + the fluncle CLI +
# claude + the skill; `observe_track` is AGENT tier, so the box's existing agent-scoped
# token drives it — no operator token needed):
#
#   hermes cron create "every 60m" --no-agent --script observe-sweep.sh --deliver local --name fluncle-observation
#
# Confirm with `hermes cron list`; per-run output lands in
# ~/.hermes/cron/output/{job_id}/{timestamp}.md.
set -euo pipefail

# The Hermes cron `--no-agent --script` runner execs this with a minimal PATH that
# omits /usr/local/bin (the bun + fluncle symlinks) and /root/.bun/bin, so a bare
# `bun`/`fluncle` is "not found" → exit 127 (the runner's env, not the image's; a
# manual `bash observe-sweep.sh` works because it inherits the container's full PATH).
# Prepend the known install dirs so this wrapper's `bun` AND the orchestrator's
# `fluncle`/`bun`/`claude` spawns resolve regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: the cron runner's exec context loses the PATH export above,
# so pin ABSOLUTE paths for the interpreter + the CLI. The orchestrator reads
# BUN_BIN/FLUNCLE_BIN, so its `bun`/`fluncle` spawns resolve with zero PATH
# dependence; the wrapper itself execs bun by absolute path too.
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# CLAUDE_CODE_OAUTH_TOKEN (claude -p auth) + DISCORD_ALERT_WEBHOOK (the auth-fail ping)
# arrive via the container --env-file, BUT the cron runner withholds Hermes' recognized
# secrets from --no-agent scripts by default — so they are ALLOWLISTED in config.yaml's
# `terminal.env_passthrough` (Hermes security docs § Environment Variable Passthrough).
# Nothing to source here; the env carries them.

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec "${BUN_BIN}" "${SCRIPT_DIR}/observe-sweep.ts" "$@"
