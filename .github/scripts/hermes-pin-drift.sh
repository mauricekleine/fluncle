#!/usr/bin/env bash
# hermes-pin-drift.sh — the deterministic half of fluncle-maintenance, run in CI.
#
# Checks the baked Hermes supply-chain pins against their registries and acts on
# the SHIP-vs-BRAKE doctrine (packages/skills/fluncle-maintenance) in plain code:
#   • SAFE drift  — a patch/minor bump, SAME major — of the `fluncle` CLI, the
#     Claude Code CLI, or bun → edits the pin in place so the workflow can open a
#     PR. bun moves in all THREE places at once: the Dockerfile installer line,
#     package.json `packageManager`, and both CI workflows' `bun-version`.
#   • RISKY drift — a MAJOR bump (any of the three), or a newer Nous Research
#     Hermes BASE image tag — is recorded for a report-only issue, never edited.
#     A major could rename/remove a command a cron calls; the base image's failure
#     mode is the whole gateway. Those stay the operator's call.
#
# Deliberately NOT here: box.ascii (unpinnable, self-updating) and the GitHub
# Actions digests (Renovate's job — see renovate.json). See the skill's
# references/version-inventory.md for the full six-item inventory.
#
# Modes:
#   --check  (default)  read + classify + print the drift table. No edits.
#   --apply             additionally edit the SAFE pins in place, and — when run
#                       in CI ($GITHUB_OUTPUT set) — emit step outputs plus the PR
#                       and issue body files the workflow consumes.
#
# Read-only network: `npm view` + the bun and Docker Hub public APIs. No creds.
set -euo pipefail

MODE="${1:---check}"
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel)}"
DOCKERFILE="$REPO_ROOT/docs/agents/hermes/Dockerfile"
PKG_JSON="$REPO_ROOT/package.json"
WF_QUALITY="$REPO_ROOT/.github/workflows/quality-checks.yml"
WF_RELEASE="$REPO_ROOT/.github/workflows/cli-release.yml"
TMP="${RUNNER_TEMP:-/tmp}"
PR_BODY="$TMP/pin-drift-pr-body.md"
ISSUE_BODY="$TMP/pin-drift-issue-body.md"

log() { printf '%s\n' "$*" >&2; }

# ── semver helpers ────────────────────────────────────────────────────────────
# ver_gt A B → true when A is strictly newer than B (version-aware; handles the
# base image's calendar versions too, e.g. v2026.6.19 < v2026.12.1).
ver_gt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }
major()  { printf '%s' "${1#v}" | cut -d. -f1; }

# in-place literal replace, portable across macOS/Linux (perl \Q…\E quotes meta).
inplace() { SRCH="$2" REPL="$3" perl -i -pe 's/\Q$ENV{SRCH}\E/$ENV{REPL}/g' "$1"; }

# ── read the current pins (markers, not line numbers) ─────────────────────────
CUR_FLUNCLE="$(sed -n 's#.*releases/download/v\([0-9][0-9.]*\)/fluncle-.*#\1#p' "$DOCKERFILE" | head -1)"
CUR_CLAUDE="$(sed -n 's#.*@anthropic-ai/claude-code@\([0-9][0-9.]*\).*#\1#p' "$DOCKERFILE" | head -1)"
CUR_BUN="$(sed -n 's/.*bun-v\([0-9][0-9.]*\).*/\1/p' "$DOCKERFILE" | head -1)"
CUR_BASE="$(sed -n 's#^FROM nousresearch/hermes-agent:\(.*\)#\1#p' "$DOCKERFILE" | head -1)"
[ -n "$CUR_FLUNCLE" ] && [ -n "$CUR_CLAUDE" ] && [ -n "$CUR_BUN" ] && [ -n "$CUR_BASE" ] \
  || { log "FATAL: could not parse one of the Dockerfile pins (fluncle='$CUR_FLUNCLE' claude='$CUR_CLAUDE' bun='$CUR_BUN' base='$CUR_BASE')"; exit 1; }

