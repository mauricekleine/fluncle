#!/usr/bin/env bash
# audit-sweep.sh — the 1am nightly codebase-audit driver (the "auditor").
#
# The deterministic half of the nightly audit (same hybrid shape as note/observe/newsletter):
# the driver owns the MECHANICS (freshen an isolated checkout, pick tonight's domain, set up
# git/gh creds, fetch SEO data on the surfaces day, commit + push + open the PR, write the /status
# marker), and exactly ONE `claude -p` call owns the JUDGMENT (audit the domain → fix what's safe →
# file the rest to the ledger → write .audit/report.md). Once the edits and the report exist,
# shipping them is fully determined, so it belongs to the driver rather than the agent. Claude
# Code = SUBSCRIPTION auth via CLAUDE_CODE_OAUTH_TOKEN, zero OpenRouter tokens.
#
# Scheduled by the repo-checked-in HOST systemd timer ../audit-timer/ (01:00 Amsterdam), which
# `docker exec`s it in the hermes container. The 5am reviewer (audit-review-sweep.sh) reviews +
# merges the PR this opens. Full doctrine: ../audit-timer/README.md + the prompts under
# ./audit/prompts/.
#
# USAGE
#   audit-sweep.sh                 # tonight's rotation domain, live (commit + push + PR)
#   audit-sweep.sh --domain <key>  # force a domain (pilot / manual run)
#   audit-sweep.sh --dry-run       # audit + edit + report; the driver runs no git write or gh
# (--dry-run + --domain compose; --dry-run leaves the workspace branch uncommitted for inspection.)
set -uo pipefail

# The runner execs with a minimal PATH; prepend the known install dirs so bun/claude/gh/git/fluncle resolve.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

# Headless `claude -p` kills backgrounded Bash ~5s after the final result; a sweep that
# backgrounds work and ends its turn loses it silently. Documented: code.claude.com/docs/en/env-vars.md
export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AUDIT_DIR="${SCRIPT_DIR}/audit"
# shellcheck source=./agent-env.sh
. "${SCRIPT_DIR}/agent-env.sh"
# shellcheck source=./agent-pass.sh
. "${SCRIPT_DIR}/agent-pass.sh"

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

# Reasoning effort for the one `claude -p` pass, pinned rather than left to the CLI default so a
# shifting default never silently changes how deeply the auditor hunts (the same reason the model
# is pinned). AUDIT_CLAUDE_EFFORT in the box env overrides it; a value the CLI would not accept
# falls back to `high` rather than failing the night.
AUDIT_CLAUDE_EFFORT="${AUDIT_CLAUDE_EFFORT:-high}"
case "${AUDIT_CLAUDE_EFFORT}" in
  low | medium | high | xhigh | max) ;;
  *)
    log "AUDIT_CLAUDE_EFFORT='${AUDIT_CLAUDE_EFFORT}' is not low|medium|high|xhigh|max; using high"
    AUDIT_CLAUDE_EFFORT="high"
    ;;
