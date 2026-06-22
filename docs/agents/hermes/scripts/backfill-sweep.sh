#!/usr/bin/env bash
# backfill-sweep.sh — the `--no-agent` catalogue-backfill cron's job ENTRY.
#
# PREPARED, NOT YET WIRED. Version-controlled source; the repo is canonical and the
# box is a deploy target (fluncle-hermes-operator skill). This pair deploys to
# ~/.hermes/scripts/ on the devbox and the cron is wired there. See ../cron/README.md.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts`
# would be fed to Python. This thin wrapper is the bash entry; all the JSON work
# lives in the bun orchestrator beside it. Its stdout is the cron's run output.
#
# THE WORKER-PACED MODEL: the box holds NO Discogs/Last.fm vendor keys; the Worker
# does. So the backfill API calls happen in the Worker — this driver just paces one
# small bounded batch of each source per tick via the `fluncle` CLI, and the Worker
# carries the per-finding reliability state + Retry-After backoff.
#
# Operator wires it on the devbox (the image already carries bun + the fluncle CLI,
# and the operator token is the box's agent token — NOTE: the backfills are OPERATOR
# tier, so the box must drive them with an OPERATOR-scoped token, not the agent one;
# confirm the token tier before scheduling):
#
#   hermes cron create "every 30m" --no-agent --script backfill-sweep.sh --deliver local
#
# Confirm with `hermes cron list`; per-run output lands in
# ~/.hermes/cron/output/{job_id}/{timestamp}.md.
set -euo pipefail

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec bun "${SCRIPT_DIR}/backfill-sweep.ts" "$@"
