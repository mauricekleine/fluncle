#!/usr/bin/env bash
# enrich-sweep.sh — the `--no-agent` enrichment cron's job ENTRY.
#
# PREPARED, NOT YET DEPLOYED. Version-controlled source; the repo is canonical and
# the box is a deploy target (fluncle-hermes-operator skill). The operator deploys
# this pair to ~/.hermes/scripts/ on the devbox and wires the cron there.
# Box rebuild (ffmpeg + bun image) and the Worker-cleanup PR are SEPARATE later
# steps (docs/spinup-to-hermes-enrichment-brief.md, build order #1 and #4).
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts`
# would be fed to Python. This thin wrapper is the bash entry; all the JSON work
# lives in the bun orchestrator beside it. Its stdout is the cron's run output.
#
# Operator wires it on the devbox (once the image carries ffmpeg + bun and the
# fluncle-track-enrichment skill is installed under ~/.hermes/skills/):
#
#   hermes cron create "every 5m" --no-agent --script enrich-sweep.sh --deliver local
#
# Confirm with `hermes cron list`; per-run output lands in
# ~/.hermes/cron/output/{job_id}/{timestamp}.md.
set -euo pipefail

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec bun "${SCRIPT_DIR}/enrich-sweep.ts" "$@"
