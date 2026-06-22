#!/usr/bin/env bash
# enrich-sweep.sh — the `--no-agent` enrichment cron's job ENTRY.
#
# LIVE. Version-controlled source; the repo is canonical and the box is a deploy
# target (fluncle-hermes-operator skill). This pair is deployed to ~/.hermes/scripts/
# on the devbox and the cron is wired there. The Worker-side enrichment trigger is
# removed — this is the only enrichment path. See ../cron/README.md.
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
