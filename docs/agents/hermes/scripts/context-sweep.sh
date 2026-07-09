#!/usr/bin/env bash
# context-sweep.sh — the `--no-agent` context-note cron's job ENTRY.
#
# LIVE. Version-controlled source; the repo is canonical and the box is a
# deploy target (fluncle-hermes-operator skill). This pair is BAKED into the image at
# /opt/hermes-scripts/ and auto-updates from main via pin-watch; a rave-02 HOST systemd
# timer docker-execs it — no docker cp. See ../cron/README.md.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts`
# would be fed to Python. This thin wrapper is the bash entry; all the JSON work
# lives in the bun orchestrator beside it. Its stdout is the cron's run output.
#
# THE WORKER-PACED MODEL: the box holds NO Firecrawl key (the Worker does), and the
# note-distilling LLM (Haiku, #129) is Worker-side too. So this driver just PACES the
# context endpoint — one small bounded batch per tick via the `fluncle` CLI — and the
# Worker runs the Firecrawl search + Haiku distill + the quiet `context_note` write.
# Pure trigger, zero LLM tokens on the box.
#
# Scheduled by a repo-checked-in HOST systemd timer (../context-note-timer/, installed by
# ../install-host-timers.sh), NOT a gateway `hermes cron create`. `context_track` is AGENT
# tier, so the box's existing agent-scoped token drives it — no operator token needed.
# Per-run output is a freshness marker the sweep self-writes via cron-output.sh under
# ~/.hermes/cron/output/fluncle-context-note/ (read by the /status prober). See ../cron/README.md.
#
# THE OCCASIONAL WIDEN PASS (--retry-empty): the routine sweep above EXCLUDES finds the
# prior pass confirmed empty (`context_status = 'empty'`), so the every-tick cron never
# re-burns Firecrawl + the distil LLM on a hopeless find. To re-attempt those empties
# (e.g. monthly, after new web facts may have surfaced), pass the flag through to the
# orchestrator via `--retry-empty` — run by hand on the box, or a separate rarely-fired
# host timer (there is no committed widen-pass timer unit), NOT the default 60m job:
#
# One-shot by hand on the box: `RETRY_EMPTY=1 bash context-sweep.sh`. Either way the
# per-finding trigger is identical; only the worklist (step 1) widens.
set -euo pipefail

# The Hermes cron `--no-agent --script` runner execs this with a minimal PATH that
# omits /usr/local/bin (the bun + fluncle symlinks) and /root/.bun/bin, so a bare
# `bun`/`fluncle` is "not found" → exit 127 (the runner's env, not the image's; a
# manual `bash context-sweep.sh` works because it inherits the container's full PATH).
# Prepend the known install dirs so this wrapper's `bun` AND the orchestrator's
# `fluncle`/`bun` spawns resolve regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: the cron runner's exec context loses the PATH export above,
# so pin ABSOLUTE paths for the interpreter + the CLI. The orchestrator reads
# BUN_BIN/FLUNCLE_BIN, so its `bun`/`fluncle` spawns resolve with zero PATH
# dependence; the wrapper itself execs bun by absolute path too.
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
export FLUNCLE_BIN="${FLUNCLE_BIN:-/usr/local/bin/fluncle}"

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the
# /status freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) —
# WRAP the payload (never `exec`) so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output context-note -- "${BUN_BIN}" "${SCRIPT_DIR}/context-sweep.ts" "$@"
