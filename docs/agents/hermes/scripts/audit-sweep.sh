#!/usr/bin/env bash

set -uo pipefail

export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AUDIT_DIR="${SCRIPT_DIR}/audit"
# shellcheck source=./agent-env.sh
. "${SCRIPT_DIR}/agent-env.sh"
# shellcheck source=./agent-pass.sh
. "${SCRIPT_DIR}/agent-pass.sh"

SECRETS_FILE="${AUDIT_SECRETS_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${SECRETS_FILE}" ]; then
	set -a
	# shellcheck source=/dev/null
	. "${SECRETS_FILE}"
	set +a
fi
export GOOGLE_APPLICATION_CREDENTIALS="${GOOGLE_APPLICATION_CREDENTIALS:-${HOME:-/opt/data/home}/.fluncle-gsc.json}"

log() { echo "[audit-sweep] $*" >&2; }

AUDIT_CLAUDE_EFFORT="${AUDIT_CLAUDE_EFFORT:-high}"
case "${AUDIT_CLAUDE_EFFORT}" in
low | medium | high | xhigh | max) ;;
*)
	log "AUDIT_CLAUDE_EFFORT='${AUDIT_CLAUDE_EFFORT}' is not low|medium|high|xhigh|max; using high"
	AUDIT_CLAUDE_EFFORT="high"
	;;
esac

DRY_RUN=0
DOMAIN=""
while [ $# -gt 0 ]; do
	case "$1" in
	--dry-run) DRY_RUN=1 ;;
	--domain)
		DOMAIN="${2:-}"
		shift
		;;
	*) log "unknown arg: $1" ;;
	esac
	shift
done