esac

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
    echo "{\"ok\":false,\"stage\":\"domain\",\"domain\":\"${DOMAIN}\",\"error\":\"no prompt for domain\",\"checked\":0,\"errors\":1,\"produced\":0}"
    return 1
  fi
  log "domain=${DOMAIN} dry_run=${DRY_RUN}"

  # 2. Auth for git + gh (both off GH_TOKEN; no token written to disk).
  if [ -z "${FLUNCLE_AUDIT_GITHUB_PAT:-}" ]; then
    echo "{\"ok\":false,\"stage\":\"auth\",\"domain\":\"${DOMAIN}\",\"error\":\"no FLUNCLE_AUDIT_GITHUB_PAT\",\"checked\":0,\"errors\":1,\"produced\":0}"
    return 1
  fi
  export GH_TOKEN="${FLUNCLE_AUDIT_GITHUB_PAT}"

  # 3. Freshen an ISOLATED checkout to origin/main (not /opt/fluncle-build, not the baked scripts).
  if [ ! -d "${ws}/.git" ]; then
    log "cloning ${repo} → ${ws}"
    mkdir -p "$(dirname -- "${ws}")"
    git clone --quiet "https://github.com/${repo}.git" "${ws}" || {
      echo "{\"ok\":false,\"stage\":\"clone\",\"domain\":\"${DOMAIN}\",\"checked\":0,\"errors\":1,\"produced\":0}"; return 1; }
  fi
  cd "${ws}" || { echo "{\"ok\":false,\"stage\":\"cd\",\"domain\":\"${DOMAIN}\",\"checked\":0,\"errors\":1,\"produced\":0}"; return 1; }

  # Bot identity + creds, scoped to this workspace. It has no 1Password signing key, so commits
  # are unsigned (a machine identity); scoped to this throwaway checkout, never global.
  git config user.name "fluncle-audit-bot"
  git config user.email "hey@mauricekleine.com"
  git config commit.gpgsign false
  git config credential.https://github.com.helper "!gh auth git-credential"
  # `bun install` marks the CLI `bin` entry (apps/cli/src/cli.ts) executable every run; without
  # this, that stray 100644→100755 mode flip lands in `git add -A` and pollutes every audit PR.
  git config core.fileMode false

  git fetch --quiet origin main || { echo "{\"ok\":false,\"stage\":\"fetch\",\"domain\":\"${DOMAIN}\",\"checked\":0,\"errors\":1,\"produced\":0}"; return 1; }
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
    runtime_note="RUNTIME: this is a DRY RUN. Do the full audit, make your edits, append filed findings to docs/audit-backlog.md, and write .audit/report.md. Nothing will be committed or pushed; the driver leaves the branch uncommitted for inspection."
  else
    runtime_note="RUNTIME: this is a LIVE run on branch ${branch}. Follow the 'Ship it' steps: write .audit/report.md and leave your edits in the working tree. The driver commits, pushes, and opens the PR after you finish."
  fi
  local prompt
  prompt="$(cat "${AUDIT_DIR}/prompts/_preamble.md")

# Tonight: ${DOMAIN} — $(date -u +%Y-%m-%d)

${runtime_note}

