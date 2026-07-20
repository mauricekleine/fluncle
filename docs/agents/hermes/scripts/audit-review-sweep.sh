#!/usr/bin/env bash
# audit-review-sweep.sh — the 5am nightly-audit reviewer driver.
#
# The deterministic half finds the open audit PR + prepares the checkout; ONE `claude -p` call
# reviews it adversarially and — per ./audit/prompts/_reviewer.md — either fixes small residual
# nits and merges (green CI + no high-impact problem), or comments and leaves it open for the
# operator. The agent drives gh/git itself (subscription auth; zero OpenRouter tokens).
#
# Scheduled by the repo-checked-in HOST systemd timer ../audit-review-timer/ (05:00 Amsterdam),
# four hours after the 1am auditor so its PR + CI are settled. Full doctrine:
# ../audit-timer/README.md.
#
# USAGE
#   audit-review-sweep.sh          # review the newest open audit/* PR
#   audit-review-sweep.sh --pr N   # review a specific PR (pilot / manual)
set -uo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

# Headless `claude -p` kills backgrounded Bash ~5s after the final result; a sweep that
# backgrounds work and ends its turn loses it silently. Documented: code.claude.com/docs/en/env-vars.md
export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AUDIT_DIR="${SCRIPT_DIR}/audit"

SECRETS_FILE="${AUDIT_SECRETS_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${SECRETS_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${SECRETS_FILE}"
  set +a
fi

log() { echo "[audit-review] $*" >&2; }

PR_NUM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pr) PR_NUM="${2:-}"; shift ;;
    *) log "unknown arg: $1" ;;
  esac
  shift
done

run_review() {
  local repo="mauricekleine/fluncle"
  local ws="${AUDIT_WORKSPACE:-${HOME:-/opt/data/home}/audit-workspace/fluncle}"

  if [ -z "${FLUNCLE_AUDIT_GITHUB_PAT:-}" ]; then
    echo "{\"ok\":false,\"stage\":\"auth\",\"error\":\"no FLUNCLE_AUDIT_GITHUB_PAT\"}"
    return 1
  fi
  export GH_TOKEN="${FLUNCLE_AUDIT_GITHUB_PAT}"

  if [ ! -d "${ws}/.git" ]; then
    echo "{\"ok\":false,\"stage\":\"workspace\",\"error\":\"no audit workspace (run the auditor first)\"}"
    return 1
  fi
  cd "${ws}" || { echo "{\"ok\":false,\"stage\":\"cd\"}"; return 1; }
  git config user.name "fluncle-audit-bot"
  git config user.email "hey@mauricekleine.com"
  git config commit.gpgsign false
  git config credential.https://github.com.helper "!gh auth git-credential"
  git fetch --quiet origin main || true

  # Pick the PR: explicit --pr, else the NEWEST open audit/* PR.
  local domain branch
  if [ -z "${PR_NUM}" ]; then
    PR_NUM="$(gh pr list --repo "${repo}" --state open --json number,headRefName,createdAt \
      --jq '[.[] | select(.headRefName | startswith("audit/"))] | sort_by(.createdAt) | reverse | .[0].number // empty' 2>/dev/null || true)"
  fi
  if [ -z "${PR_NUM}" ]; then
    echo "{\"ok\":true,\"action\":\"none\",\"note\":\"no open audit PR to review\"}"
    return 0
  fi
  branch="$(gh pr view "${PR_NUM}" --repo "${repo}" --json headRefName --jq '.headRefName' 2>/dev/null || true)"
  domain="${branch##*-}"
  log "reviewing PR #${PR_NUM} (${branch}, domain=${domain})"

  # Check out the PR branch + sync deps so the reviewer can re-run checks.
  gh pr checkout "${PR_NUM}" --repo "${repo}" >/dev/null 2>&1 || {
    echo "{\"ok\":false,\"stage\":\"checkout\",\"pr\":${PR_NUM}}"; return 1; }
  "${BUN_BIN}" install --silent || log "bun install nonzero (continuing)"

  local runtime_note prompt
  runtime_note="RUNTIME: you are on branch ${branch} (PR #${PR_NUM}, domain ${domain}), checked out from origin/main. The auditor's report is the PR body + .audit/report.md; filed findings are rows in docs/audit-backlog.md. Follow your review contract: fix small nits (commit + \`git push\`), then either \`gh pr merge ${PR_NUM} --squash --delete-branch\` (no high-impact problem + required checks green), or \`gh pr comment ${PR_NUM}\` with your findings and leave it open. Confirm checks with \`gh pr checks ${PR_NUM}\`."
  prompt="$(cat "${AUDIT_DIR}/prompts/_reviewer.md")

${runtime_note}"

  export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/opt/claude}"

  # Mark this workspace trusted so the repo's .claude/settings.json — the guard-protected-files
  # hook (the mechanical backstop behind the prompt's rails) + the baked project skills — loads;
  # Claude Code silently ignores an untrusted dir's settings. The auditor marks it at 01:00, but a
  # container rebuild/swap before this 05:00 run wipes .claude.json, so re-assert it here too.
  # Idempotent; best-effort — on any failure the prompt rails + PAT scope + human-in-loop still gate.
  AUDIT_WS="${ws}" "${BUN_BIN}" -e '
    const fs = require("fs");
    const f = process.env.CLAUDE_CONFIG_DIR + "/.claude.json";
    const ws = process.env.AUDIT_WS;
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      (j.projects ??= {})[ws] ??= {};
      j.projects[ws].hasTrustDialogAccepted = true;
      fs.writeFileSync(f, JSON.stringify(j, null, 2));
      process.stderr.write("[audit-review] workspace marked trusted\n");
    } catch (e) { process.stderr.write("[audit-review] trust-mark skipped: " + e.message + "\n"); }
  ' || log "trust-mark step failed (continuing; prompt rails + PAT scope + review gate still apply)"

  log "invoking claude -p (opus) reviewer for PR #${PR_NUM}…"
  "$(command -v claude)" -p "${prompt}" \
    --model opus \
    --dangerously-skip-permissions \
    >&2 || log "claude -p returned nonzero"

  # Report the outcome from the PR's final state.
  local state
  state="$(gh pr view "${PR_NUM}" --repo "${repo}" --json state --jq '.state' 2>/dev/null || echo UNKNOWN)"
  case "${state}" in
    MERGED) echo "{\"ok\":true,\"action\":\"merged\",\"pr\":${PR_NUM},\"domain\":\"${domain}\"}" ;;
    OPEN)   echo "{\"ok\":true,\"action\":\"held\",\"pr\":${PR_NUM},\"domain\":\"${domain}\",\"note\":\"left open with a comment\"}" ;;
    *)      echo "{\"ok\":false,\"action\":\"unknown\",\"pr\":${PR_NUM},\"state\":\"${state}\"}" ;;
  esac
}

# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output audit-review -- run_review