run_audit() {
	local repo="mauricekleine/fluncle"
	local ws="${AUDIT_WORKSPACE:-${HOME:-/opt/data/home}/audit-workspace/fluncle}"

	local slot_day="${FLUNCLE_DAILY_RETRY_SLOT_DAY:-}"
	if [[ ! "${slot_day}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
		slot_day="$(TZ=Europe/Amsterdam date +%Y-%m-%d)"
	fi
	if [ -z "${DOMAIN}" ]; then
		DOMAIN="$("${BUN_BIN}" "${AUDIT_DIR}/rotation.ts" "${slot_day}" 2>/dev/null || true)"
	fi
	local prompt_file="${AUDIT_DIR}/prompts/${DOMAIN}.md"
	if [ -z "${DOMAIN}" ] || [ ! -r "${prompt_file}" ]; then
		echo "{\"ok\":false,\"stage\":\"domain\",\"domain\":\"${DOMAIN}\",\"error\":\"no prompt for domain\",\"checked\":0,\"errors\":1,\"produced\":0}"
		return 1
	fi
	log "domain=${DOMAIN} dry_run=${DRY_RUN}"

	if [ -z "${FLUNCLE_AUDIT_GITHUB_PAT:-}" ]; then
		echo "{\"ok\":false,\"stage\":\"auth\",\"domain\":\"${DOMAIN}\",\"error\":\"no FLUNCLE_AUDIT_GITHUB_PAT\",\"checked\":0,\"errors\":1,\"produced\":0}"
		return 1
	fi
	export GH_TOKEN="${FLUNCLE_AUDIT_GITHUB_PAT}"

	if [ ! -d "${ws}/.git" ]; then
		log "cloning ${repo} → ${ws}"
		mkdir -p "$(dirname -- "${ws}")"
		git clone --quiet "https://github.com/${repo}.git" "${ws}" || {
			echo "{\"ok\":false,\"stage\":\"clone\",\"domain\":\"${DOMAIN}\",\"checked\":0,\"errors\":1,\"produced\":0}"
			return 1
		}
	fi
	cd "${ws}" || {
		echo "{\"ok\":false,\"stage\":\"cd\",\"domain\":\"${DOMAIN}\",\"checked\":0,\"errors\":1,\"produced\":0}"
		return 1
	}

	git config user.name "fluncle-audit-bot"
	git config user.email "hey@mauricekleine.com"
	git config commit.gpgsign false
	git config credential.https://github.com.helper "!gh auth git-credential"

	git config core.fileMode false

	find .git -maxdepth 1 -name index.lock -mmin +30 -delete 2>/dev/null || true

	git fetch --quiet origin main || {
		echo "{\"ok\":false,\"stage\":\"fetch\",\"domain\":\"${DOMAIN}\",\"checked\":0,\"errors\":1,\"produced\":0}"
		return 1
	}

	local date_tag branch
	date_tag="${slot_day//-/}"
	branch="audit/${date_tag}-${DOMAIN}"
	local remote_branch_rc=2
	if [ "${DRY_RUN}" != "1" ]; then
		git ls-remote --exit-code --heads origin "refs/heads/${branch}" >/dev/null 2>&1
		remote_branch_rc=$?
	fi
	if [ "${remote_branch_rc}" -ne 0 ] && [ "${remote_branch_rc}" -ne 2 ]; then
		log "could not read origin for tonight's branch ${branch} (git ls-remote exit ${remote_branch_rc}); not starting a pass"
		echo "{\"ok\":false,\"stage\":\"remote-branch\",\"domain\":\"${DOMAIN}\",\"checked\":0,\"errors\":1,\"produced\":0}"
		return 1
	fi
	if [ "${remote_branch_rc}" -eq 0 ]; then
		local shipped_pr
		shipped_pr="$(gh pr list --head "${branch}" --state all --json url --jq '.[0].url // empty' 2>/dev/null || true)"
		if [ -n "${shipped_pr}" ]; then
			log "tonight's branch ${branch} already shipped as ${shipped_pr}; nothing to re-run"
			echo "{\"ok\":true,\"domain\":\"${DOMAIN}\",\"action\":\"already-shipped\",\"pr\":\"${shipped_pr}\",\"checked\":1,\"errors\":0,\"produced\":0}"
			return 0
		fi
		log "tonight's branch ${branch} was pushed without a PR; leaving it for the operator"
		echo "{\"ok\":false,\"domain\":\"${DOMAIN}\",\"action\":\"ship-failed\",\"error\":\"branch pushed without a PR\",\"checked\":1,\"errors\":1,\"produced\":0}"
		return 1
	fi

	git reset --hard --quiet origin/main
	git clean -fdq
	rm -rf .audit && mkdir -p .audit

	log "bun install…"
	"${BUN_BIN}" install --silent || log "bun install returned nonzero (continuing; checks may be partial)"

	git checkout -qB "${branch}" origin/main

	if [ "${DOMAIN}" = "surfaces-seo" ]; then
		log "fetching GSC + Bing data → .audit/seo-data.json"
		"${BUN_BIN}" "${AUDIT_DIR}/fetch-seo-data.ts" ".audit/seo-data.json" || log "seo fetch degraded (auditor falls back to structural checks)"
	fi

	local runtime_note
	if [ "${DRY_RUN}" = "1" ]; then
		runtime_note="RUNTIME: this is a DRY RUN. Do the full audit, make your edits, append filed findings to docs/audit-backlog.md, and write .audit/report.md. Nothing will be committed or pushed; the driver leaves the branch uncommitted for inspection."
	else
		runtime_note="RUNTIME: this is a LIVE run on branch ${branch}. Follow the 'Ship it' steps: write .audit/report.md and leave your edits in the working tree. The driver commits, pushes, and opens the PR after you finish."
	fi
	local prompt
	prompt="$(cat "${AUDIT_DIR}/prompts/_preamble.md")

# Tonight: ${DOMAIN} — ${slot_day}

${runtime_note}

$(cat "${prompt_file}")"

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
      process.stderr.write("[audit-sweep] workspace marked trusted\n");
    } catch (e) { process.stderr.write("[audit-sweep] trust-mark skipped: " + e.message + "\n"); }
  ' || log "trust-mark step failed (continuing; prompt rails + PAT scope + review still gate)"

	agent_env_scrub_args --secrets "${SECRETS_FILE}" --allow GH_TOKEN \
		--scrub GOOGLE_APPLICATION_CREDENTIALS
	log "invoking claude -p (opus, effort ${AUDIT_CLAUDE_EFFORT}) for ${DOMAIN} (budget ${AGENT_PASS_BUDGET_SECS}s)…"
	local run_errors=0 pass_reason=""

	agent_pass_run env ${AGENT_ENV_SCRUB[@]+"${AGENT_ENV_SCRUB[@]}"} FLUNCLE_UNATTENDED=1 \
		"$(command -v claude)" -p "${prompt}" \
		--model opus \
		--effort "${AUDIT_CLAUDE_EFFORT}" \
		--dangerously-skip-permissions \
		>&2
	if [ -n "${AGENT_PASS_REASON}" ]; then
		log "claude -p ended on ${AGENT_PASS_REASON} after ${AGENT_PASS_SECONDS}s (status ${AGENT_PASS_STATUS}, container oom kills ${AGENT_PASS_OOM_KILLS})"
		pass_reason="${AGENT_PASS_REASON}"
		run_errors=1
	fi

	local verify_json="" verify_failed=0 verify_present=0
	if [ -r .audit/verify.json ]; then
		verify_present=1
		verify_json="$(tr -d '\000-\037' <.audit/verify.json | tail -n 1)"
		case "${verify_json}" in
		*'"failed":0'*) ;;
		*'"failed":'*) verify_failed=1 ;;
		*) verify_json="" ;;
		esac
	fi
	if [ "${verify_failed}" = "1" ]; then
		log "verify.sh reported a failed check — the branch ships red"
		run_errors=$((run_errors + 1))
		[ -n "${pass_reason}" ] || pass_reason="verify-failed"
	fi

	local changed ahead
	changed="$(git status --porcelain | wc -l | tr -d ' ')"
	ahead="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"

	if [ "${verify_present}" = "0" ] && { [ "${ahead}" != "0" ] || [ "${changed:-0}" != "0" ]; }; then
		log "no .audit/verify.json — the night's work was never verified"
		run_errors=$((run_errors + 1))
		[ -n "${pass_reason}" ] || pass_reason="unverified"
	fi

	local ok="true"
	[ "${run_errors}" = "0" ] || ok="false"

	local facts
	facts="$(printf '"pass_seconds":%s,"container_oom_kills":%s' "${AGENT_PASS_SECONDS}" "${AGENT_PASS_OOM_KILLS}")"
	[ -z "${pass_reason}" ] || facts="${facts},$(printf '"reason":"%s"' "${pass_reason}")"
	[ -z "${verify_json}" ] || facts="${facts},$(printf '"verify":%s' "${verify_json}")"

	if [ "${DRY_RUN}" = "1" ]; then
		local dry_produced=0
		[ "${changed:-0}" = "0" ] || [ "${run_errors}" != "0" ] || dry_produced=1
		log "DRY RUN complete — ${changed} changed path(s) left in ${ws} for inspection"
		[ -r .audit/report.md ] && {
			log "── report ──"
			cat .audit/report.md >&2
		}
		echo "{\"ok\":${ok},\"domain\":\"${DOMAIN}\",\"action\":\"dry-run\",\"changed\":${changed:-0},${facts},\"checked\":1,\"errors\":${run_errors},\"produced\":${dry_produced}}"
		return 0
	fi

	if [ "${changed:-0}" = "0" ] && [ "${ahead}" = "0" ]; then
		echo "{\"ok\":${ok},\"domain\":\"${DOMAIN}\",\"action\":\"clean\",${facts},\"checked\":1,\"errors\":${run_errors},\"produced\":0}"
		return 0
	fi

	if [ -n "${AGENT_PASS_REASON}" ]; then
		log "not shipping: the pass ended on ${AGENT_PASS_REASON}; ${changed} changed path(s) left in ${ws} for inspection"
		echo "{\"ok\":false,\"domain\":\"${DOMAIN}\",\"action\":\"unshipped\",\"changed\":${changed:-0},${facts},\"checked\":1,\"errors\":${run_errors},\"produced\":0}"
		return 0
	fi

	local ship_error="" label pr_url=""
	label="$(audit_domain_label)"
	if [ ! -s .audit/report.md ]; then
		ship_error="work exists but the agent wrote no .audit/report.md"
	elif [ "${changed:-0}" != "0" ] && ! audit_commit; then
		ship_error="commit failed"
	elif ! git push --quiet -u origin HEAD >&2; then
		ship_error="push failed"
	else

		pr_url="$(gh pr list --head "${branch}" --json url --jq '.[0].url // empty' 2>/dev/null || true)"
		if [ -z "${pr_url}" ]; then
			pr_url="$(gh pr create --base main --head "${branch}" --title "nightly audit — ${label}" \
				--body-file .audit/report.md | tail -n 1)" || pr_url=""
		fi
		[ -n "${pr_url}" ] || ship_error="gh pr create failed"
	fi
	if [ -n "${ship_error}" ]; then
		log "ship failed: ${ship_error}"
		echo "{\"ok\":false,\"domain\":\"${DOMAIN}\",\"action\":\"ship-failed\",\"error\":\"${ship_error}\",${facts},\"checked\":1,\"errors\":$((run_errors + 1)),\"produced\":0}"
		return 1
	fi
	log "opened ${pr_url}"
	echo "{\"ok\":${ok},\"domain\":\"${DOMAIN}\",\"action\":\"opened\",\"pr\":\"${pr_url}\",${facts},\"checked\":1,\"errors\":${run_errors},\"produced\":1}"
	return 0
}

audit_domain_label() {
	local label
	label="$("${BUN_BIN}" -e 'const m = await import(process.argv[1]); const l = m.DOMAIN_META?.[process.argv[2]]?.label; if (typeof l === "string") process.stdout.write(l);' \
		"${AUDIT_DIR}/rotation.ts" "${DOMAIN}" 2>/dev/null || true)"
	printf '%s' "${label:-${DOMAIN}}"
}

audit_commit() {
	local message
	message="audit(${DOMAIN}): $(sed -n '/[^[:space:]]/{s/^[#[:space:]]*//;p;q;}' .audit/report.md | cut -c1-72)"
	[ "${message}" != "audit(${DOMAIN}): " ] || message="audit(${DOMAIN}): nightly audit"
	git add -A || return 1
	if FLUNCLE_UNATTENDED=1 git commit --quiet -m "${message}" >&2; then
		return 0
	fi
	log "the pre-commit hook refused the commit; committing with --no-verify so the PR's checks flag it"
	git add -A || return 1
	git commit --quiet --no-verify -m "${message}" >&2
}

# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output audit -- run_audit
