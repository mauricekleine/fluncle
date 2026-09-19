#!/usr/bin/env bash
# verify.sh — the box-sized verification ladder for the nightly audit's own edits.
#
# Run it from the root of the audit workspace checkout, after the edits are made:
#     bash docs/agents/hermes/scripts/audit/verify.sh
# It prints a human line per step and writes the machine record to `.audit/verify.json`, which the
# driver folds into the sweep's summary line — so "which checks ran" is a fact in the run ledger
# rather than a claim in a report.
#
# WHY THIS EXISTS, AND WHY IT DELIBERATELY RUNS LESS THAN `bun run check`.
#
# The box's memory cap is shared by ~40 sweeps, a paid capture lane, and an embedding trickle that
# holds torch resident. The repo's whole-repo passes do not fit in what is left, and no knob makes
# them fit, because the peak is one TypeScript program graph rather than parallelism:
#
#   whole-repo type-aware lint   3.34 GB peak   (and 3.55 GB at `--threads=2` — capping the thread
#                                                pool does not lower it; tsgolint is a Go binary,
#                                                so a Node heap cap does not reach it either)
#   whole-repo typecheck         2.81 GB peak   (2.91 GB at `--concurrency=1` — serializing does
#                                                not lower it either; one package IS the peak)
#   apps/web typecheck alone     2.80 GB peak   ← that one package is the whole figure
#   apps/cli typecheck           0.36 GB peak
#   PATH-SCOPED type-aware lint  1.50 GB peak   ← fits, and is what this script runs
#
# So the whole-repo passes are not run here. They are not skipped work: every one of them runs on
# the PR this audit opens (the `quality-checks` action) and again in `deploy:gate` before anything
# reaches Cloudflare, and the reviewer merges on green required checks. Running them a third time
# on the smallest machine in the chain bought no gate and cost the night — measured as 116 of the
# container's 145 OOM kills over two weeks, all `tsgolint`, plus 12 `tsc`.
#
# What this ladder is for is the fast, local, path-scoped signal the agent needs to not push
# obvious breakage: formatting, the lint rules over the files it touched, and the changed
# package's own typecheck and tests when that package fits. Everything it cannot run, it RECORDS
# as skipped with a reason. A skip is an honest outcome to report, never something to work around.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "${ROOT}" || exit 1
OUT="${AUDIT_VERIFY_OUTPUT:-${ROOT}/.audit/verify.json}"

# Packages whose own whole-program pass does not fit the box (see the table above). Their
# typecheck and test are CI's, by measurement, not by preference.
AUDIT_VERIFY_CI_ONLY_PACKAGES="${AUDIT_VERIFY_CI_ONLY_PACKAGES:-apps/web}"
# Per-step wall budgets. A check that wedges must cost one step, never the night.
AUDIT_VERIFY_STEP_BUDGET_SECS="${AUDIT_VERIFY_STEP_BUDGET_SECS:-600}"
# Free memory a step must see before it is allowed to start, in MiB. Under this the step is
# SKIPPED rather than started into an OOM kill — a recorded skip beats a silent death.
AUDIT_VERIFY_LINT_HEADROOM_MB="${AUDIT_VERIFY_LINT_HEADROOM_MB:-1792}"
AUDIT_VERIFY_TYPECHECK_HEADROOM_MB="${AUDIT_VERIFY_TYPECHECK_HEADROOM_MB:-1024}"
AUDIT_VERIFY_TEST_HEADROOM_MB="${AUDIT_VERIFY_TEST_HEADROOM_MB:-768}"
# cgroup v2 memory accounting; overridable so the tests can drive fixture files.
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
    ran) RAN=$((RAN + 1)); log "${step} → ok" ;;
    skipped) SKIPPED=$((SKIPPED + 1)); log "${step} → skipped (${reason})" ;;
    failed) FAILED=$((FAILED + 1)); log "${step} → FAILED (${reason})" ;;
  esac
}

# Free MiB inside the cgroup, or empty when the accounting is unreadable (off-box, cgroup v1).
# Empty means "unknown", and an unknown headroom never blocks a step — this script must stay
# runnable on a workstation.
headroom_mb() {
  local max current
  [ -r "${AUDIT_VERIFY_CGROUP_MAX}" ] && [ -r "${AUDIT_VERIFY_CGROUP_CURRENT}" ] || return 0
  max="$(cat "${AUDIT_VERIFY_CGROUP_MAX}" 2>/dev/null)"
  current="$(cat "${AUDIT_VERIFY_CGROUP_CURRENT}" 2>/dev/null)"
  # "max" means no cap on this cgroup.
  case "${max}" in '' | *[!0-9]*) return 0 ;; esac
  case "${current}" in '' | *[!0-9]*) return 0 ;; esac
  printf '%s' $(((max - current) / 1048576))
}

# step <name> <required MiB> -- <command…>
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
  AUDIT_VERIFY_PKG="${dir}/package.json" AUDIT_VERIFY_SCRIPT="${script}" node -e '
    const fs = require("node:fs");
    const pkg = JSON.parse(fs.readFileSync(process.env.AUDIT_VERIFY_PKG, "utf8"));
    process.exit(pkg.scripts?.[process.env.AUDIT_VERIFY_SCRIPT] ? 0 : 1);
  ' 2>/dev/null
}

# ── 1. What changed ────────────────────────────────────────────────────────────────────────────
# Both the working tree and anything already committed on this branch, so the ladder covers the
# whole night whether or not the agent has committed yet.
# `while read` rather than `mapfile`, so this stays runnable under the bash 3.2 a macOS checkout
# has as well as the box's bash 5.
CHANGED=()
while IFS= read -r changed_path; do
  [ -n "${changed_path}" ] && CHANGED+=("${changed_path}")
done < <(
  {
    # `--untracked-files=all`, because the default collapses a wholly-new directory to one `dir/`
    # entry — a night that added a file in a new folder would otherwise verify nothing it wrote.
    git status --porcelain --untracked-files=all 2>/dev/null | sed 's/^...//'
    git diff --name-only origin/main...HEAD 2>/dev/null
  } | grep -v '^\.audit/' | sort -u
)

mkdir -p "$(dirname -- "${OUT}")" 2>/dev/null || true

if [ -z "${CHANGED[*]+set}" ]; then
  record "changes" skipped "no-changed-paths"
else
  log "${#CHANGED[@]} changed path(s)"

  # ── 2. Formatting, then the lint rules, both scoped to the changed paths ─────────────────────
  # Path-scoped keeps the type-aware pass inside the box's headroom (1.50 GB measured against the
  # 3.34 GB whole-repo run) while still checking every line this night wrote.
  step format 256 -- bunx oxfmt --check "${CHANGED[@]}"
  step lint "${AUDIT_VERIFY_LINT_HEADROOM_MB}" -- bunx oxlint "${CHANGED[@]}"

  # ── 3. The changed packages' own typecheck + tests ───────────────────────────────────────────
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
