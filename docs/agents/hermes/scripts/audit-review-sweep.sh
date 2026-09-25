#!/usr/bin/env bash

set -uo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AUDIT_DIR="${SCRIPT_DIR}/audit"
# shellcheck source=./agent-env.sh
. "${SCRIPT_DIR}/agent-env.sh"

AGENT_PASS_BUDGET_SECS="${AUDIT_REVIEW_PASS_BUDGET_SECS:-${AGENT_PASS_BUDGET_SECS:-2400}}"
# shellcheck source=./agent-pass.sh
. "${SCRIPT_DIR}/agent-pass.sh"

SECRETS_FILE="${AUDIT_SECRETS_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${SECRETS_FILE}" ]; then
	set -a
	# shellcheck source=/dev/null
	. "${SECRETS_FILE}"
	set +a
fi

log() { echo "[audit-review] $*" >&2; }

AUDIT_REVIEW_CLAUDE_EFFORT="${AUDIT_REVIEW_CLAUDE_EFFORT:-high}"
case "${AUDIT_REVIEW_CLAUDE_EFFORT}" in
low | medium | high | xhigh | max) ;;
*)
	log "AUDIT_REVIEW_CLAUDE_EFFORT='${AUDIT_REVIEW_CLAUDE_EFFORT}' is not low|medium|high|xhigh|max; using high"
	AUDIT_REVIEW_CLAUDE_EFFORT="high"
	;;
esac

PR_NUM=""
while [ $# -gt 0 ]; do
	case "$1" in
	--pr)
		PR_NUM="${2:-}"
		shift
		;;
	*) log "unknown arg: $1" ;;
	esac
	shift
done

run_review() {
	local repo="mauricekleine/fluncle"
	local ws="${AUDIT_WORKSPACE:-${HOME:-/opt/data/home}/audit-workspace/fluncle}"

	if [ -z "${FLUNCLE_AUDIT_GITHUB_PAT:-}" ]; then
		echo "{\"ok\":false,\"stage\":\"auth\",\"error\":\"no FLUNCLE_AUDIT_GITHUB_PAT\",\"checked\":0,\"errors\":1,\"produced\":0}"
		return 1
	fi
	export GH_TOKEN="${FLUNCLE_AUDIT_GITHUB_PAT}"

	if [ ! -d "${ws}/.git" ]; then
		echo "{\"ok\":false,\"stage\":\"workspace\",\"error\":\"no audit workspace (run the auditor first)\",\"checked\":0,\"errors\":1,\"produced\":0}"
		return 1
	fi
	cd "${ws}" || {
		echo "{\"ok\":false,\"stage\":\"cd\",\"checked\":0,\"errors\":1,\"produced\":0}"
		return 1
	}
	git config user.name "fluncle-audit-bot"
	git config user.email "hey@mauricekleine.com"
	git config commit.gpgsign false
	git config credential.https://github.com.helper "!gh auth git-credential"
	git fetch --quiet origin main || true

	local domain branch
	if [ -z "${PR_NUM}" ]; then
		PR_NUM="$(gh pr list --repo "${repo}" --state open --json number,headRefName,createdAt \
			--jq '[.[] | select(.headRefName | startswith("audit/"))] | sort_by(.createdAt) | reverse | .[0].number // empty' 2>/dev/null || true)"
	fi
	if [ -z "${PR_NUM}" ]; then

		echo "{\"ok\":true,\"action\":\"none\",\"note\":\"no open audit PR to review\",\"checked\":0,\"errors\":0,\"produced\":0}"
		return 0
	fi
	branch="$(gh pr view "${PR_NUM}" --repo "${repo}" --json headRefName --jq '.headRefName' 2>/dev/null || true)"
	domain="${branch##*-}"
	log "reviewing PR #${PR_NUM} (${branch}, domain=${domain})"

	gh pr checkout "${PR_NUM}" --repo "${repo}" >/dev/null 2>&1 || {
		echo "{\"ok\":false,\"stage\":\"checkout\",\"pr\":${PR_NUM},\"checked\":1,\"errors\":1,\"produced\":0}"
		return 1
	}
	"${BUN_BIN}" install --silent || log "bun install nonzero (continuing)"

	local runtime_note prompt
	runtime_note="RUNTIME: you are on branch ${branch} (PR #${PR_NUM}, domain ${domain}), checked out from origin/main. The auditor's report is the PR body + .audit/report.md; filed findings are rows in docs/audit-backlog.md. Follow your review contract: fix small nits (commit + \`git push\`), then either \`gh pr merge ${PR_NUM} --squash --delete-branch\` (no high-impact problem + required checks green), or \`gh pr comment ${PR_NUM}\` with your findings and leave it open. Confirm checks with \`gh pr checks ${PR_NUM}\`."
	prompt="$(cat "${AUDIT_DIR}/prompts/_reviewer.md")

${runtime_note}"

	export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/opt/claude}"

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

	agent_env_scrub_args --secrets "${SECRETS_FILE}" --allow GH_TOKEN
	log "invoking claude -p (opus, effort ${AUDIT_REVIEW_CLAUDE_EFFORT}) reviewer for PR #${PR_NUM} (budget ${AGENT_PASS_BUDGET_SECS}s)…"
	local run_errors=0 pass_reason=""

	agent_pass_run env ${AGENT_ENV_SCRUB[@]+"${AGENT_ENV_SCRUB[@]}"} FLUNCLE_UNATTENDED=1 \
		"$(command -v claude)" -p "${prompt}" \
		--model opus \
		--effort "${AUDIT_REVIEW_CLAUDE_EFFORT}" \
		--dangerously-skip-permissions \
		>&2
	if [ -n "${AGENT_PASS_REASON}" ]; then
		log "claude -p ended on ${AGENT_PASS_REASON} after ${AGENT_PASS_SECONDS}s (status ${AGENT_PASS_STATUS}, container oom kills ${AGENT_PASS_OOM_KILLS})"
		pass_reason="${AGENT_PASS_REASON}"
		run_errors=1
	fi

	local held_produced=1 ok="true" state facts
	[ "${run_errors}" = "0" ] || held_produced=0
	[ "${run_errors}" = "0" ] || ok="false"
	facts="$(printf '"pass_seconds":%s,"container_oom_kills":%s' "${AGENT_PASS_SECONDS}" "${AGENT_PASS_OOM_KILLS}")"
	[ -z "${pass_reason}" ] || facts="${facts},$(printf '"reason":"%s"' "${pass_reason}")"
	state="$(gh pr view "${PR_NUM}" --repo "${repo}" --json state --jq '.state' 2>/dev/null || echo UNKNOWN)"
	case "${state}" in
	MERGED) echo "{\"ok\":${ok},\"action\":\"merged\",\"pr\":${PR_NUM},\"domain\":\"${domain}\",${facts},\"checked\":1,\"errors\":${run_errors},\"produced\":1}" ;;
	OPEN) echo "{\"ok\":${ok},\"action\":\"held\",\"pr\":${PR_NUM},\"domain\":\"${domain}\",\"note\":\"left open with a comment\",${facts},\"checked\":1,\"errors\":${run_errors},\"produced\":${held_produced}}" ;;
	*) echo "{\"ok\":false,\"action\":\"unknown\",\"pr\":${PR_NUM},\"state\":\"${state}\",${facts},\"checked\":1,\"errors\":$((run_errors + 1)),\"produced\":0}" ;;
	esac
}

# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output audit-review -- run_review
