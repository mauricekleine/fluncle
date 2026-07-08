#!/usr/bin/env bash
# backup-sweep.sh — the `--no-agent` database-backup cron's job ENTRY (`fluncle-backup`).
#
# LIVE. Version-controlled source; the repo is canonical and the box is a deploy
# target (fluncle-hermes-operator skill). This pair deploys to ~/.hermes/scripts/ on
# the devbox and the cron is wired there. See ../cron/README.md § The database-backup cron.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts` would
# be fed to Python. This thin wrapper is the bash entry; all the work lives in the bun
# orchestrator beside it (backup-sweep.ts). Its stdout is the cron's run output.
#
# WHAT IT DOES: dumps the PRODUCTION Turso database to gzipped SQL over the libSQL HTTP
# pipeline (zero deps, no `turso` CLI), uploads the dump + an integrity manifest to a
# PRIVATE R2 bucket (never fluncle-videos — that is world-served at found.fluncle.com),
# and prunes to the retention window (30 dailies + 12 monthlies). A pure job: zero LLM
# tokens. The restore drill (apps/web/scripts/restore-drill.ts) is its acceptance test.
#
# PRODUCTION PRE-REQS (see ../cron/README.md § The database-backup cron):
#   - Secrets in the shared 0600 ${HOME}/.fluncle-secrets.env (op-injected by
#     fluncle-secrets-sync), sourced below:
#       TURSO_DATABASE_URL / TURSO_AUTH_TOKEN — a READ-ONLY prod Turso token (dump only).
#       FLUNCLE_BACKUP_R2_ACCESS_KEY_ID / FLUNCLE_BACKUP_R2_SECRET_ACCESS_KEY — a
#         least-privilege R2 token scoped to Object Read & Write on the backup bucket ONLY.
#       R2_ACCOUNT_ID — the (non-secret) Cloudflare account id (also in wrangler.jsonc).
#       optional: FLUNCLE_BACKUP_R2_BUCKET (default fluncle-backups),
#         FLUNCLE_BACKUP_KEEP_DAILY (30), FLUNCLE_BACKUP_KEEP_MONTHLY (12),
#         DISCORD_ALERT_WEBHOOK (the backup-failed ping — DISCORD_* is dropped from the
#         cron env, so it MUST come from this file).
#   - The private bucket must exist (operator step; creating an R2 bucket is free).
#
# Operator wires it on the devbox (the image already carries bun; the job needs no
# fluncle CLI + no agent token — it talks to Turso + R2 directly):
#
#   hermes cron create "every 24h" --no-agent --script backup-sweep.sh --deliver local --name fluncle-backup
#
# Confirm with `hermes cron list`; per-run output lands in
# ~/.hermes/cron/output/{job_id}/{timestamp}.md.
set -euo pipefail

# The runner execs this with a minimal PATH that omits /usr/local/bin (the bun symlink)
# and /root/.bun/bin, so a bare `bun` is "not found" → exit 127. Prepend the known
# install dirs so this wrapper's `bun` resolves regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: pin the absolute interpreter path too (the runner can lose the
# PATH export above).
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

# Source the shared 0600 secrets file (the same single source every other sweep reads;
# DISCORD_* + provider creds are dropped from the cron env by Hermes' blocklist, so the
# webhook can only arrive via this file).
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${BACKUP_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${BACKUP_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Host timers bypass the Hermes gateway runner's stdout capture, so self-report the
# /status freshness marker the fluncle-healthcheck prober reads (see cron-output.sh) —
# WRAP the payload (never `exec`) so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output backup -- "${BUN_BIN}" "${SCRIPT_DIR}/backup-sweep.ts" "$@"
