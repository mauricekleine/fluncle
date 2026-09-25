#!/usr/bin/env bash

set -euo pipefail

MODE="${1:---check}"
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel)}"
DOCKERFILE="$REPO_ROOT/docs/agents/hermes/Dockerfile"
PKG_JSON="$REPO_ROOT/package.json"
TMP="${RUNNER_TEMP:-/tmp}"
PR_BODY="$TMP/pin-drift-pr-body.md"
ISSUE_BODY="$TMP/pin-drift-issue-body.md"

log() { printf '%s\n' "$*" >&2; }

ver_gt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }
major() { printf '%s' "${1#v}" | cut -d. -f1; }

bun_image_digest() {
	python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("digest") or "")
except Exception: print("")'
}

brake_signature() {
	if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | cut -c1-16
}

inplace() { SRCH="$2" REPL="$3" perl -i -pe 's/\Q$ENV{SRCH}\E/$ENV{REPL}/g' "$1"; }

CUR_FLUNCLE="$(sed -n 's#.*releases/download/v\([0-9][0-9.]*\)/fluncle-.*#\1#p' "$DOCKERFILE" | head -1)"
CUR_CLAUDE="$(sed -n 's#.*@anthropic-ai/claude-code@\([0-9][0-9.]*\).*#\1#p' "$DOCKERFILE" | head -1)"
CUR_BUN="$(sed -n 's#^FROM oven/bun:\([0-9][0-9.]*\)-debian@sha256:.*#\1#p' "$DOCKERFILE" | head -1)"
CUR_BUN_DIGEST="$(sed -n 's#^FROM oven/bun:[0-9][0-9.]*-debian@\(sha256:[0-9a-f]*\).*#\1#p' "$DOCKERFILE" | head -1)"
CUR_YTDLP="$(sed -n 's#.*yt-dlp/releases/download/\([0-9][0-9.]*\)/yt-dlp_linux.*#\1#p' "$DOCKERFILE" | head -1)"
[ -n "$CUR_FLUNCLE" ] && [ -n "$CUR_CLAUDE" ] && [ -n "$CUR_BUN" ] && [ -n "$CUR_BUN_DIGEST" ] && [ -n "$CUR_YTDLP" ] ||
	{
		log "FATAL: could not parse one of the Dockerfile pins (fluncle='$CUR_FLUNCLE' claude='$CUR_CLAUDE' bun='$CUR_BUN' bun-digest='$CUR_BUN_DIGEST' yt-dlp='$CUR_YTDLP')"
		exit 1
	}

LATEST_FLUNCLE="$(npm view fluncle version 2>/dev/null || true)"
LATEST_CLAUDE="$(npm view @anthropic-ai/claude-code version 2>/dev/null || true)"
LATEST_BUN="$(curl -fsSL https://api.github.com/repos/oven-sh/bun/releases/latest 2>/dev/null |
	python3 -c 'import sys,json; print(json.load(sys.stdin)["tag_name"].replace("bun-v","",1))' 2>/dev/null || true)"
LATEST_YTDLP="$(curl -fsSL https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest 2>/dev/null |
	python3 -c 'import sys,json; print(json.load(sys.stdin)["tag_name"])' 2>/dev/null || true)"

declare -a TABLE=("| pin | current | latest | verdict |" "| --- | --- | --- | --- |")
declare -a BRAKE_LINES=()
declare -a SHORT=()
APPLY_FLUNCLE=""
APPLY_CLAUDE=""
APPLY_BUN=""
APPLY_YTDLP=""

assess() {
	local name="$1" cur="$2" latest="$3" calendar="${4:-}" verdict
	if [ -z "$latest" ]; then
		verdict="unknown (fetch failed)"
	elif [ "$cur" = "$latest" ]; then
		verdict="current"
	elif ver_gt "$latest" "$cur"; then
		if [ -n "$calendar" ] || [ "$(major "$latest")" = "$(major "$cur")" ]; then
			verdict="SAFE → $latest"
			SHORT+=("${name} ${latest}")
			case "$name" in
			fluncle) APPLY_FLUNCLE="$latest" ;;
			claude-code) APPLY_CLAUDE="$latest" ;;
			bun) APPLY_BUN="$latest" ;;
			yt-dlp) APPLY_YTDLP="$latest" ;;
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
assess yt-dlp "$CUR_YTDLP" "$LATEST_YTDLP" calendar