# ── check latest (read-only; a fetch failure degrades to 'unknown', never fatal) ─
LATEST_FLUNCLE="$(npm view fluncle version 2>/dev/null || true)"
LATEST_CLAUDE="$(npm view @anthropic-ai/claude-code version 2>/dev/null || true)"
LATEST_BUN="$(curl -fsSL https://api.github.com/repos/oven-sh/bun/releases/latest 2>/dev/null \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["tag_name"].replace("bun-v","",1))' 2>/dev/null || true)"
LATEST_BASE="$(curl -fsSL "https://hub.docker.com/v2/repositories/nousresearch/hermes-agent/tags?page_size=50&ordering=last_updated" 2>/dev/null \
  | python3 -c 'import sys,json,re
tags=[t["name"] for t in json.load(sys.stdin)["results"] if t["name"].startswith("v")]
print(max(tags,key=lambda v:[int(x) for x in re.findall(r"\d+",v)]) if tags else "")' 2>/dev/null || true)"

# ── classify ──────────────────────────────────────────────────────────────────
declare -a TABLE=("| pin | current | latest | verdict |" "| --- | --- | --- | --- |")
declare -a BRAKE_LINES=()
declare -a SHORT=()
APPLY_FLUNCLE=""; APPLY_CLAUDE=""; APPLY_BUN=""

assess() { # name current latest  → row + (sets APPLY_* / BRAKE_LINES)
  local name="$1" cur="$2" latest="$3" verdict
  if [ -z "$latest" ]; then
    verdict="unknown (fetch failed)"
  elif [ "$cur" = "$latest" ]; then
    verdict="current"
  elif ver_gt "$latest" "$cur"; then
    if [ "$(major "$latest")" = "$(major "$cur")" ]; then
      verdict="SAFE → $latest"
      SHORT+=("${name} ${latest}")
      case "$name" in
        fluncle) APPLY_FLUNCLE="$latest" ;;
        claude-code) APPLY_CLAUDE="$latest" ;;
        bun) APPLY_BUN="$latest" ;;
      esac
    else
      verdict="MAJOR → $latest (report)"
      BRAKE_LINES+=("- **$name** \`$cur\` → \`$latest\` — major bump. A renamed/removed command could break a cron; an operator reviews this one.")
    fi
  else
    verdict="ahead of latest ($latest)"
  fi
  TABLE+=("| $name | $cur | ${latest:-?} | $verdict |")
}

assess fluncle "$CUR_FLUNCLE" "$LATEST_FLUNCLE"
assess claude-code "$CUR_CLAUDE" "$LATEST_CLAUDE"
assess bun "$CUR_BUN" "$LATEST_BUN"

# base image — always report-only (pre-1.0; failure mode is the whole gateway)
BASE_VERDICT="current"
if [ -n "$LATEST_BASE" ] && ver_gt "${LATEST_BASE#v}" "${CUR_BASE#v}"; then
  BASE_VERDICT="NEWER → $LATEST_BASE (report)"
  BRAKE_LINES+=("- **Nous Hermes base image** \`$CUR_BASE\` → \`$LATEST_BASE\` — always operator-reviewed (pre-1.0; a base bump can change the runtime or drop the gateway below the model-context floor). Take it deliberately for upstream security patches.")
elif [ -z "$LATEST_BASE" ]; then
  BASE_VERDICT="unknown (fetch failed)"
fi
TABLE+=("| base image | $CUR_BASE | ${LATEST_BASE:-?} | $BASE_VERDICT |")

# ── report (always) ───────────────────────────────────────────────────────────
log "Hermes supply-chain pin drift:"
printf '%s\n' "${TABLE[@]}" >&2

[ "$MODE" = "--apply" ] || exit 0

