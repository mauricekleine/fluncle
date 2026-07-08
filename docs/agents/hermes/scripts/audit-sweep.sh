#!/usr/bin/env bash
# audit-sweep.sh — the 1am nightly codebase-audit driver (the "auditor").
#
# The deterministic half of the nightly audit (same hybrid shape as note/observe/newsletter):
# the driver owns the MECHANICS (freshen an isolated checkout, pick tonight's domain, set up
# git/gh creds, fetch SEO data on the surfaces day, write the /status marker), and exactly ONE
# `claude -p` call owns the JUDGMENT (audit the domain → fix what's safe → file the rest to the
# ledger → write the report → commit + push + open the PR itself). Claude Code = SUBSCRIPTION
# auth via CLAUDE_CODE_OAUTH_TOKEN, zero OpenRouter tokens.
#
# Scheduled by the repo-checked-in HOST systemd timer ../audit-timer/ (01:00 Amsterdam), which
# `docker exec`s it in the hermes container. The 5am reviewer (audit-review-sweep.sh) reviews +
# merges the PR this opens. Full doctrine: ../audit-timer/README.md + the prompts under
# ./audit/prompts/.
#
# USAGE
#   audit-sweep.sh                 # tonight's rotation domain, live (commit + push + PR)
#   audit-sweep.sh --domain <key>  # force a domain (pilot / manual run)
#   audit-sweep.sh --dry-run       # audit + edit + report, but DO NOT commit/push/PR
# (--dry-run + --domain compose; --dry-run leaves the workspace branch uncommitted for inspection.)
set -uo pipefail

# The runner execs with a minimal PATH; prepend the known install dirs so bun/claude/gh/git/fluncle resolve.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AUDIT_DIR="${SCRIPT_DIR}/audit"

# Provider creds (CLAUDE_CODE_OAUTH_TOKEN, FLUNCLE_AUDIT_GITHUB_PAT, FLUNCLE_BING_WEBMASTER_API_KEY)
# arrive via the 0600 op-synced shared file, exactly like newsletter/observe. GSC is a separate
# 0600 json file the sync writes; GOOGLE_APPLICATION_CREDENTIALS points at it.
SECRETS_FILE="${AUDIT_SECRETS_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${SECRETS_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${SECRETS_FILE}"
  set +a
fi
export GOOGLE_APPLICATION_CREDENTIALS="${GOOGLE_APPLICATION_CREDENTIALS:-${HOME:-/opt/data/home}/.fluncle-gsc.json}"

log() { echo "[audit-sweep] $*" >&2; }

# ── args ────────────────────────────────────────────────────────────────────────────────────
DRY_RUN=0
DOMAIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --domain) DOMAIN="${2:-}"; shift ;;
    *) log "unknown arg: $1" ;;
  esac
  shift
done

