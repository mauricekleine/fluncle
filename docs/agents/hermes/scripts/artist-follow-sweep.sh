#!/usr/bin/env bash
# artist-follow-sweep.sh — the `--no-agent` artist auto-follow cron's job ENTRY
# (`fluncle-artist-follow`), the championing motion's automated half (Epic B, Unit 5 of
# the artist-relationship RFC).
#
# LIVE. Version-controlled source; the repo is canonical and the box is a deploy target
# (fluncle-hermes-operator skill). This pair deploys to ~/.hermes/scripts/ on the devbox
# and the cron is wired there. See ../cron/README.md.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts` would
# be fed to Python. This thin wrapper is the bash entry; the JSON work lives in the bun
# orchestrator beside it. Its stdout is the cron's run output.
#
# THE WORKER-PACED MODEL: the box holds NO YouTube token (the Worker does). So this driver
# just PACES the follow endpoint — one bounded batch per tick via the `fluncle` CLI — and
# the Worker performs the YouTube `subscriptions.insert`, then stamps `followed_at`. Pure
# trigger, zero LLM tokens on the box. Idempotent by construction (`followed_at IS NULL`),
# acting only on `status IN (auto, confirmed)`. YOUTUBE-ONLY: Spotify auto-follow is
# dev-mode-gated for our app (manual championing via /admin/artists instead — see the
# ROADMAP). Mixcloud is CUT to link-only.
#
# Operator wires it on the devbox (the image already carries bun + the fluncle CLI;
# `follow_artist` is AGENT tier, so the box's existing agent-scoped token drives it — no
# operator token needed):
#
#   hermes cron create "every 6h" --no-agent --script artist-follow-sweep.sh --deliver local
#
# Confirm with `hermes cron list`; per-run output lands in
# ~/.hermes/cron/output/{job_id}/{timestamp}.md.
set -euo pipefail

# The Hermes cron runner execs this with a minimal PATH that omits the bun + fluncle
# install dirs; prepend them so the wrapper's `bun` AND the orchestrator's `fluncle`/
# `bun` spawns resolve regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the
# /status freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) —
# WRAP the payload (never `exec`) so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output artist-follow -- "${BUN_BIN}" "${SCRIPT_DIR}/artist-follow-sweep.ts" "$@"