$(cat "${prompt_file}")"

  # 8. The one bounded judgment call. Its chatter → stderr/journald; only our summary hits stdout.
  export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/opt/claude}"

  # Mark this fixed workspace path trusted so the repo's own .claude/settings.json — including the
  # guard-protected-files hook (the mechanical backstop behind the prompt's hard rails) — actually
  # loads; Claude Code silently ignores settings.json in an untrusted dir. Idempotent + re-applied
  # every run, so it survives an image rebuild/swap (CLAUDE_CONFIG_DIR is baked). Best-effort: on
  # any failure the run still has the prompt rails + PAT scope + review gate, so never abort on it.
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

  # Strip the box credential set from the child (see ./agent-env.sh). This sweep's input is the repo
  # rather than attacker-written text, so the exposure is smaller than sentry-triage's — but the
  # `surfaces-seo` night feeds it Google Search Console QUERY strings, which are typed by strangers,
  # and the scrub costs nothing on the other six nights. GOOGLE_APPLICATION_CREDENTIALS is named
  # explicitly because line 44 exports it independently of the secrets file.
  # Declares GH_TOKEN (it opens the nightly PR) and nothing else. Note this makes the db-query-shape
  # prompt's own claim true — it tells the auditor "Turso Cloud credentials are not on this box"
  # while the shared file carries the read-only pair for backup-sweep. If a future night genuinely
  # needs a hosted scratch DB, add `--allow` HERE; because the allowlist is per-caller, doing so
  # does not hand the same credential to sentry-triage.
  agent_env_scrub_args --secrets "${SECRETS_FILE}" --allow GH_TOKEN \
    --scrub GOOGLE_APPLICATION_CREDENTIALS
  log "invoking claude -p (opus, effort ${AUDIT_CLAUDE_EFFORT}) for ${DOMAIN} (budget ${AGENT_PASS_BUDGET_SECS}s)…"
  local run_errors=0 pass_reason=""
  # Bounded by the SCRIPT, not by the unit: a `TimeoutStartSec` kill only reaches the host-side
  # `docker exec` client, so the pass would otherwise run on unsupervised and self-report a
  # healthy night. See ./agent-pass.sh for the full reasoning and the ordering invariant.
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

  # What the agent actually verified. verify.sh writes this; its ABSENCE on a night that produced
  # work is itself a failure — an unverified branch is exactly what the ledger must not read as a
  # healthy night. A clean night legitimately runs no checks, so the absence only counts once we
  # know there is work (below).
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

  # 9. Measure the night's work, then report (and, on a LIVE night, ship) it.
  local changed ahead
  changed="$(git status --porcelain | wc -l | tr -d ' ')"
  ahead="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"

  # A night that produced work but left no verify record shipped a branch nobody checked. On a
  # clean night there is nothing to verify, so the absence only counts once work exists.
  if [ "${verify_present}" = "0" ] && { [ "${ahead}" != "0" ] || [ "${changed:-0}" != "0" ]; }; then
    log "no .audit/verify.json — the night's work was never verified"
    run_errors=$((run_errors + 1))
    [ -n "${pass_reason}" ] || pass_reason="unverified"
  fi

  # `ok` is DERIVED from this run's own error count, never asserted. The run ledger decides a
  # run's verdict server-side as `exit_code === 0 && (summary.errors ?? 0) === 0` (see
  # ./cron-output.sh, THE BODY CARRIES FACTS ONLY), and every branch below except `ship-failed`
  # returns 0 — so the error count IS the verdict. A literal `ok:true` beside
  # `errors:${run_errors}` would print `{"ok":true,…,"errors":1}` on a night the agent failed, and
  # /status would read the literal and call the sweep healthy while its own counter said otherwise.
  local ok="true"
  [ "${run_errors}" = "0" ] || ok="false"

  # The facts every branch below carries: WHY it ended badly, how much of the box's memory cap the
  # night burned through, how long the agent had, and which checks actually ran. A summary that
  # only carried a counter could not tell an operator whether the night hit its budget, lost a
  # child to the cgroup, or simply shipped unverified.
  local facts
  facts="$(printf '"pass_seconds":%s,"container_oom_kills":%s' "${AGENT_PASS_SECONDS}" "${AGENT_PASS_OOM_KILLS}")"
  [ -z "${pass_reason}" ] || facts="${facts},$(printf '"reason":"%s"' "${pass_reason}")"
  [ -z "${verify_json}" ] || facts="${facts},$(printf '"verify":%s' "${verify_json}")"

  if [ "${DRY_RUN}" = "1" ]; then
    local dry_produced=0
    [ "${changed:-0}" = "0" ] || [ "${run_errors}" != "0" ] || dry_produced=1
    log "DRY RUN complete — ${changed} changed path(s) left in ${ws} for inspection"
    [ -r .audit/report.md ] && { log "── report ──"; cat .audit/report.md >&2; }
    echo "{\"ok\":${ok},\"domain\":\"${DOMAIN}\",\"action\":\"dry-run\",\"changed\":${changed:-0},${facts},\"checked\":1,\"errors\":${run_errors},\"produced\":${dry_produced}}"
    return 0
  fi

  # No work at all: a clean night (or a failed pass that touched nothing). Nothing to ship.
  if [ "${changed:-0}" = "0" ] && [ "${ahead}" = "0" ]; then
    echo "{\"ok\":${ok},\"domain\":\"${DOMAIN}\",\"action\":\"clean\",${facts},\"checked\":1,\"errors\":${run_errors},\"produced\":0}"
    return 0
  fi

  # A pass that did not choose its own ending (budget, OOM, nonzero exit) left work nobody can
  # vouch for as finished. The driver never ships it; the workspace keeps it for inspection until
  # the next night's reset.
  if [ -n "${AGENT_PASS_REASON}" ]; then
    log "not shipping: the pass ended on ${AGENT_PASS_REASON}; ${changed} changed path(s) left in ${ws} for inspection"
    echo "{\"ok\":false,\"domain\":\"${DOMAIN}\",\"action\":\"unshipped\",\"changed\":${changed:-0},${facts},\"checked\":1,\"errors\":${run_errors},\"produced\":0}"
    return 0
  fi

  # 10. Ship it. The agent's edits plus its ledger rows are the commit, `.audit/report.md` is the PR
  # body, and the branch name (`audit/<date>-<domain>`) is what the 05:00 reviewer selects on.
  local ship_error="" label pr_url=""
  label="$(audit_domain_label)"
  if [ ! -s .audit/report.md ]; then
    ship_error="work exists but the agent wrote no .audit/report.md"
  elif [ "${changed:-0}" != "0" ] && ! audit_commit; then
    ship_error="commit failed"
  elif ! git push --quiet -u origin HEAD >&2; then
    ship_error="push failed"
  else
    # A same-day re-run of the same domain pushes onto the branch of an already-open PR; reuse it.
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