# ── apply the safe bumps ──────────────────────────────────────────────────────
declare -a CHANGES=()
if [ -n "$APPLY_FLUNCLE" ]; then
  inplace "$DOCKERFILE" "releases/download/v$CUR_FLUNCLE/fluncle-" "releases/download/v$APPLY_FLUNCLE/fluncle-"
  CHANGES+=("\`fluncle\` \`$CUR_FLUNCLE\` → \`$APPLY_FLUNCLE\` (Dockerfile)")
fi
if [ -n "$APPLY_CLAUDE" ]; then
  inplace "$DOCKERFILE" "@anthropic-ai/claude-code@$CUR_CLAUDE" "@anthropic-ai/claude-code@$APPLY_CLAUDE"
  CHANGES+=("\`@anthropic-ai/claude-code\` \`$CUR_CLAUDE\` → \`$APPLY_CLAUDE\` (Dockerfile)")
fi
if [ -n "$APPLY_BUN" ]; then
  inplace "$DOCKERFILE"  "bun-v$CUR_BUN"          "bun-v$APPLY_BUN"          # installer line
  inplace "$DOCKERFILE"  "bun@$CUR_BUN"           "bun@$APPLY_BUN"           # the comment reference
  inplace "$PKG_JSON"    "bun@$CUR_BUN"           "bun@$APPLY_BUN"           # packageManager
  inplace "$WF_QUALITY"  "bun-version: $CUR_BUN"  "bun-version: $APPLY_BUN"  # CI
  inplace "$WF_RELEASE"  "bun-version: $CUR_BUN"  "bun-version: $APPLY_BUN"  # CI
  CHANGES+=("\`bun\` \`$CUR_BUN\` → \`$APPLY_BUN\` (Dockerfile + package.json + both workflows, kept in sync)")
fi

# ── write the PR body + emit outputs ──────────────────────────────────────────
emit() { [ -n "${GITHUB_OUTPUT:-}" ] && printf '%s\n' "$1" >> "$GITHUB_OUTPUT" || true; }

if [ ${#CHANGES[@]} -gt 0 ]; then
  joined="$(printf '%s, ' "${SHORT[@]}")"; joined="${joined%, }"
  title="chore(deps): bump baked Hermes pins ($joined)"
  {
    echo "## Baked Hermes supply-chain pin bump"
    echo
    echo "Automated by \`.github/workflows/hermes-pin-drift.yml\` — the deterministic half of the \`fluncle-maintenance\` doctrine. Safe (same-major) bumps only:"
    echo
    printf '%s\n' "${CHANGES[@]/#/- }"
    echo
    echo "On merge, the rave-02 \`fluncle-pin-watch\` timer rebuilds the Hermes image, pre-smokes it (versions + an agent \`{ok:true}\` read + a publish-class 403), swaps the container, and auto-rolls-back on any failure — within the hour. The repo-side bun change ships on the merge via CI."
    if [ ${#BRAKE_LINES[@]} -gt 0 ]; then
      echo
      echo "> Risky drift was also found and left for an operator (see the open maintenance issue): not in this PR."
    fi
  } > "$PR_BODY"
  emit "bumped=true"
  emit "pr_title=$title"
  log "APPLIED: $title"
else
  emit "bumped=false"
  log "no safe bumps to apply"
fi

# ── write the report issue body for risky drift ───────────────────────────────
if [ ${#BRAKE_LINES[@]} -gt 0 ]; then
  {
    echo "## Hermes supply-chain — drift that needs an operator decision"
    echo
    echo "The deterministic sweep (\`hermes-pin-drift.yml\`) ships clearly-safe minors on its own, but these are **brakes** — it never bumps them. Decide and ship via the \`fluncle-maintenance\` skill's \`references/bump-procedure.md\`."
    echo
    printf '%s\n' "${BRAKE_LINES[@]}"
    echo
    echo "<details><summary>full drift table at this run</summary>"
    echo
    printf '%s\n' "${TABLE[@]}"
    echo
    echo "</details>"
  } > "$ISSUE_BODY"
  emit "braked=true"
  log "REPORTED: ${#BRAKE_LINES[@]} brake item(s)"
else
  emit "braked=false"
fi
