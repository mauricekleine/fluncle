#!/usr/bin/env bash
# fluncle-healthcheck.sh — the `fluncle-healthcheck` `--no-agent` Hermes cron's job ENTRY.
#
# The prober behind Fluncle's public /status dashboard. Version-controlled source;
# the repo is canonical and the box is a deploy target (fluncle-hermes-operator
# skill). This pair deploys to the box's scripts dir and the cron is wired there.
# See ../cron/README.md § The healthcheck cron.
#
# WHAT IT DOES: every ~10m it probes each Fluncle service (the Worker, R2, DNS, the
# SSH app, the on-box automation crons, the scale-to-zero render box, Hermes itself),
# detects status TRANSITIONS against a local state file, Discord-pings ONLY on a
# transition (a service going down OR recovering — never on a steady state, so no
# spam), and POSTs the snapshot to the agent-tier `POST /api/admin/health`
# (oRPC `record_health`) that feeds the public page.
#
# Why a .sh that execs a .ts: the Hermes `--no-agent --script` runner dispatches by
# extension — bash for `.sh`/`.bash`, Python for everything else — so a bare `.ts`
# would be fed to Python. This thin wrapper is the bash entry; all the probe + JSON
# work lives in the bun orchestrator beside it. Its stdout is the cron's run output.
#
# PUBLIC-SAFE BY CONSTRUCTION (this repo is open source): this script carries NO
# hostnames, IPs, ports, op:// paths, or /opt/... literals beyond the cron user's
# own $HOME. EVERY probe target is read from a 0600 operator-placed file at
# ${HOME}/.healthcheck.env (sourced below, exactly like observe-sweep sources its
# env). The exact target VALUES + the secret-file population live in the ops runbook
# note in 1Password, referenced neutrally — never inlined here. Required keys:
#
#   HEALTHCHECK_WORKER_URL   — the Worker origin, e.g. https://www.fluncle.com
#                              (the web probe GETs ${HEALTHCHECK_WORKER_URL}/api/health;
#                              also the POST target for the health snapshot).
#   HEALTHCHECK_R2_PROBE_URL — a known public R2 object URL (HEAD probe).
#   HEALTHCHECK_DNS_QUERY    — a name to `dig +short` (DNS probe).
#   HEALTHCHECK_SSH_HOST     — the SSH app host (TCP-connect probe).
#   HEALTHCHECK_SSH_PORT     — the SSH app port.
#   DISCORD_ALERT_WEBHOOK    — the Discord webhook for transition alerts.
#
# FLUNCLE_API_TOKEN (the agent-scoped token that authorizes the snapshot POST)
# arrives via the CRON ENV — an unrecognized custom var passes Hermes' provider-cred
# blocklist, same as the other sweeps (../cron/README.md § Operational gotchas). The
# secrets above are all in the 0600 file because Hermes hard-blocks DISCORD_* (and
# anything resembling a provider cred) from the cron env.
#
# Operator wires it on the box (image carries bun + the fluncle CLI + dig + nc):
#   hermes cron create "every 10m" --no-agent --script fluncle-healthcheck.sh \
#     --deliver local --name fluncle-healthcheck
#
# Confirm with `hermes cron list`; per-run output lands in
# ~/.hermes/cron/output/{job_id}/{timestamp}.md.
set -euo pipefail

# The Hermes cron `--no-agent --script` runner execs this with a minimal PATH that
# omits /usr/local/bin (the bun + fluncle symlinks) and /root/.bun/bin, so a bare
# `bun` is "not found" → exit 127. Prepend the known install dirs so this wrapper's
# `bun` AND the orchestrator's `dig`/`curl`/`nc`/`box`/`bun` spawns resolve
# regardless of the runner's PATH.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"

# Belt-and-suspenders: the cron runner's exec context loses the PATH export above,
# so pin the ABSOLUTE interpreter path. The orchestrator reads BUN_BIN and resolves
# the rest via PATH (with absolute fallbacks of its own).
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

# All probe targets + the Discord webhook are file-sourced (Hermes blocks DISCORD_*
# from the cron env; the targets are public-safe but kept out of the repo). A 0600
# ${HOME}/.healthcheck.env populated by the operator (see the ops runbook note in
# 1Password). FLUNCLE_API_TOKEN is NOT here — it rides the cron env.
HEALTHCHECK_ENV_FILE="${HEALTHCHECK_ENV_FILE:-${HOME:-/opt/data/home}/.healthcheck.env}"
if [ -r "${HEALTHCHECK_ENV_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${HEALTHCHECK_ENV_FILE}"
  set +a
fi

# Resolve the orchestrator next to this wrapper so it runs regardless of CWD.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec "${BUN_BIN}" "${SCRIPT_DIR}/fluncle-healthcheck.ts" "$@"