# The PR title's human label for tonight's domain (rotation.ts DOMAIN_META), or the key itself when
# the label cannot be read.
audit_domain_label() {
  local label
  label="$("${BUN_BIN}" -e 'const m = await import(process.argv[1]); const l = m.DOMAIN_META?.[process.argv[2]]?.label; if (typeof l === "string") process.stdout.write(l);' \
    "${AUDIT_DIR}/rotation.ts" "${DOMAIN}" 2>/dev/null || true)"
  printf '%s' "${label:-${DOMAIN}}"
}

# Stage everything (the fixes AND the docs/audit-backlog.md rows; `.audit/` is gitignored) and
# commit it as `audit(<domain>): <the report's verdict line>`.
#
# `--no-verify` is deliberate. The repo's pre-commit hook ends in the quality preflight join, which
# runs the whole affected closure — the passes verify.sh documents as not fitting this box's memory
# cap — and could take longer than the driver's headroom under the unit timeout. The box's
# verification is verify.sh (recorded in .audit/verify.json); the PR's required checks and
# `deploy:gate` are the gate. The two hook steps that CHANGE the commit run here explicitly:
# lint-staged's staged-file `oxfmt --write` / `oxlint --fix`, then the skill-copy sync, so the
# commit carries the same formatting and regenerated copies a hooked commit would.
audit_commit() {
  local verdict
  git add -A || return 1
  if [ -x "node_modules/.bin/oxlint" ]; then
    log "formatting the staged files (lint-staged)…"
    if ! timeout 300 "${BUN_BIN}" x lint-staged >&2; then
      log "lint-staged failed; committing as-is — the PR's lint and format checks will flag it"
      git add -A || return 1
    fi
  fi
  if git diff --cached --name-only | grep -q '^packages/skills/'; then
    log "skill source staged — syncing the committed skill copies (bun run skills:install)…"
    if timeout 120 "${BUN_BIN}" run skills:install >&2; then
      git add .agents/skills .claude/skills skills-lock.json || return 1
    else
      log "skills:install failed; the PR's skills drift check will flag the stale copies"
    fi
  fi
  verdict="$(sed -n '/[^[:space:]]/{s/^[#[:space:]]*//;p;q;}' .audit/report.md | cut -c1-72)"
  git commit --quiet --no-verify -m "audit(${DOMAIN}): ${verdict:-nightly audit}" >&2
}

# Deliberately no queue_depth: one rotating domain is inspected per tick, and this driver does
# not enumerate a whole outstanding audit backlog from which a real remaining count could be made.

# Host timers bypass the gateway's stdout capture, so self-report the /status marker
# (cron-output.sh) — WRAP the payload so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output audit -- run_audit