if [ -n "$APPLY_BUN" ]; then
	APPLY_BUN_DIGEST="$(curl -fsSL "https://hub.docker.com/v2/repositories/oven/bun/tags/${APPLY_BUN}-debian" 2>/dev/null |
		bun_image_digest 2>/dev/null || true)"
	if [ -z "$APPLY_BUN_DIGEST" ]; then
		log "bun $APPLY_BUN is released but oven/bun:${APPLY_BUN}-debian is not on Docker Hub yet — next run"
		APPLY_BUN=""
		kept=()
		for entry in "${SHORT[@]}"; do [ "${entry%% *}" = "bun" ] || kept+=("$entry"); done
		SHORT=(${kept[@]+"${kept[@]}"})
		for i in "${!TABLE[@]}"; do
			case "${TABLE[$i]}" in "| bun |"*) TABLE[$i]="| bun | $CUR_BUN | $LATEST_BUN | newer, image not published yet |" ;; esac
		done
	fi
fi

log "Hermes supply-chain pin drift:"
printf '%s\n' "${TABLE[@]}" >&2

[ "$MODE" = "--apply" ] || exit 0

declare -a CHANGES=()
if [ -n "$APPLY_FLUNCLE" ]; then
	inplace "$DOCKERFILE" "releases/download/v$CUR_FLUNCLE/fluncle-" "releases/download/v$APPLY_FLUNCLE/fluncle-"
	CHANGES+=("\`fluncle\` \`$CUR_FLUNCLE\` → \`$APPLY_FLUNCLE\` (Dockerfile)")
fi
if [ -n "$APPLY_CLAUDE" ]; then
	inplace "$DOCKERFILE" "@anthropic-ai/claude-code@$CUR_CLAUDE" "@anthropic-ai/claude-code@$APPLY_CLAUDE"
	CHANGES+=("\`@anthropic-ai/claude-code\` \`$CUR_CLAUDE\` → \`$APPLY_CLAUDE\` (Dockerfile)")
fi
if [ -n "$APPLY_YTDLP" ]; then
	inplace "$DOCKERFILE" "yt-dlp/releases/download/$CUR_YTDLP/yt-dlp_linux" "yt-dlp/releases/download/$APPLY_YTDLP/yt-dlp_linux"
	CHANGES+=("\`yt-dlp\` \`$CUR_YTDLP\` → \`$APPLY_YTDLP\` (Dockerfile) — the fluncle-capture fetcher; a stale one fails every download while the tick still reads green")
fi
if [ -n "$APPLY_BUN" ]; then
	inplace "$DOCKERFILE" "oven/bun:$CUR_BUN-debian@$CUR_BUN_DIGEST" "oven/bun:$APPLY_BUN-debian@$APPLY_BUN_DIGEST"
	inplace "$PKG_JSON" "bun@$CUR_BUN" "bun@$APPLY_BUN"
	CHANGES+=("\`bun\` \`$CUR_BUN\` → \`$APPLY_BUN\` (the Dockerfile base image + package.json packageManager; workflows follow via bun-version-file)")
fi

emit() { [ -n "${GITHUB_OUTPUT:-}" ] && printf '%s\n' "$1" >>"$GITHUB_OUTPUT" || true; }

if [ ${#CHANGES[@]} -gt 0 ]; then
	joined="$(printf '%s, ' "${SHORT[@]}")"
	joined="${joined%, }"
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
	} >"$PR_BODY"
	emit "bumped=true"
	emit "pr_title=$title"
	log "APPLIED: $title"
else
	emit "bumped=false"
	log "no safe bumps to apply"
fi

if [ ${#BRAKE_LINES[@]} -gt 0 ]; then
	BRAKE_SIGNATURE="$(printf '%s\n' "${BRAKE_LINES[@]}" | brake_signature)"
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
		echo

		echo "<!-- brake-signature: $BRAKE_SIGNATURE -->"
	} >"$ISSUE_BODY"
	emit "braked=true"
	emit "brake_signature=$BRAKE_SIGNATURE"
	log "REPORTED: ${#BRAKE_LINES[@]} brake item(s)"
else
	emit "braked=false"
fi
