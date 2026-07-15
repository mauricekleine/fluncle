#!/usr/bin/env bash
# album-bio-sweep.sh — the `--no-agent` album-bio cron's job ENTRY (`fluncle-album-bio`).
#
# LIVE. Version-controlled source; the repo is canonical and the box is a
# deploy target (fluncle-hermes-operator skill). This pair is BAKED into the image at
# /opt/hermes-scripts/ and auto-updates from main via pin-watch; a rave-02 HOST systemd
# timer docker-execs it — no docker cp. See ../cron/README.md and docs/agents/bio-agent.md.
#
# Why a .sh that execs a shared .ts: the entity-bio sweep is ONE orchestrator over three
# kinds (artist, label + album), dispatched by `--kind`. This thin bash wrapper is the album
# entry; its siblings artist-bio-sweep.sh and label-bio-sweep.sh pass `--kind artist` / `--kind
# label`. All the JSON work lives in entity-bio-sweep.ts. Its stdout is the cron's run output.
#
# THE HYBRID MODEL (same shape as note-sweep): the queue read, the Worker-paced grounding
# DRAFT (`fluncle admin albums draft-bio` → the Worker runs Firecrawl + pulls finding titles
# + assembles the prompt), and the bio delivery are all DETERMINISTIC (the `fluncle` CLI).
# Only the creative authoring — turning that Worker-supplied prompt into a short Fluncle-voiced
# paragraph — runs `claude -p` (Claude Code, SUBSCRIPTION auth via CLAUDE_CODE_OAUTH_TOKEN, NOT
# OpenRouter) with READ-ONLY tools. The SCRIPT posts the authored bio to the describe endpoint;
# the Worker re-scans (the voice gate, `gateBioText`) + FILLS AN EMPTY BIO ONLY (an operator
# bio is never clobbered) + stores. This is the entity sibling of the auto-note cron.
#
# PRODUCTION PRE-REQS (see ../cron/README.md):
#   - `claude` (Claude Code CLI) — BAKED into the image; authed via subscription
#     CLAUDE_CODE_OAUTH_TOKEN (zero OpenRouter tokens). The `--no-agent` runner does NOT
#     pass --env-file secrets beyond FLUNCLE_API_TOKEN, so the token does NOT reach this
#     script via the container env — it is read from a 0600 operator-placed file at
#     ${HOME}/.fluncle-secrets.env (mounted ~/.hermes), sourced below.
#   - the `copywriting-fluncle` skill — BAKED into the image at /opt/claude/skills/
#     (discovered via CLAUDE_CONFIG_DIR=/opt/claude, readable by the non-root cron user).
#   - optional DISCORD_ALERT_WEBHOOK for the claude-auth-failed ping (in the same file).
#   - NO Firecrawl key needed on the box: the grounding gather runs Worker-side in the
#     `draft-bio` read (the Worker holds the key), so on-box bios come out grounded.
#
# Scheduled by a repo-checked-in HOST systemd timer (../album-bio-timer/, installed by
# ../install-host-timers.sh), NOT a gateway `hermes cron create`. `describe_album` is AGENT
# tier, so the box's existing agent-scoped token drives it — no operator token needed.
# Per-run output is a freshness marker the sweep self-writes via cron-output.sh under
# ~/.hermes/cron/output/fluncle-album-bio/ (read by the /status prober). See ../cron/README.md.
set -euo pipefail

# The Hermes cron `--no-agent --script` runner execs this with a minimal PATH that omits
# /usr/local/bin (the bun + fluncle symlinks) and /root/.bun/bin, so a bare `bun`/`fluncle`
# is "not found" → exit 127. Prepend the known install dirs so this wrapper's `bun` AND the
# orchestrator's `fluncle`/`bun`/`claude` spawns resolve regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: pin ABSOLUTE paths for the interpreter + the CLI. The orchestrator
# reads BUN_BIN/FLUNCLE_BIN, so its `bun`/`fluncle` spawns resolve with zero PATH dependence.
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# The cron runner WITHHOLDS Hermes' recognized PROVIDER CREDENTIALS (CLAUDE_CODE_OAUTH_TOKEN,
# OPENROUTER_API_KEY, DISCORD_*) from --no-agent scripts — a HARD security blocklist
# (`_HERMES_PROVIDER_ENV_BLOCKLIST`, GHSA-rhgp-j443-p4rf) that config.yaml's
# `terminal.env_passthrough` CANNOT override. Only UNRECOGNIZED custom vars
# (FLUNCLE_API_TOKEN) pass. So `claude -p`'s token can ONLY reach this script via a file the
# operator places — sourced here: a 0600 ${HOME}/.fluncle-secrets.env (mounted ~/.hermes)
# holding CLAUDE_CODE_OAUTH_TOKEN (required) + optionally DISCORD_ALERT_WEBHOOK /
# ENTITY_BIO_CLAUDE_MODEL. Written from the configured 1Password item.
BIO_ENV_FILE="${BIO_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${BIO_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${BIO_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the /status
# freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) — WRAP the
# payload (never `exec`) so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output album-bio -- "${BUN_BIN}" "${SCRIPT_DIR}/entity-bio-sweep.ts" --kind album "$@"
