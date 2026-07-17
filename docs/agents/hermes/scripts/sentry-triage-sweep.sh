#!/usr/bin/env bash
# sentry-triage-sweep.sh — the nightly Sentry-triage driver (03:30 Amsterdam).
#
# A NEW rave-02 host-timer cron, deliberately OUTSIDE the audit rotation: it checks Sentry EVERY
# night (its own set time) and opens a fix PR for each issue that is a STRAIGHTFORWARD fix. Same
# hybrid shape as the audit sweep — the driver owns the MECHANICS (freshen an isolated checkout,
# pull the unresolved issues, set up git/gh creds, reconcile merged fixes, comment fresh PRs, write
# the /status marker) and exactly ONE `claude -p` call owns the JUDGMENT (locate each bug → fix the
# straightforward ones on their own branch + PR → file the rest to docs/sentry-backlog.md). Claude
# Code = SUBSCRIPTION auth via CLAUDE_CODE_OAUTH_TOKEN, zero OpenRouter tokens.
#
# The deterministic Sentry API work (fetch / resolve-on-merge / comment) lives in the bun sibling
# sentry-triage-sweep.ts, so the SENTRY token never enters the claude process. claude only gets the
# GitHub PAT (to open its PRs). Full doctrine: ../sentry-triage-timer/README.md + ./sentry-triage-prompt.md.
#
# THE LOOP IS STATELESS (GitHub is the store, see the .ts header): a FIX PR carries `Sentry-Issue:`
# lines → the next run's `reconcile` resolves those issues once the PR merges (we resolve only what
# actually landed, never a blanket sweep); the LEDGER PR carries `Sentry-Filed:` lines → never
# resolved. The fetch step excludes anything already covered by an open PR or the ledger, so no
# issue is double-triaged.
#
# USAGE
#   sentry-triage-sweep.sh            # live: reconcile, triage tonight's new issues, open PRs
#   sentry-triage-sweep.sh --dry-run  # fetch + triage + edit + report, but DO NOT commit/push/PR
#
# Auto-merge posture (opt-in, default OFF): set SENTRY_TRIAGE_AUTOMERGE=1 in the box env to have
# claude enable GitHub auto-merge on each fix PR (`gh pr merge --squash --auto`) so a green
# deploy:gate merges it hands-off — the audit's "merge on green" posture, without a second cron.
# Left unset, every fix lands as an OPEN, labelled PR for the operator to merge (the safe default:
# a merge to main is a production deploy).
set -uo pipefail

# The runner execs with a minimal PATH; prepend the known install dirs so bun/claude/gh/git resolve.
export PATH="/usr/local/bin:/root/.bun/bin:${PATH:-/usr/bin:/bin}"
export BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/sentry-triage-sweep.ts"
PROMPT_FILE="${SCRIPT_DIR}/sentry-triage-prompt.md"

# Provider creds arrive via the 0600 op-synced shared secrets file, exactly like the audit sweep.
# SENTRY_TRIAGE_TOKEN is the new key; FLUNCLE_AUDIT_GITHUB_PAT is REUSED (it is the box's PR-opening
# PAT — Contents + Pull requests write — already synced for the audit).
SECRETS_FILE="${SENTRY_TRIAGE_SECRETS_FILE:-${HOME:-/opt/data/home}/.fluncle-secrets.env}"
if [ -r "${SECRETS_FILE}" ]; then
  set -a
  # shellcheck source=/dev/null
  . "${SECRETS_FILE}"
  set +a
fi

log() { echo "[sentry-triage] $*" >&2; }

# ── args ────────────────────────────────────────────────────────────────────────────────────
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    *) log "unknown arg: $1" ;;
  esac
  shift
done