run_audit() {
  local repo="mauricekleine/fluncle"
  local ws="${AUDIT_WORKSPACE:-${HOME:-/opt/data/home}/audit-workspace/fluncle}"

  # 1. Domain — explicit override, else tonight's rotation.
  if [ -z "${DOMAIN}" ]; then
    DOMAIN="$("${BUN_BIN}" "${AUDIT_DIR}/rotation.ts" 2>/dev/null || true)"
  fi
  local prompt_file="${AUDIT_DIR}/prompts/${DOMAIN}.md"
  if [ -z "${DOMAIN}" ] || [ ! -r "${prompt_file}" ]; then
    echo "{\"ok\":false,\"stage\":\"domain\",\"domain\":\"${DOMAIN}\",\"error\":\"no prompt for domain\"}"
    return 1
  fi
  log "domain=${DOMAIN} dry_run=${DRY_RUN}"

  # 2. Auth for git + gh (both off GH_TOKEN; no token written to disk).
  if [ -z "${FLUNCLE_AUDIT_GITHUB_PAT:-}" ]; then
    echo "{\"ok\":false,\"stage\":\"auth\",\"domain\":\"${DOMAIN}\",\"error\":\"no FLUNCLE_AUDIT_GITHUB_PAT\"}"
    return 1
  fi
  export GH_TOKEN="${FLUNCLE_AUDIT_GITHUB_PAT}"

  # 3. Freshen an ISOLATED checkout to origin/main (not /opt/fluncle-build, not the baked scripts).
  if [ ! -d "${ws}/.git" ]; then
    log "cloning ${repo} → ${ws}"
    mkdir -p "$(dirname -- "${ws}")"
    git clone --quiet "https://github.com/${repo}.git" "${ws}" || {
      echo "{\"ok\":false,\"stage\":\"clone\",\"domain\":\"${DOMAIN}\"}"; return 1; }
  fi
  cd "${ws}" || { echo "{\"ok\":false,\"stage\":\"cd\",\"domain\":\"${DOMAIN}\"}"; return 1; }

  # Bot identity + creds, scoped to this workspace. It has no 1Password signing key, so commits
  # are unsigned (a machine identity); scoped to this throwaway checkout, never global.
  git config user.name "fluncle-audit-bot"
  git config user.email "hey@mauricekleine.com"
  git config commit.gpgsign false
  git config credential.https://github.com.helper "!gh auth git-credential"

  git fetch --quiet origin main || { echo "{\"ok\":false,\"stage\":\"fetch\",\"domain\":\"${DOMAIN}\"}"; return 1; }
  git reset --hard --quiet origin/main
  git clean -fdq                       # drop stray untracked; keeps ignored node_modules + .audit-parent
  rm -rf .audit && mkdir -p .audit

  # 4. Deps (cached between runs; only re-resolves on a lockfile change).
  log "bun install…"
  "${BUN_BIN}" install --silent || log "bun install returned nonzero (continuing; checks may be partial)"

  # 5. Tonight's branch off fresh main.
  local date_tag branch
  date_tag="$(date -u +%Y%m%d)"
  branch="audit/${date_tag}-${DOMAIN}"
  git checkout -qB "${branch}" origin/main

  # 6. Surfaces day pulls the real GSC + Bing data for the prompt to prioritize from.
  if [ "${DOMAIN}" = "surfaces-seo" ]; then
    log "fetching GSC + Bing data → .audit/seo-data.json"
    "${BUN_BIN}" "${AUDIT_DIR}/fetch-seo-data.ts" ".audit/seo-data.json" || log "seo fetch degraded (auditor falls back to structural checks)"
  fi

  # 7. Assemble the prompt = shared contract + tonight's domain brief + a runtime directive.
  local runtime_note
  if [ "${DRY_RUN}" = "1" ]; then
    runtime_note="RUNTIME: this is a DRY RUN. Do the full audit, make your edits, append filed findings to docs/audit-backlog.md, and write .audit/report.md — but do NOT run git or gh; leave the branch uncommitted for inspection."
  else
    runtime_note="RUNTIME: this is a LIVE run on branch ${branch}. Follow the 'Ship it' steps — commit (include docs/audit-backlog.md), \`git push -u origin HEAD\`, and open the PR with \`gh pr create --base main --fill-first --title \"nightly audit — ${DOMAIN}\" --body-file .audit/report.md\`. Do not merge."
  fi
  local prompt
  prompt="$(cat "${AUDIT_DIR}/prompts/_preamble.md")

# Tonight: ${DOMAIN} — $(date -u +%Y-%m-%d)

${runtime_note}

$(cat "${prompt_file}")"

  # 8. The one bounded judgment call. Its chatter → stderr/journald; only our summary hits stdout.
  export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/opt/claude}"
  log "invoking claude -p (opus) for ${DOMAIN}…"
  "$(command -v claude)" -p "${prompt}" \
    --model opus \
    --dangerously-skip-permissions \
    >&2 || log "claude -p returned nonzero"

  # 9. Report the outcome as the marker's JSON summary line.
  local changed pr_url
  changed="$(git status --porcelain | wc -l | tr -d ' ')"
  if [ "${DRY_RUN}" = "1" ]; then
    log "DRY RUN complete — ${changed} changed path(s) left in ${ws} for inspection"
    [ -r .audit/report.md ] && { log "── report ──"; cat .audit/report.md >&2; }
    echo "{\"ok\":true,\"domain\":\"${DOMAIN}\",\"action\":\"dry-run\",\"changed\":${changed:-0}}"
    return 0
  fi

  pr_url="$(gh pr list --head "${branch}" --json url --jq '.[0].url // empty' 2>/dev/null || true)"
  if [ -n "${pr_url}" ]; then
    echo "{\"ok\":true,\"domain\":\"${DOMAIN}\",\"action\":\"opened\",\"pr\":\"${pr_url}\"}"
    return 0
  fi
  # No PR. Either a clean night (no local commits ahead) or the agent failed to ship.
  if [ "$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)" = "0" ]; then
    echo "{\"ok\":true,\"domain\":\"${DOMAIN}\",\"action\":\"clean\"}"
    return 0
  fi
  echo "{\"ok\":false,\"domain\":\"${DOMAIN}\",\"action\":\"ship-failed\",\"error\":\"commits exist but no PR was opened\"}"
  return 1
}

# Host timers bypass the gateway's stdout capture, so self-report the /status marker
# (cron-output.sh) — WRAP the payload so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output audit -- run_audit
