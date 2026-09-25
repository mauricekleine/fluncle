#!/usr/bin/env bash

set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "${ROOT}" || exit 1
OUT="${AUDIT_VERIFY_OUTPUT:-${ROOT}/.audit/verify.json}"

AUDIT_VERIFY_CI_ONLY_PACKAGES="${AUDIT_VERIFY_CI_ONLY_PACKAGES:-apps/web}"

AUDIT_VERIFY_STEP_BUDGET_SECS="${AUDIT_VERIFY_STEP_BUDGET_SECS:-600}"

AUDIT_VERIFY_LINT_HEADROOM_MB="${AUDIT_VERIFY_LINT_HEADROOM_MB:-1792}"
AUDIT_VERIFY_TYPECHECK_HEADROOM_MB="${AUDIT_VERIFY_TYPECHECK_HEADROOM_MB:-1024}"
AUDIT_VERIFY_TEST_HEADROOM_MB="${AUDIT_VERIFY_TEST_HEADROOM_MB:-768}"

AUDIT_VERIFY_CGROUP_MAX="${AUDIT_VERIFY_CGROUP_MAX:-/sys/fs/cgroup/memory.max}"
AUDIT_VERIFY_CGROUP_CURRENT="${AUDIT_VERIFY_CGROUP_CURRENT:-/sys/fs/cgroup/memory.current}"

log() { echo "[audit-verify] $*" >&2; }

RAN=0
SKIPPED=0
FAILED=0
RECORDS=""

record() {
	local step="$1" state="$2" reason="$3"
	local entry
	entry="$(printf '{"step":"%s","state":"%s","reason":"%s"}' "${step}" "${state}" "${reason}")"
	if [ -z "${RECORDS}" ]; then RECORDS="${entry}"; else RECORDS="${RECORDS},${entry}"; fi
	case "${state}" in
	ran)
		RAN=$((RAN + 1))
		log "${step} → ok"
		;;
	skipped)
		SKIPPED=$((SKIPPED + 1))
		log "${step} → skipped (${reason})"
		;;
	failed)
		FAILED=$((FAILED + 1))
		log "${step} → FAILED (${reason})"
		;;
	esac
}

headroom_mb() {
	local max current
	[ -r "${AUDIT_VERIFY_CGROUP_MAX}" ] && [ -r "${AUDIT_VERIFY_CGROUP_CURRENT}" ] || return 0
	max="$(cat "${AUDIT_VERIFY_CGROUP_MAX}" 2>/dev/null)"
	current="$(cat "${AUDIT_VERIFY_CGROUP_CURRENT}" 2>/dev/null)"

	case "${max}" in '' | *[!0-9]*) return 0 ;; esac
	case "${current}" in '' | *[!0-9]*) return 0 ;; esac
	printf '%s' $(((max - current) / 1048576))
}

step() {
	local name="$1" need="$2"
	shift 2
	[ "${1:-}" = "--" ] && shift
	local free
	free="$(headroom_mb)"
	if [ -n "${free}" ] && [ "${free}" -lt "${need}" ]; then
		record "${name}" skipped "no-headroom"
		return 0
	fi
	local status=0
	timeout -k 30 "${AUDIT_VERIFY_STEP_BUDGET_SECS}" "$@" >&2 || status=$?
	if [ "${status}" = "0" ]; then
		record "${name}" ran ""
	elif [ "${status}" = "124" ] || [ "${status}" = "137" ]; then
		record "${name}" failed "budget-exceeded"
	else
		record "${name}" failed "exit-${status}"
	fi
}

is_ci_only() {
	local candidate="$1" entry
	for entry in ${AUDIT_VERIFY_CI_ONLY_PACKAGES}; do
		[ "${entry}" = "${candidate}" ] && return 0
	done
	return 1
}

has_script() {
	local dir="$1" script="$2"
	[ -r "${dir}/package.json" ] || return 1

	AUDIT_VERIFY_PKG="${dir}/package.json" AUDIT_VERIFY_SCRIPT="${script}" bun -e '
    const fs = require("node:fs");
    const pkg = JSON.parse(fs.readFileSync(process.env.AUDIT_VERIFY_PKG, "utf8"));
    process.exit(pkg.scripts?.[process.env.AUDIT_VERIFY_SCRIPT] ? 0 : 1);
  ' 2>/dev/null
}

CHANGED=()
while IFS= read -r changed_path; do
	[ -n "${changed_path}" ] && CHANGED+=("${changed_path}")
done < <(
	{

		git status --porcelain --untracked-files=all 2>/dev/null | sed 's/^...//'
		git diff --name-only origin/main...HEAD 2>/dev/null
	} | grep -v '^\.audit/' | sort -u
)

mkdir -p "$(dirname -- "${OUT}")" 2>/dev/null || true

if [ -z "${CHANGED[*]+set}" ]; then
	record "changes" skipped "no-changed-paths"
else
	log "${#CHANGED[@]} changed path(s)"

	if command -v bunx >/dev/null 2>&1; then
		BUNX=(bunx)
	else
		BUNX=(bun x)
	fi

	step format 256 -- "${BUNX[@]}" oxfmt --check "${CHANGED[@]}"

	BOX_OXLINTRC=".oxlintrc.box.jsonc"
	sed -E 's/("typeAware"[[:space:]]*:[[:space:]]*)true/\1false/' .oxlintrc.json >"${BOX_OXLINTRC}"
	if grep -q '"typeAware"[[:space:]]*:[[:space:]]*false' "${BOX_OXLINTRC}"; then
		step lint "${AUDIT_VERIFY_LINT_HEADROOM_MB}" -- "${BUNX[@]}" oxlint -c "${BOX_OXLINTRC}" "${CHANGED[@]}"
	else

		record "lint" failed "type-aware-override-missing"
	fi
	rm -f "${BOX_OXLINTRC}"

	PACKAGES=()
	while IFS= read -r package_dir; do
		[ -n "${package_dir}" ] && PACKAGES+=("${package_dir}")
	done < <(
		printf '%s\n' "${CHANGED[@]}" |
			sed -n 's|^\(apps/[^/]*\)/.*|\1|p;s|^\(packages/[^/]*\)/.*|\1|p' | sort -u
	)
	for package in ${PACKAGES[@]+"${PACKAGES[@]}"}; do
		[ -r "${package}/package.json" ] || continue
		if is_ci_only "${package}"; then
			record "typecheck:${package}" skipped "ci-only"
			record "test:${package}" skipped "ci-only"
			continue
		fi
		if has_script "${package}" typecheck; then
			step "typecheck:${package}" "${AUDIT_VERIFY_TYPECHECK_HEADROOM_MB}" -- bun run --cwd "${package}" typecheck
		else
			record "typecheck:${package}" skipped "no-script"
		fi
		if has_script "${package}" test; then
			step "test:${package}" "${AUDIT_VERIFY_TEST_HEADROOM_MB}" -- bun run --cwd "${package}" test
		else
			record "test:${package}" skipped "no-script"
		fi
	done
fi

printf '{"ran":%s,"skipped":%s,"failed":%s,"steps":[%s]}\n' "${RAN}" "${SKIPPED}" "${FAILED}" "${RECORDS}" >"${OUT}"
cat "${OUT}"
[ "${FAILED}" = "0" ]