run_triage() {
  local repo="mauricekleine/fluncle"
  local ws="${SENTRY_TRIAGE_WORKSPACE:-${HOME:-/opt/data/home}/sentry-triage-workspace/fluncle}"

  # 1. Token gate — a not-yet-activated cron SKIPS cleanly (ok:true), never alarms. The token is
  # operator-gated: until it is in the box env, this cron is a healthy no-op on /status.
  if [ -z "${SENTRY_TRIAGE_TOKEN:-}" ]; then
    echo "{\"ok\":true,\"action\":\"skipped\",\"reason\":\"no SENTRY_TRIAGE_TOKEN (operator-gated; add to box env to activate)\"}"
    return 0
  fi
  if [ -z "${FLUNCLE_AUDIT_GITHUB_PAT:-}" ]; then
    echo "{\"ok\":true,\"action\":\"skipped\",\"reason\":\"no GitHub PAT (FLUNCLE_AUDIT_GITHUB_PAT) — cannot open PRs\"}"
    return 0
  fi
  export GH_TOKEN="${FLUNCLE_AUDIT_GITHUB_PAT}"

  # 2. Freshen an ISOLATED checkout to origin/main (its own workspace, never /opt/fluncle-build).
  if [ ! -d "${ws}/.git" ]; then
    log "cloning ${repo} → ${ws}"
    mkdir -p "$(dirname -- "${ws}")"
    git clone --quiet "https://github.com/${repo}.git" "${ws}" || {
      echo "{\"ok\":false,\"stage\":\"clone\"}"; return 1; }
  fi
  cd "${ws}" || { echo "{\"ok\":false,\"stage\":\"cd\"}"; return 1; }

  # Bot identity + creds, scoped to this workspace (no 1Password signing key → unsigned machine
  # commits, exactly like the audit bot). core.fileMode false keeps the CLI bin's mode flip out of PRs.
  git config user.name "fluncle-sentry-bot"
  git config user.email "hey@mauricekleine.com"
  git config commit.gpgsign false
  git config credential.https://github.com.helper "!gh auth git-credential"
  git config core.fileMode false

  git fetch --quiet origin main || { echo "{\"ok\":false,\"stage\":\"fetch\"}"; return 1; }
  git reset --hard --quiet origin/main
  git clean -fdq
  rm -rf .sentry && mkdir -p .sentry

  # 3. Deps (cached between runs; only re-resolves on a lockfile change).
  log "bun install…"
  "${BUN_BIN}" install --silent || log "bun install returned nonzero (continuing; checks may be partial)"

  # 4. RECONCILE — resolve the Sentry issues whose fix PR has since merged (idempotent; the ONLY
  # resolve path). Best-effort: a reconcile failure never blocks tonight's triage.
  local reconciled
  reconciled="$("${BUN_BIN}" "${HELPER}" reconcile 2>/dev/null || echo '{"ok":false,"resolved":0}')"
  log "reconcile: ${reconciled}"

  # 5. FETCH — tonight's NEW unresolved issues (deduped against open PRs + the ledger), enriched
  # with each issue's top in-app frames. Never crashes on a bad token — it writes an empty worklist.
  local ledger="${ws}/docs/sentry-backlog.md"
  "${BUN_BIN}" "${HELPER}" fetch "${ledger}" ".sentry/issues.json" >&2 \
    || log "fetch returned nonzero (continuing; worklist may be empty)"

  # Read the worklist count without jq (bun one-liner).
  local triaged
  triaged="$("${BUN_BIN}" -e 'const j=require("fs").existsSync(".sentry/issues.json")?JSON.parse(require("fs").readFileSync(".sentry/issues.json","utf8")):{};process.stdout.write(String((j.issues||[]).length))' 2>/dev/null || echo 0)"
  if [ "${triaged:-0}" = "0" ]; then
    echo "{\"ok\":true,\"action\":\"clean\",\"triaged\":0,\"reconcile\":${reconciled}}"
    return 0
  fi
  log "triaging ${triaged} new issue(s)"

  # 6. Assemble the prompt = the operating contract + tonight's worklist + a runtime directive.
  local date_tag automerge_note runtime_note
  date_tag="$(date -u +%Y%m%d)"
  if [ "${SENTRY_TRIAGE_AUTOMERGE:-}" = "1" ]; then
    automerge_note="After opening each fix PR, enable auto-merge best-effort: \`gh pr merge <n> --squash --auto\` (green deploy:gate then merges it hands-off). If the repo has auto-merge disabled the command errors — that is fine, leave the PR open and continue; NEVER fail the run over it."
  else
    automerge_note="Do NOT merge or enable auto-merge. Leave every fix PR OPEN and labelled for the operator (a merge to main is a production deploy)."
  fi
  if [ "${DRY_RUN}" = "1" ]; then
    runtime_note="RUNTIME: this is a DRY RUN. Locate each bug, make the straightforward fixes, append filed rows to docs/sentry-backlog.md, and write .sentry/report.md — but do NOT run git or gh; leave the branches uncommitted for inspection."
  else
    runtime_note="RUNTIME: this is a LIVE run. Tonight's branch date tag is ${date_tag}; name each fix branch \`sentry-triage/${date_tag}-<shortId>\` and (if anything is filed) the ledger branch \`sentry-triage/${date_tag}-ledger\`. Follow the 'Ship it' steps: one PR per fixed issue (each body carrying its \`Sentry-Issue: <id>\` line[s]), plus one ledger PR if you filed anything (its body carrying the \`Sentry-Filed: <id>\` lines). ${automerge_note}"
  fi
  local prompt worklist
  worklist="$(cat .sentry/issues.json)"
  prompt="$(cat "${PROMPT_FILE}")

# Tonight's worklist — $(date -u +%Y-%m-%d)

${runtime_note}

The NEW unresolved Sentry issues to triage (already deduped against open triage PRs + the ledger):

\`\`\`json
${worklist}
\`\`\`"

  export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/opt/claude}"

  # Mark this fixed workspace trusted so the repo's .claude/settings.json (the guard-protected-files
  # hook behind the prompt's hard rails) actually loads — Claude Code ignores an untrusted dir's
  # settings. Idempotent + best-effort; on any failure the prompt rails + PAT scope still gate.
  SENTRY_WS="${ws}" "${BUN_BIN}" -e '
    const fs = require("fs");
    const f = process.env.CLAUDE_CONFIG_DIR + "/.claude.json";
    const ws = process.env.SENTRY_WS;
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      (j.projects ??= {})[ws] ??= {};
      j.projects[ws].hasTrustDialogAccepted = true;
      fs.writeFileSync(f, JSON.stringify(j, null, 2));
      process.stderr.write("[sentry-triage] workspace marked trusted\n");
    } catch (e) { process.stderr.write("[sentry-triage] trust-mark skipped: " + e.message + "\n"); }
  ' || log "trust-mark step failed (continuing; prompt rails + PAT scope still gate)"

  log "invoking claude -p (opus) for ${triaged} issue(s)…"
  "$(command -v claude)" -p "${prompt}" \
    --model opus \
    --dangerously-skip-permissions \
    >&2 || log "claude -p returned nonzero"

  # 7. Report + the Sentry-side link-back.
  local opened
  opened="$(gh pr list --repo "${repo}" --state open --json headRefName --jq \
    "[.[] | select(.headRefName | startswith(\"sentry-triage/${date_tag}-\"))] | length" 2>/dev/null || echo 0)"

  if [ "${DRY_RUN}" = "1" ]; then
    log "DRY RUN complete — inspect ${ws} (branches uncommitted)"
    [ -r .sentry/report.md ] && { log "── report ──"; cat .sentry/report.md >&2; }
    echo "{\"ok\":true,\"action\":\"dry-run\",\"triaged\":${triaged}}"
    return 0
  fi

  # COMMENT — link each fresh fix PR back on its Sentry issue (best-effort, idempotent).
  local commented
  commented="$("${BUN_BIN}" "${HELPER}" comment "${date_tag}" 2>/dev/null || echo '{"commented":0}')"
  log "comment: ${commented}"

  echo "{\"ok\":true,\"action\":\"triaged\",\"triaged\":${triaged},\"prs\":${opened:-0},\"reconcile\":${reconciled},\"comment\":${commented}}"
  return 0
}

# Host timers bypass the gateway's stdout capture, so self-report the /status marker
# (cron-output.sh) — WRAP the payload so the marker is written even on a nonzero run.
# shellcheck source=./cron-output.sh
. "${SCRIPT_DIR}/cron-output.sh"
emit_cron_output sentry-triage -- run_triage
